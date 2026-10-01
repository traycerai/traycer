// The foreground-sentence ruling, applied to the Overview ▸ Updates version picker
// (`host-overview-version-picker.tsx`, rows in `host-version-rows.tsx`; props
// built in `host-overview-updates-state.ts`, passed at
// `host-overview-panel.tsx`). During a LOCAL foreground run, every row's
// Install / Install anyway should be disabled and the picker should show the
// same replacement line the home banner and the Overview's other update
// surfaces show instead of "Update now" - neither is wired in yet, so every
// row below is red at head.
//
// Harness mirrors `host-overview-foreground-run.test.tsx` (that file,
// read for the pattern, not imported/edited): boundary mocks, a fake
// `hostLifecycle`, `HostSettingsPanel` under `RunnerHostProvider`. This file
// additionally opens the Updates tab (`selectHostOverviewTab`) and builds an
// installable, not-yet-installed manifest row.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  HostLifecyclePending,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  LocalHostCapability,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import type { HostStatusStoreFormats } from "@traycer/protocol/host/status/index";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/index";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { HOST_FOREGROUND_UPDATE_READY } from "@/lib/host/host-lifecycle-copy";
import {
  buildOverviewHostFixture,
  selectHostOverviewTab,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

/**
 * The foreground-sentence ruling: the constant naming this line does not exist yet
 * (mirrors `HOST_FOREGROUND_UPDATE_READY` in `host-lifecycle-copy.ts`), so the
 * literal is asserted directly here too.
 */
const HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE =
  "Update ready. A host you started in a terminal is running; update it yourself.";

const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
}

function versionPickerLifecycleView(overrides: {
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly localHostCapability: LocalHostCapability;
  readonly pending: HostLifecyclePending;
}): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: overrides.localHostCapability,
      supervisor: overrides.admittedAs === null ? "not-running" : "enforcing",
      admittedAs: overrides.admittedAs,
    },
    pending: overrides.pending,
  };
}

function buildLifecycleHost(initial: HostLifecycleView): {
  readonly hostLifecycle: IHostLifecycleHost;
  readonly push: (view: HostLifecycleView) => void;
} {
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  return {
    hostLifecycle,
    push: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

function updatableManifestHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "host.update.check": () => ({
      outcome: "ok" as const,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.6.0"),
    }),
  };
}

function renderOverview(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly initialView: HostLifecycleView;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
}): {
  readonly fixture: OverviewHostFixture;
  readonly push: (view: HostLifecycleView) => void;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    hostVersion: "1.5.0",
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, OVERVIEW_METHODS);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const { hostLifecycle, push } = buildLifecycleHost(options.initialView);
  const runnerHost = createFakeRunnerHost({
    hostLifecycle,
    hostManagement: null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, push };
}

async function findInstallButton(version: string): Promise<HTMLButtonElement> {
  await selectHostOverviewTab("updates");
  return (await screen.findByRole("button", {
    name: `Install ${version}`,
  })) as HTMLButtonElement;
}

describe("host-overview-version-picker — Install disabled during a local foreground run", () => {
  it("[RED] managed + pending:'none': Install disabled, the foreground-update line present, aria-describedby wired, no dispatch", async () => {
    const installCalls: string[] = [];
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: versionPickerLifecycleView({
        admittedAs: "foreground",
        localHostCapability: "managed",
        pending: "none",
      }),
      overrideHandlers: {
        ...updatableManifestHandlers(),
        "host.update.install": (request) => {
          installCalls.push(request.version);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });

    const install = await findInstallButton("1.6.0");
    expect(install.disabled).toBe(true);

    const describedBy = install.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const line =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(line?.textContent).toBe(HOST_FOREGROUND_UPDATE_READY);

    fireEvent.click(install);
    expect(installCalls).toEqual([]);
  });

  it("[RED] localHostCapability:'none': disabled, the self-serve line, the foreground-update line absent, no dispatch", async () => {
    const installCalls: string[] = [];
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: versionPickerLifecycleView({
        admittedAs: "foreground",
        localHostCapability: "none",
        pending: "none",
      }),
      overrideHandlers: {
        ...updatableManifestHandlers(),
        "host.update.install": (request) => {
          installCalls.push(request.version);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });

    const install = await findInstallButton("1.6.0");
    expect(install.disabled).toBe(true);
    // Read through the button's own description: the answer card's Update
    // now slot says the same sentence, so a page-wide text query finds two.
    const describedBy = install.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const line =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(line?.textContent).toBe(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE);
    expect(screen.queryByText(HOST_FOREGROUND_UPDATE_READY)).toBeNull();

    fireEvent.click(install);
    expect(installCalls).toEqual([]);
  });

  it("[GREEN control] admittedAs:null: Install enabled and dispatches, no foreground line", async () => {
    const installCalls: string[] = [];
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: versionPickerLifecycleView({
        admittedAs: null,
        localHostCapability: "managed",
        pending: "none",
      }),
      overrideHandlers: {
        ...updatableManifestHandlers(),
        "host.update.install": (request) => {
          installCalls.push(request.version);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });

    const install = await findInstallButton("1.6.0");
    expect(install.disabled).toBe(false);
    expect(screen.queryByText(HOST_FOREGROUND_UPDATE_READY)).toBeNull();
    expect(
      screen.queryByText(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE),
    ).toBeNull();

    fireEvent.click(install);
    await waitFor(() => {
      expect(installCalls).toEqual(["1.6.0"]);
    });
  });

  it("[GREEN control] a remote host stays unaffected even though this machine is foreground", async () => {
    const installCalls: string[] = [];
    renderOverview({
      hostId: "host-remote",
      isLocalMachine: false,
      initialView: versionPickerLifecycleView({
        admittedAs: "foreground",
        localHostCapability: "managed",
        pending: "none",
      }),
      overrideHandlers: {
        ...updatableManifestHandlers(),
        "host.update.install": (request) => {
          installCalls.push(request.version);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });

    const install = await findInstallButton("1.6.0");
    expect(install.disabled).toBe(false);
    expect(screen.queryByText(HOST_FOREGROUND_UPDATE_READY)).toBeNull();
    expect(
      screen.queryByText(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Install-anyway confirm (a `storeFormatConfirmation` row)
// ---------------------------------------------------------------------------
//
// Reached the same way `host-overview-updates.test.tsx` reaches it: a
// same-format manifest entry (so the row starts as a plain Install, not yet
// "anyway"), a FIRST `host.update.install` that answers `cli-failed` /
// `store-format-floor` to populate the row's `storeFormatConfirmation`, then
// clicking "Install … anyway" to open `ConfirmDestructiveDialog`. Reachable,
// not skipped - it is exactly the established path other Overview suites use
// for this dialog, just driven through the full panel instead of the
// isolated hook.

const V3_HOST_ID = "host-local-v3";

function v3Manifest(): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-12T00:00:00Z",
    latest: "1.3.1",
    versions: [
      {
        version: "1.3.0",
        releasedAt: "2026-08-12T00:00:00Z",
        releaseNotesUrl: "https://example.invalid/notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        storeFormats: { chatDb: 9 },
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: "https://example.invalid/host.tar.gz",
            sizeBytes: 1024,
            sha256: "a".repeat(64),
            signatureUrl: "https://example.invalid/host.tar.gz.minisig",
            signatureAlgorithm: "minisign" as const,
            publicKeyId: "key-1",
          },
        },
      },
    ],
  };
}

function v3StoreFormats(): HostStatusStoreFormats {
  return {
    chatDb: { current: 9, onDiskMax: 9, epicCount: 1, survey: "complete" },
  };
}

/**
 * `host.update.install`'s store-format floor and the survey it reads are both
 * negotiated minors (`@1.3` and `@1.5` respectively) - `recordNegotiatedHostMethods`
 * alone leaves them unknown, which the picker treats as "cannot honour
 * consent" and withholds the row outright. Mirrors
 * `recordOverviewHostMethods` in `host-overview-updates.test.tsx`.
 */
function recordV3Minors(hostId: string): void {
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of OVERVIEW_METHODS) {
    let minor = 0;
    if (method === "host.update.install") minor = 3;
    if (method === "host.status") minor = 4;
    manifest[method] = { major: 1, minor };
  }
  recordNegotiatedHostManifest(hostId, manifest);
}

describe("host-overview-version-picker — the Install-anyway confirm during a local foreground run", () => {
  it("[RED] opened at admittedAs:null, then foreground pushed: Confirm disabled with the line as blockedReason, nothing dispatched", async () => {
    const installRequests: Array<{
      readonly version: string;
      readonly force: boolean;
      readonly acceptStoreFormatLoss: boolean;
    }> = [];
    let installCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: V3_HOST_ID,
      isLocalMachine: true,
      hostVersion: "1.3.1",
      storeFormats: v3StoreFormats(),
      overrideHandlers: {
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: v3Manifest(),
        }),
        "host.update.install": (request) => {
          installCalls += 1;
          installRequests.push(request);
          return installCalls === 1
            ? {
                outcome: "cli-failed" as const,
                reason: "store-format-floor" as const,
                storeFloor: {
                  kind: "indeterminate" as const,
                  reason: "target-format-unknown" as const,
                  targetVersion: "1.3.0",
                  targetChatDb: null,
                  onDiskMax: null,
                  epicCount: 1,
                  epicIds: ["epic-a"],
                  unreadableEpicCount: 0,
                  unreadableEpicIds: [],
                },
              }
            : { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    recordV3Minors(V3_HOST_ID);
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: V3_HOST_ID,
        isLocalMachine: true,
        connectable: true,
      }),
      hostId: V3_HOST_ID,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = bindingWith(fixture.client);

    const { hostLifecycle, push } = buildLifecycleHost(
      versionPickerLifecycleView({
        admittedAs: null,
        localHostCapability: "managed",
        pending: "none",
      }),
    );
    const runnerHost = createFakeRunnerHost({
      hostLifecycle,
      hostManagement: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await selectHostOverviewTab("updates");
    const rows = await screen.findByTestId("host-version-rows");
    const row = within(rows).getByRole("listitem");
    fireEvent.click(within(row).getByRole("button", { name: "Install 1.3.0" }));

    await waitFor(() => {
      expect(
        within(row).getByRole("button", { name: "Install 1.3.0 anyway" }),
      ).toHaveProperty("disabled", false);
    });
    fireEvent.click(
      within(row).getByRole("button", { name: "Install 1.3.0 anyway" }),
    );
    await screen.findByTestId("confirm-destructive-dialog");

    act(() => {
      push(
        versionPickerLifecycleView({
          admittedAs: "foreground",
          localHostCapability: "managed",
          pending: "none",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-action")).toHaveProperty(
        "disabled",
        true,
      );
    });
    expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
      HOST_FOREGROUND_UPDATE_READY,
    );

    fireEvent.click(screen.getByTestId("confirm-action"));
    // Only the earlier RPC refusal - no "anyway" dispatch went through.
    expect(installRequests).toHaveLength(1);
  });
});
