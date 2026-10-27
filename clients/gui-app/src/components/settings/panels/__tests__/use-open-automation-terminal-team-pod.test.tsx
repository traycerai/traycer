import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  SandboxAutomationOpenTarget,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxAutomationFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { AutomationTerminalPane } from "@/components/home/terminal-panel/automation-terminal-pane";
import { useOpenAutomationTerminal } from "@/components/settings/panels/use-open-automation-terminal";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSandboxTeamPods } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";

const TEAM = "env-team";
const POD_ONE_HOST = "host-pod-1";
const POD_TWO_HOST = "host-pod-2";
const METHODS = [
  "terminal.plain.list",
  "terminal.plain.create",
  "worktree.listBindingsForEpic",
];

const network = vi.hoisted(() => ({
  calls: [] as Array<{ readonly hostId: string; readonly method: string }>,
  readyHostIds: new Set<string>(),
  getSandboxAutomation: vi.fn<AuthService["getSandboxAutomation"]>(),
  openSandboxAutomation: vi.fn<AuthService["openSandboxAutomation"]>(),
  navigate: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null || !network.readyHostIds.has(hostId)
      ? null
      : {
          getActiveHost: () => ({
            hostId,
            websocketUrl: `wss://${hostId}.test/rpc`,
          }),
          getActiveHostId: () => hostId,
          getRequestContextUserId: () =>
            useAuthStore.getState().contextMetadata?.userId ?? null,
          request: (method: string, params: unknown) =>
            hostRequest(hostId, method, params),
          requestWithSignal: (method: string, params: unknown) =>
            hostRequest(hostId, method, params),
        },
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId !== null && network.readyHostIds.has(hostId)
      ? {
          hostId,
          websocketUrl: `wss://${hostId}.test/rpc`,
          transportDialability: "dialable",
        }
      : null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-effective",
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-list-query")
  >()),
  useSandboxList: () => ({ data: undefined }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    auth: {
      getSandboxAutomation: network.getSandboxAutomation,
      openSandboxAutomation: network.openSandboxAutomation,
    },
    directory: { refresh: vi.fn() },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => network.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: vi.fn(),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));

function hostRequest(
  hostId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  network.calls.push({ hostId, method });
  if (method === "worktree.listBindingsForEpic") {
    return Promise.resolve({ rows: [], folderlessCwd: `/home/${hostId}` });
  }
  if (method === "terminal.plain.list") {
    return Promise.resolve({
      coverage: "complete-local",
      scope: { kind: "independent" },
      terminals: [],
    });
  }
  if (
    method === "terminal.plain.create" &&
    typeof params === "object" &&
    params !== null &&
    "terminalId" in params &&
    typeof params.terminalId === "string"
  ) {
    const { terminalId } = params;
    const cwd = `/home/${hostId}`;
    return Promise.resolve({
      terminal: {
        record: {
          hostId,
          terminalId,
          scope: { kind: "independent" },
          launch: { cwd, shellCommand: "zsh", shellArgs: [] },
          manualTitle: null,
          revision: 1,
          createdAt: "2026-10-27T00:00:00Z",
          updatedAt: "2026-10-27T00:00:00Z",
        },
        runtime: {
          status: "running",
          sessionId: terminalId,
          currentCwd: cwd,
          activeProcessName: "zsh",
          cols: 80,
          rows: 24,
        },
      },
    });
  }
  return Promise.reject(new Error(`Unexpected RPC ${method}`));
}

function pod(ordinal: number, hostId: string, state: "awake" | "released") {
  return {
    sandbox: sandboxSummaryFixture({
      id: `sbx-pod-${ordinal}`,
      hostId,
      kind: "automation",
      state,
      environmentId: TEAM,
    }),
    ordinal,
    liveShells: 0,
    headroom: 1,
  } satisfies SandboxPod;
}

function PodProbe() {
  const pods = useSandboxTeamPods([TEAM]);
  return <output aria-label="pods">{pods.get(TEAM)?.length ?? "cold"}</output>;
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function Harness(props: { readonly clicked: SandboxPod }) {
  const opener = useOpenAutomationTerminal({
    existing: {
      hostId: props.clicked.sandbox.hostId,
      sandboxId: props.clicked.sandbox.id,
      awake: false,
    },
    teamEnvironmentId: TEAM,
  });
  const placeholder = useLandingPanelStore((state) => state.placeholder);
  return (
    <>
      <button type="button" onClick={opener.run}>
        Open terminal
      </button>
      <button type="button" onClick={opener.retry}>
        Retry row
      </button>
      <PodProbe />
      {placeholder?.automation === undefined ? null : (
        <AutomationTerminalPane
          request={placeholder.automation}
          instanceId={placeholder.instanceId}
        />
      )}
    </>
  );
}

beforeEach(() => {
  resetNegotiatedManifests();
  network.calls.length = 0;
  network.readyHostIds.clear();
  network.getSandboxAutomation.mockReset();
  network.getSandboxAutomation.mockImplementation(() => podsAnswer());
  network.openSandboxAutomation.mockReset();
  network.navigate.mockReturnValue(new Promise<void>(() => undefined));
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

let podsAnswer: () => Promise<SandboxAutomationFetchResult> = () =>
  Promise.reject(new Error("pod answer not configured"));

const podOne = pod(1, POD_ONE_HOST, "awake");
const podTwo = pod(2, POD_TWO_HOST, "released");

function answer(pods: readonly SandboxPod[]) {
  return {
    kind: "ok" as const,
    automation: { available: true, sandbox: null, pods },
  };
}

function renderClickedPodTwo() {
  // A null ordinal lets the server pick the pod with headroom (pod 1).
  network.openSandboxAutomation.mockImplementation(
    (target: SandboxAutomationOpenTarget | null) => {
      const chosen = target?.ordinal === 2 ? podTwo : podOne;
      return Promise.resolve({
        kind: "ok",
        sandbox: chosen.sandbox,
        settled: true,
      });
    },
  );
  for (const hostId of [POD_ONE_HOST, POD_TWO_HOST]) {
    network.readyHostIds.add(hostId);
    recordNegotiatedHostMethods(hostId, METHODS);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness clicked={podTwo} />
    </QueryClientProvider>,
  );
}

async function clickOpen(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  // The pane is mounted once it shows its starting line.
  await screen.findByText(/Starting Automations/);
}

describe("opening a terminal on a specific team pod", () => {
  it("waits for the cold pod list, wakes the clicked pod's own ordinal and opens on its host", async () => {
    const held = deferred<SandboxAutomationFetchResult>();
    podsAnswer = () => held.promise;
    renderClickedPodTwo();

    await clickOpen();
    expect(network.openSandboxAutomation).not.toHaveBeenCalled();

    held.resolve(answer([podOne, podTwo]));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: TEAM,
      ordinal: 2,
    });
    expect(useLandingPanelStore.getState().tabs[0]).toMatchObject({
      kind: "terminal",
      hostId: POD_TWO_HOST,
    });
    expect(
      network.calls.filter((call) => call.method === "terminal.plain.create"),
    ).toEqual([{ hostId: POD_TWO_HOST, method: "terminal.plain.create" }]);
  });

  it("shows a retryable failure when the pod list errors, and opens the clicked pod after Retry", async () => {
    const held = deferred<SandboxAutomationFetchResult>();
    podsAnswer = () => held.promise;
    renderClickedPodTwo();

    await clickOpen();
    podsAnswer = () =>
      Promise.resolve({ kind: "network-error", detail: "offline" });
    held.resolve({ kind: "network-error", detail: "offline" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("automation-pod-query-failed");
    expect(network.openSandboxAutomation).not.toHaveBeenCalled();

    podsAnswer = () => Promise.resolve(answer([podOne, podTwo]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: TEAM,
      ordinal: 2,
    });
    expect(useLandingPanelStore.getState().tabs[0]).toMatchObject({
      hostId: POD_TWO_HOST,
    });
  });

  it("says the host no longer exists when the loaded list lacks the pod, and recovers on Retry", async () => {
    const held = deferred<SandboxAutomationFetchResult>();
    podsAnswer = () => held.promise;
    renderClickedPodTwo();

    await clickOpen();
    podsAnswer = () => Promise.resolve(answer([podOne]));
    held.resolve(answer([podOne]));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This host no longer exists.");
    expect(alert.textContent).toContain("automation-pod-missing");
    expect(network.openSandboxAutomation).not.toHaveBeenCalled();

    podsAnswer = () => Promise.resolve(answer([podOne, podTwo]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: TEAM,
      ordinal: 2,
    });
  });
});

describe("the Settings row's Retry on a specific team pod", () => {
  it("holds a cold Retry, then wakes the clicked pod's own ordinal once after the list answers, without creating a shell", async () => {
    const held = deferred<SandboxAutomationFetchResult>();
    podsAnswer = () => held.promise;
    renderClickedPodTwo();
    expect(screen.getByLabelText("pods").textContent).toBe("cold");

    await userEvent.click(screen.getByRole("button", { name: "Retry row" }));
    expect(network.openSandboxAutomation).not.toHaveBeenCalled();

    held.resolve(answer([podOne, podTwo]));
    await waitFor(() => {
      expect(network.openSandboxAutomation).toHaveBeenCalledTimes(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: TEAM,
      ordinal: 2,
    });
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(
      network.calls.some((call) => call.method === "terminal.plain.create"),
    ).toBe(false);
  });

  it("wakes the clicked pod's own ordinal once the list is loaded, without creating a shell", async () => {
    podsAnswer = () => Promise.resolve(answer([podOne, podTwo]));
    renderClickedPodTwo();
    await waitFor(() => {
      expect(screen.getByLabelText("pods").textContent).toBe("2");
    });

    await userEvent.click(screen.getByRole("button", { name: "Retry row" }));

    await waitFor(() => {
      expect(network.openSandboxAutomation).toHaveBeenCalledTimes(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: TEAM,
      ordinal: 2,
    });
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(
      network.calls.some((call) => call.method === "terminal.plain.create"),
    ).toBe(false);
  });
});
