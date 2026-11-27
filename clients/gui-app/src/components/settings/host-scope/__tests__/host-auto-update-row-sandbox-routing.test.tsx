import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  SandboxListResponse,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { SandboxVersionPolicyFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";
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
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: vi.fn(),
}));

const HOST_ID = "sandbox-host";
const SANDBOX_ID = "sandbox-row";
const TEAM_ID = "team-a";

const SANDBOX_SUMMARY: SandboxSummary = {
  id: SANDBOX_ID,
  hostId: HOST_ID,
  kind: "agent",
  provider: "firecracker",
  region: "us-east",
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: 20480,
  displayName: "build-box",
  state: "awake",
  frozen: false,
  failureCode: null,
  idleMinutes: null,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
  createdAt: 1_791_000_000_000,
  lastTransitionAt: 1_791_000_010_000,
  lastActivityAt: null,
  destroyedAt: null,
  frozenAt: null,
  guestConfigured: null,
  guestConfigFailureReason: null,
  phase: null,
  routes: null,
  priceMcPerHour: null,
  environmentId: null,
  createdBy: null,
  wakePayer: null,
  keptBy: null,
  restingSince: null,
  destroyAfterRestingMinutes: null,
  destroyAt: null,
  createdByTaskId: null,
  createdByAgentName: null,
  createdByTaskTitle: null,
  keptAt: null,
  operation: null,
  regionLabel: null,
  withdrawalEndsAt: null,
};

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
  return (
    <HostAutoUpdateRow
      item={props.item ?? hostItem("auto")}
      mutation={mutation}
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
    updateSandboxVersionPolicy: (_sandboxId, input) =>
      runnerHost.updateSandboxVersionPolicy("test-bearer", SANDBOX_ID, input),
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
      updateSandboxVersionPolicy: (_id, input) =>
        runnerHost.updateSandboxVersionPolicy("test-bearer", SANDBOX_ID, input),
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
        updateSandboxVersionPolicy: (_id, input) =>
          runnerHost.updateSandboxVersionPolicy(
            "test-bearer",
            SANDBOX_ID,
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

  it("refetches the host list after a refused write and renders the stored switch value", async () => {
    const stored = hostItem("auto");
    const refetchHostList = vi.fn(() => Promise.resolve(stored));
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
      updateSandboxVersionPolicy: (_id, input) =>
        runnerHost.updateSandboxVersionPolicy("test-bearer", SANDBOX_ID, input),
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
      return query.data === undefined ? null : (
        <HostAutoUpdateRow item={query.data} mutation={mutation} className="" />
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

    await vi.waitFor(() => expect(refetchHostList).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
