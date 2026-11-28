import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import {
  updateSandboxVersionPolicyViaHttp,
  type SandboxVersionPolicyFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";
import {
  hostPolicyWritable,
  useHostPolicyWriteRoute,
} from "@/hooks/auth/use-host-policy-write-route";
import {
  sandboxHostEntry,
  plainHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { createFakeSandboxBinding } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

interface TestAuth {
  readonly updateHostVersionPolicy: (
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ) => Promise<UpdateHostVersionPolicyFetchResult>;
  readonly updateSandboxVersionPolicy: (
    sandboxId: string,
    input: UpdateHostVersionPolicyInput,
  ) => Promise<SandboxVersionPolicyFetchResult>;
}

interface HookState {
  entry: HostDirectoryEntry | null;
  sandboxList: SandboxListResponse | null;
  auth: TestAuth | null;
}

const hookState = vi.hoisted<HookState>(() => ({
  entry: null,
  sandboxList: null,
  auth: null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hookState.entry,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: hookState.sandboxList }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    hookState.auth === null ? null : { auth: hookState.auth },
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

const HOST_ID = "sandbox-host";
const SANDBOX_ID = "sandbox-row";
const TEAM_ID = "team-a";

const SANDBOX_SUMMARY = sandboxSummaryFixture({
  id: SANDBOX_ID,
  hostId: HOST_ID,
  priceMcPerHour: null,
});

function hostItem(updatePolicy: "auto" | "manual"): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: "Sandbox",
    platform: "linux-x64",
    kind: "sandbox",
    publicKey: "public-key",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy,
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

function Row(props: { readonly item?: HostListItem }) {
  const mutation = useUpdateHostVersionPolicy(HOST_ID);
  const writable = hostPolicyWritable(useHostPolicyWriteRoute(HOST_ID));
  return (
    <HostAutoUpdateRow
      item={props.item ?? hostItem("auto")}
      mutation={mutation}
      writable={writable}
      className=""
    />
  );
}

function renderRow(item: HostListItem | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Row item={item} />
    </QueryClientProvider>,
  );
}

function answerPolicyWritesWith(status: number, body: object): void {
  const auth = hookState.auth;
  if (auth === null) throw new Error("test setup has no auth binding");
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const runnerHost = createFakeRunnerHost({
    updateSandboxVersionPolicy: (bearerToken, sandboxId, input) =>
      updateSandboxVersionPolicyViaHttp(
        "https://server.example.invalid",
        bearerToken,
        null,
        sandboxId,
        input,
      ),
  });
  hookState.auth = {
    ...auth,
    updateSandboxVersionPolicy: (sandboxId, input) =>
      runnerHost.updateSandboxVersionPolicy("test-bearer", sandboxId, input),
  };
}

beforeEach(async () => {
  const sandboxBinding = createFakeSandboxBinding();
  sandboxBinding.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: { sandboxes: [SANDBOX_SUMMARY] },
  });
  const sandboxList = await sandboxBinding.auth.listSandboxes();
  hookState.sandboxList =
    sandboxList.kind === "ok" ? sandboxList.response : null;
  hookState.entry = sandboxHostEntry(HOST_ID, { id: TEAM_ID, name: "Alpha" });

  const sandboxWrite = vi.fn<IRunnerHost["updateSandboxVersionPolicy"]>(() =>
    Promise.resolve({
      kind: "ok",
      result: {
        hostId: HOST_ID,
        updatePolicy: "manual",
        desiredVersion: null,
      },
    }),
  );
  const hostWrite = vi.fn<IRunnerHost["updateHostVersionPolicy"]>(() =>
    Promise.resolve({
      kind: "ok",
      result: {
        hostId: HOST_ID,
        updatePolicy: "manual",
        desiredVersion: null,
      },
    }),
  );
  const runnerHost = createFakeRunnerHost({
    updateSandboxVersionPolicy: sandboxWrite,
    updateHostVersionPolicy: hostWrite,
  });
  hookState.auth = {
    updateSandboxVersionPolicy: (sandboxId, input) =>
      runnerHost.updateSandboxVersionPolicy("test-bearer", sandboxId, input),
    updateHostVersionPolicy: (hostId, input) =>
      runnerHost.updateHostVersionPolicy("test-bearer", hostId, input),
  };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user" },
  });
});

afterEach(() => {
  cleanup();
  hookState.entry = null;
  hookState.sandboxList = null;
  hookState.auth = null;
  toastError.mockReset();
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("HostAutoUpdateRow sandbox routing", () => {
  it("writes a listed team sandbox by sandbox id through the sandbox-control method", async () => {
    const sandboxWrite = vi.fn<IRunnerHost["updateSandboxVersionPolicy"]>(() =>
      Promise.resolve({
        kind: "ok",
        result: {
          hostId: HOST_ID,
          updatePolicy: "manual",
          desiredVersion: null,
        },
      }),
    );
    const hostWrite = vi.fn<IRunnerHost["updateHostVersionPolicy"]>(() =>
      Promise.resolve({
        kind: "ok",
        result: {
          hostId: HOST_ID,
          updatePolicy: "manual",
          desiredVersion: null,
        },
      }),
    );
    const runnerHost = createFakeRunnerHost({
      updateSandboxVersionPolicy: sandboxWrite,
      updateHostVersionPolicy: hostWrite,
    });
    hookState.auth = {
      updateSandboxVersionPolicy: (sandboxId, input) =>
        runnerHost.updateSandboxVersionPolicy("test-bearer", sandboxId, input),
      updateHostVersionPolicy: (hostId, input) =>
        runnerHost.updateHostVersionPolicy("test-bearer", hostId, input),
    };
    renderRow(undefined);

    fireEvent.click(screen.getByRole("switch"));

    await vi.waitFor(() => expect(sandboxWrite).toHaveBeenCalledTimes(1));
    expect(sandboxWrite).toHaveBeenCalledWith("test-bearer", SANDBOX_ID, {
      updatePolicy: "manual",
      desiredVersion: undefined,
      force: undefined,
    });
    expect(hostWrite).not.toHaveBeenCalled();
  });

  it("keeps a listed team's stored value visible but disables switching when the sandbox is absent", () => {
    hookState.sandboxList = { sandboxes: [] };
    renderRow(undefined);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveProperty("disabled", true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it.each(["personal-sandbox", "computer"] as const)(
    "keeps %s on the host registry write",
    async (kind) => {
      hookState.entry =
        kind === "computer"
          ? plainHostEntry(HOST_ID)
          : sandboxHostEntry(HOST_ID, null);
      const hostWrite = vi.fn<IRunnerHost["updateHostVersionPolicy"]>(() =>
        Promise.resolve({
          kind: "ok",
          result: {
            hostId: HOST_ID,
            updatePolicy: "manual",
            desiredVersion: null,
          },
        }),
      );
      const sandboxWrite = vi.fn<IRunnerHost["updateSandboxVersionPolicy"]>();
      const runnerHost = createFakeRunnerHost({
        updateHostVersionPolicy: hostWrite,
        updateSandboxVersionPolicy: sandboxWrite,
      });
      hookState.auth = {
        updateHostVersionPolicy: (hostId, input) =>
          runnerHost.updateHostVersionPolicy("test-bearer", hostId, input),
        updateSandboxVersionPolicy: (sandboxId, input) =>
          runnerHost.updateSandboxVersionPolicy(
            "test-bearer",
            sandboxId,
            input,
          ),
      };
      renderRow(undefined);

      fireEvent.click(screen.getByRole("switch"));

      await vi.waitFor(() => expect(hostWrite).toHaveBeenCalledTimes(1));
      expect(hostWrite).toHaveBeenCalledWith("test-bearer", HOST_ID, {
        updatePolicy: "manual",
        desiredVersion: undefined,
        force: undefined,
      });
      expect(sandboxWrite).not.toHaveBeenCalled();
    },
  );

  it("shows the changed registry value after a refused write whose reply was lost", async () => {
    let reads = 0;
    const updatedRead: { resolve: ((item: HostListItem) => void) | null } = {
      resolve: null,
    };
    const refetchHostList = vi.fn(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve(hostItem("auto"));
      return new Promise<HostListItem>((resolve) => {
        updatedRead.resolve = resolve;
      });
    });
    const auth = hookState.auth;
    if (auth === null) throw new Error("test setup has no auth binding");
    const sandboxWrite = vi.fn<IRunnerHost["updateSandboxVersionPolicy"]>(() =>
      Promise.resolve({
        kind: "refused",
        status: 503,
        code: "update_policy_unavailable",
        reason: null,
        shortfallMc: null,
        creditSource: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: null,
      }),
    );
    const runnerHost = createFakeRunnerHost({
      updateSandboxVersionPolicy: sandboxWrite,
    });
    hookState.auth = {
      ...auth,
      updateSandboxVersionPolicy: (sandboxId, input) =>
        runnerHost.updateSandboxVersionPolicy("test-bearer", sandboxId, input),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    function RefetchingRow() {
      const authBinding = hookState.auth;
      if (authBinding === null)
        throw new Error("test setup has no auth binding");
      const query = useQuery(
        queryOptions({
          queryKey: authQueryKeys.registeredHosts(authBinding, "user-1"),
          queryFn: refetchHostList,
        }),
      );
      const mutation = useUpdateHostVersionPolicy(HOST_ID);
      const writable = hostPolicyWritable(useHostPolicyWriteRoute(HOST_ID));
      return query.data === undefined ? null : (
        <>
          <span data-testid="policy-mutation-pending">
            {String(mutation.isPending)}
          </span>
          <HostAutoUpdateRow
            item={query.data}
            mutation={mutation}
            writable={writable}
            className=""
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <RefetchingRow />
      </QueryClientProvider>,
    );

    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't update this host.",
        expect.objectContaining({
          description: "Couldn't confirm that change.",
        }),
      );
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("policy-mutation-pending").textContent).toBe(
        "false",
      );
    });
    expect(refetchHostList).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(sandboxWrite).toHaveBeenCalledWith(
      "test-bearer",
      SANDBOX_ID,
      expect.objectContaining({ updatePolicy: "manual" }),
    );
    const resolveRead = updatedRead.resolve;
    if (resolveRead === null) {
      throw new Error("updated registry read did not start");
    }
    act(() => {
      resolveRead(hostItem("manual"));
    });
    await vi.waitFor(() => {
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      );
    });
  });

  it("shows the unavailable-change copy from the parsed 503 policy refusal", async () => {
    answerPolicyWritesWith(503, { code: "update_policy_unavailable" });
    renderRow(undefined);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't update this host.",
        expect.objectContaining({
          description: "Couldn't confirm that change.",
        }),
      );
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("shows the refused-request copy from an older server's missing-route envelope", async () => {
    answerPolicyWritesWith(404, {
      statusCode: 404,
      error: "Not Found",
      code: "ROUTE_NOT_FOUND",
      requestId: "request-1",
    });
    renderRow(undefined);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't update this host.",
        expect.objectContaining({
          description: "Traycer refused that request.",
        }),
      );
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
