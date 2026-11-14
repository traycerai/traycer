vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

const remoteTransport = vi.hoisted(() => vi.fn());
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return { ...actual, createRemoteHostTransport: remoteTransport };
  },
);

const socketBuilds = vi.hoisted(() => ({ rpc: 0, stream: 0 }));
vi.mock(
  "@traycer-clients/shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-rpc-client")
      >();
    class CountingWsRpcClient {
      constructor() {
        socketBuilds.rpc += 1;
      }
    }
    return {
      ...actual,
      WsRpcClient: CountingWsRpcClient,
    };
  },
);
vi.mock(
  "@traycer-clients/shared/host-transport/ws-stream-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-stream-client")
      >();
    class CountingWsStreamClient {
      constructor() {
        socketBuilds.stream += 1;
      }
    }
    return {
      ...actual,
      WsStreamClient: CountingWsStreamClient,
    };
  },
);

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: () => 0,
}));

const authErrorToast = vi.hoisted(() => ({
  show: vi.fn<(error: unknown, fallback: string) => void>(),
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: authErrorToast.show,
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { IHostManagement } from "@traycer-clients/shared/platform/runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { WindowHostModal } from "@/components/layout/dialogs/window-host-modal";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { installAuthValidationFetch } from "../../../../__tests__/test-browser-apis";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { lastLocalHostIdKey } from "@/lib/persist";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { olderHostUpdateVariant } from "@/lib/host/window-narration";

/**
 * Real `useOlderHostUpdate` and real `useUpdateHostVersionPolicy`. The floor
 * this file installs is `"2.0.0"`. The action's detail carries a different
 * minimum so a passing assertion cannot be copied from the prop.
 */

const HOST_ID = "host-remote";
const TEST_FLOOR = "2.0.0";

const OLDER_HOST: SelectionIncompatibility = {
  code: "older-host",
  hostVersion: "1.5.4",
  minSupportedVersion: "9.9.9",
  clientCompatibility: null,
};

const AUTHN = "http://localhost:5005";
const FLOOR_PATCH_BODY = JSON.stringify({ desiredVersion: TEST_FLOOR });

type PatchAnswer = "ok" | "invalid" | "network-error" | "not-found";

const patchCalls: Array<{ readonly url: string; readonly body: string }> = [];
let patchAnswer: PatchAnswer = "ok";
let restoreFetch: (() => void) | null = null;

interface OpenedRuntime {
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
  readonly runtime: HostRuntime<HostRpcRegistry>;
}

const opened: OpenedRuntime[] = [];

function host154(updateState: "pending" | "current"): RemoteHostDirectoryEntry {
  const base = remoteEntry(HOST_ID, null);
  return {
    ...base,
    version: "1.5.4",
    remoteStatus: {
      ...base.remoteStatus,
      updateState,
      appVersion: "1.5.4",
    },
  };
}

function installPolicyFetch(): void {
  const restoreValidation = installAuthValidationFetch();
  const validationFetch = globalThis.fetch;
  const stub = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }
    if ((init?.method ?? "GET") === "PATCH" && url.includes("/api/v3/hosts/")) {
      const raw = init?.body;
      if (typeof raw !== "string") {
        return Promise.reject(new Error("PATCH body was not text"));
      }
      patchCalls.push({ url, body: raw });
      if (patchAnswer === "network-error") {
        return Promise.reject(new TypeError("offline"));
      }
      if (patchAnswer === "invalid") {
        return Promise.resolve(new Response(null, { status: 400 }));
      }
      if (patchAnswer === "not-found") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            host_id: HOST_ID,
            update_policy: "manual",
            desired_version: TEST_FLOOR,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    return validationFetch(input, init);
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: stub,
  });
  restoreFetch = restoreValidation;
}

function managementFor(
  applyStaged: IHostManagement["applyStaged"] | null,
): IHostManagement | null {
  if (applyStaged === null) {
    return null;
  }
  return buildOverviewManagement({
    applyStaged,
    convergeReady: () =>
      Promise.resolve({
        kind: "ok",
        value: { running: false, version: null },
      }),
  });
}

function renderUpdate(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  runnerHost: MockRunnerHost,
  narration: JSX.Element | undefined,
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeContext.Provider value={binding}>
          <HostUpdateRequiredAction
            hostId={HOST_ID}
            detail={OLDER_HOST}
            testId="host-scope-update-host"
          />
          <DirectoryAppVersion />
          {narration}
        </HostRuntimeContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function DirectoryAppVersion(): JSX.Element {
  const entry = useHostDirectoryEntry(HOST_ID);
  const appVersion =
    entry !== null && isRemoteHostDirectoryEntry(entry)
      ? (entry.remoteStatus.appVersion ?? "unknown")
      : "missing";
  return <span data-testid="directory-app-version">{appVersion}</span>;
}

interface SignedInHarness {
  readonly directory: HostDirectoryService;
  readonly rows: { current: readonly HostDirectoryEntry[] };
}

async function renderSignedIn(
  args: {
    readonly localHostId: string | null;
    readonly entry: HostDirectoryEntry | null;
    readonly applyStaged: IHostManagement["applyStaged"] | null;
  },
  narration: JSX.Element | undefined,
): Promise<SignedInHarness> {
  const rows: SignedInHarness["rows"] = {
    current: args.entry === null ? [] : [args.entry],
  };
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: AUTHN,
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: args.localHostId !== null,
    traycerCli: undefined,
    hostManagement: managementFor(args.applyStaged),
    lastKnownLocalHostId: args.localHostId,
  });
  const auth = new AuthService({ runnerHost });
  await runnerHost.tokenStore.signIn(
    { token: "user-token", refreshToken: "user-token-refresh" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  await auth.start();
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({
        kind: "hosts",
        entries: rows.current,
      }),
    localHostIdSeeder: () => Promise.resolve(args.localHostId),
    onRegistryPollTick: null,
  });
  await directory.start();
  await directory.refresh();
  let requestSeq = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `older-host-${++requestSeq}`,
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => null,
    connectionRegistry: null,
  });
  opened.push({ auth, directory, runtime });
  renderUpdate(
    {
      runtime,
      hostClient: runtime.hostClient,
      directory,
      auth,
      hostId: null,
    },
    runnerHost,
    narration,
  );
  return { directory, rows };
}

function hostNarration(isTargetHost: boolean): JSX.Element {
  return (
    <WindowHostModal
      cause="no-usable-host"
      variant={olderHostUpdateVariant(HOST_ID, isTargetHost, "1.5.4")}
      progress={null}
      bootBody={null}
      onRetry={null}
      retryPending={false}
      onOpenSettings={() => undefined}
      showReportIssue={false}
      settingsEmphasis="button"
      settingsOnly={false}
    />
  );
}

function updateButton(): HTMLButtonElement {
  const button = screen.getByTestId("host-scope-update-host");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("update control is not a button");
  }
  return button;
}

function expectFloorPatch(): void {
  expect(patchCalls).toEqual([
    {
      url: `${AUTHN}/api/v3/hosts/${HOST_ID}`,
      body: FLOOR_PATCH_BODY,
    },
  ]);
}

function expectNoDial(): void {
  expect(remoteTransport).not.toHaveBeenCalled();
  expect(socketBuilds).toEqual({ rpc: 0, stream: 0 });
}

beforeEach(() => {
  socketBuilds.rpc = 0;
  socketBuilds.stream = 0;
  remoteTransport.mockReset();
  patchCalls.length = 0;
  patchAnswer = "ok";
  authErrorToast.show.mockReset();
  installPolicyFetch();
});

afterEach(() => {
  cleanup();
  for (const item of opened.splice(0)) {
    item.runtime.dispose();
    item.directory.dispose();
    item.auth.dispose();
  }
  restoreFetch?.();
  restoreFetch = null;
  useAuthStore.getState().setSignedOut();
  useSettingsHostScopeStore.getState().reset();
  window.localStorage.removeItem(lastLocalHostIdKey());
});

describe("useOlderHostUpdate remote write", () => {
  it.each([
    [
      "matches the local host id even when it is not the target",
      HOST_ID,
      false,
      "Traycer Host is running a version this app can't talk to. Update the host to continue - your agents and history are untouched.",
    ],
    [
      "uses remote copy when the target flag is true but the id is remote",
      "host-local",
      true,
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    ],
  ] as const)(
    "modal copy: %s",
    async (_label, localHostId, isTargetHost, copy) => {
      await renderSignedIn(
        {
          localHostId,
          entry: null,
          applyStaged: null,
        },
        hostNarration(isTargetHost),
      );

      expect(
        screen.getByTestId("window-host-modal-description").textContent,
      ).toBe(copy);
    },
  );

  it("patches the test floor from a shell with no host management, and does not dial", async () => {
    await renderSignedIn(
      {
        localHostId: null,
        entry: null,
        applyStaged: null,
      },
      undefined,
    );

    updateButton().click();

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expectFloorPatch();
    expectNoDial();
  });

  it("patches the test floor on desktop when the host is not this machine", async () => {
    const applyCalls: Array<readonly [string, boolean]> = [];
    const applyStaged: IHostManagement["applyStaged"] = (trigger, force) => {
      applyCalls.push([trigger, force]);
      return Promise.resolve({
        kind: "ok",
        value: {
          appliedVersion: TEST_FLOOR,
          runningActivated: false,
          applied: false,
        },
      });
    };
    await renderSignedIn(
      {
        localHostId: "this-machine",
        entry: null,
        applyStaged,
      },
      undefined,
    );

    updateButton().click();

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expectFloorPatch();
    expect(applyCalls).toEqual([]);
    expectNoDial();
  });

  it("installs the local host with a manual apply and does not patch", async () => {
    const applyCalls: Array<readonly [string, boolean]> = [];
    const applyStaged: IHostManagement["applyStaged"] = (trigger, force) => {
      applyCalls.push([trigger, force]);
      return Promise.resolve({
        kind: "ok",
        value: {
          appliedVersion: TEST_FLOOR,
          runningActivated: true,
          applied: true,
        },
      });
    };
    await renderSignedIn(
      {
        localHostId: HOST_ID,
        entry: null,
        applyStaged,
      },
      undefined,
    );

    updateButton().click();

    await waitFor(() => {
      expect(applyCalls).toEqual([["manual", false]]);
    });
    expect(patchCalls).toEqual([]);
    expectNoDial();
  });

  it.each([
    ["invalid", "That update wasn't valid."],
    ["network-error", "Couldn't reach Traycer to update this host."],
    ["not-found", "This host is no longer available."],
  ] as const)(
    "reports the existing %s auth error without an inline remote failure or dial",
    async (kind, message) => {
      patchAnswer = kind;
      await renderSignedIn(
        {
          localHostId: null,
          entry: null,
          applyStaged: null,
        },
        undefined,
      );

      updateButton().click();

      await waitFor(() => {
        expect(authErrorToast.show).toHaveBeenCalledWith(
          expect.objectContaining({ message }),
          "Couldn't update this host.",
        );
      });
      expect(screen.queryByTestId("host-ensure-failure-message")).toBeNull();
      expectFloorPatch();
      expectNoDial();
    },
  );

  it("keeps a local apply failure inline", async () => {
    const applyStaged: IHostManagement["applyStaged"] = () =>
      Promise.resolve({
        kind: "failed",
        message: "Couldn't apply the staged host.",
        errorCode: null,
      });
    await renderSignedIn(
      {
        localHostId: HOST_ID,
        entry: null,
        applyStaged,
      },
      undefined,
    );

    updateButton().click();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-ensure-failure-message").textContent,
      ).toBe("Couldn't apply the staged host.");
    });
    expect(authErrorToast.show).not.toHaveBeenCalled();
    expect(patchCalls).toEqual([]);
    expectNoDial();
  });

  it("does not fabricate Update pending when the directory row is not pending", async () => {
    await renderSignedIn(
      {
        localHostId: null,
        entry: host154("current"),
        applyStaged: null,
      },
      undefined,
    );

    updateButton().click();

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expectFloorPatch();
    await waitFor(() => {
      expect(updateButton().disabled).toBe(false);
    });
    expect(screen.queryByText("Update pending")).toBeNull();
    expectNoDial();
  });

  it("replaces the action with pending status, then restores it when the directory clears pending", async () => {
    const harness = await renderSignedIn(
      {
        localHostId: null,
        entry: host154("pending"),
        applyStaged: null,
      },
      undefined,
    );

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
    expect(screen.getByText("Update pending")).toBeTruthy();
    expect(
      screen.getByText(
        "Applied on this host's next check-in — within ~10 minutes, and only when no sessions are running.",
      ),
    ).toBeTruthy();
    expect(patchCalls).toEqual([]);

    harness.rows.current = [host154("current")];
    await harness.directory.refresh();
    await waitFor(() => {
      expect(screen.queryByText("Update pending")).toBeNull();
      expect(screen.getByTestId("host-scope-update-host")).toBeTruthy();
    });
    expect(updateButton().disabled).toBe(false);
    updateButton().click();
    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expectFloorPatch();
    expectNoDial();
  });

  it("publishes an appVersion-only change through the directory subscriber", async () => {
    const harness = await renderSignedIn(
      {
        localHostId: null,
        entry: host154("current"),
        applyStaged: null,
      },
      undefined,
    );

    expect(screen.getByTestId("directory-app-version").textContent).toBe(
      "1.5.4",
    );
    const currentEntry = harness.rows.current[0];
    if (!isRemoteHostDirectoryEntry(currentEntry)) {
      throw new Error("expected the remote host directory entry");
    }
    const updatedEntry: RemoteHostDirectoryEntry = {
      ...currentEntry,
      remoteStatus: {
        ...currentEntry.remoteStatus,
        appVersion: "1.5.5",
      },
    };
    harness.rows.current = [updatedEntry];
    expect(updatedEntry.version).toBe("1.5.4");
    expect(updatedEntry.remoteStatus.updateState).toBe("current");

    await harness.directory.refresh();

    await waitFor(() => {
      expect(screen.getByTestId("directory-app-version").textContent).toBe(
        "1.5.5",
      );
    });
    expectNoDial();
  });

  it("reports missing runtime binding through the existing auth toast without inline failure or dial", async () => {
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: AUTHN,
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: false,
      traycerCli: undefined,
      hostManagement: null,
    });
    renderUpdate(null, runnerHost, undefined);

    updateButton().click();

    await waitFor(() => {
      expect(authErrorToast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Sign in to update this host." }),
        "Couldn't update this host.",
      );
    });
    expect(screen.queryByTestId("host-ensure-failure-message")).toBeNull();
    expect(patchCalls).toEqual([]);
    expectNoDial();
  });
});
