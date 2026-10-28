import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { LandingTerminalGestureProvider } from "@/components/home/terminal-panel/landing-terminal-gesture-provider";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  landingTerminalTabs,
  useLandingPanelStore,
} from "@/stores/home/landing-panel-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useTabsStore } from "@/stores/tabs/store";

const LANDING_PAGE_ID = "test-landing-page";
const SURFACE = "landing:window-test";
const COMPOSER_HOST = "host-composer";
const AUTOMATIONS_HOST = "host-automations";
const BUILD_HOST = "host-build";

// Host RPCs, the sandbox auth service and the authority fleet are the external
// boundaries; the landing store, the row, the pane and the panel are real.
// Every value a mocked hook returns is created once: the panel keys effects on
// these identities, and a fresh object per render restarts them every render.
const world = vi.hoisted(() => ({
  killTerminal: {
    mutate: vi.fn(),
    mutateAsync: vi.fn(() => Promise.resolve({ killed: true })),
  },
  listProbe: {
    data: { sessions: [], homeCwd: "/Users/dev" },
    error: null,
    dataUpdatedAt: 1,
  },
  workspaceSource: {
    primaryWorkspacePath: null,
    folders: [] as string[],
    capturedIntent: null,
    draftId: "test-landing-page",
  },
  runnerHost: { browserView: null, signInUrl: "https://example.test" },
  modalActions: { close: vi.fn() },
  hostDirectory: {
    findById: (hostId: string) => ({ hostId, websocketUrl: "ws://test" }),
  },
  hostBinding: {
    auth: { openSandboxAutomation: vi.fn(), getSandboxAutomation: vi.fn() },
    directory: { refresh: vi.fn() },
  },
  request:
    vi.fn<
      (hostId: string, method: string, params: unknown) => Promise<unknown>
    >(),
  navigate: vi.fn(),
  activateTab: vi.fn(),
}));

// These cases are about the sandboxes-on behaviour: the Automations shell and
// the new-terminal picker's staging are withheld on any other verdict.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => world.runnerHost,
  useRunnerHostOrNull: () => world.runnerHost,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => COMPOSER_HOST,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => COMPOSER_HOST,
}));
const composerClient = {
  getActiveHostId: () => COMPOSER_HOST,
  onChange: () => () => undefined,
  request: (method: string, params: unknown) =>
    world.request(COMPOSER_HOST, method, params),
  requestWithSignal: (method: string, params: unknown) =>
    world.request(COMPOSER_HOST, method, params),
};
const composerPlacement = (() => {
  const target = {
    resolvedHostId: COMPOSER_HOST,
    client: composerClient,
    hostLabel: null,
    isPinned: false,
    namedHostDead: false,
  };
  return {
    pin: {
      selection: null,
      honoredSelection: null,
      resolvedHostId: COMPOSER_HOST,
      isPinned: false,
      setSelection: () => undefined,
      latchOnFirstUse: () => undefined,
    },
    target,
    submitTarget: target,
    hostLabelFor: () => null,
    followsEffective: true,
  };
})();
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => composerPlacement,
}));
vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => SURFACE,
  }),
);
vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/host-connection-registry")
    >()),
    subscribeHostRowChanged: () => () => undefined,
  }),
);
vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => world.listProbe,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => world.hostBinding,
  useHostClient: () => composerClient,
  useHostRuntimeClient: () => composerClient,
  useHostDirectory: () => world.hostDirectory,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildDialableHostClient: (_client: unknown, entry: { hostId: string }) =>
    hostClient(entry.hostId),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : hostClient(hostId),
}));
const directoryEntries = new Map<string, object>();
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) => {
    if (hostId === null) return null;
    const known = directoryEntries.get(hostId);
    if (known !== undefined) return known;
    const entry = {
      hostId,
      kind: "local",
      transportDialability: "dialable",
      websocketUrl: "wss://host.test",
    };
    directoryEntries.set(hostId, entry);
    return entry;
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
  sandboxListReadSentAt: () => null,
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
  isMobileViewport: () => false,
}));
vi.mock(
  "@/components/home/host-workspace-selector/use-home-workspace-source",
  () => ({
    useHomeWorkspaceSource: () => world.workspaceSource,
  }),
);
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => world.killTerminal,
  }),
);
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-authority-fleet",
  async () => {
    const { useEffect } = await import("react");
    return {
      LandingTerminalAuthorityFleet: (props: {
        readonly hostIds: readonly string[];
        readonly onEntry: (hostId: string, entry: unknown) => void;
      }) => {
        const { onEntry } = props;
        const hostKey = props.hostIds.join("\u0000");
        useEffect(() => {
          const hostIds = hostKey.length === 0 ? [] : hostKey.split("\u0000");
          hostIds.forEach((hostId) => {
            onEntry(hostId, {
              authority: {
                hostId,
                scope: { kind: "independent" },
                capability: { status: "legacy" },
                collection: undefined,
                terminals: [],
                canMutate: false,
                query: {},
              },
              mutations: {
                create: { mutateAsync: vi.fn() },
                ensureRunning: { mutateAsync: vi.fn() },
                rename: { mutate: vi.fn() },
                close: { mutateAsync: vi.fn() },
                importLegacy: { mutateAsync: vi.fn() },
              },
            });
          });
          return () => {
            hostIds.forEach((hostId) => onEntry(hostId, null));
          };
        }, [hostKey, onEntry]);
        return null;
      },
    };
  },
);
vi.mock("@/components/home/terminal-panel/landing-terminal-tile", () => ({
  LandingTerminalTile: () => <div>Terminal</div>,
}));
vi.mock("@/components/home/terminal-panel/landing-browser-tile", () => ({
  LandingBrowserTile: () => <div>Browser</div>,
}));
vi.mock("@/components/epic-canvas/renderers/xterm-host-registry", () => ({
  reconcileXtermHostAfterLayoutTransition: vi.fn(),
}));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: world.activateTab,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => world.navigate,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-patch-mutation", () => ({
  useSandboxPatch: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyDialog: () => null,
  SandboxIdleSettingsDialog: () => null,
  SandboxKeepDialog: () => null,
  SandboxRenameDialog: () => null,
  SandboxStopDialog: () => null,
  SandboxSuspendDialog: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/stores/tabs/use-system-tab-modal")
  >()),
  useSystemTabModalActions: () => world.modalActions,
}));

const hostClients = new Map<string, object>();
function hostClient(hostId: string): object {
  const known = hostClients.get(hostId);
  if (known !== undefined) return known;
  const client = {
    getActiveHostId: () => hostId,
    getRequestContextUserId: () => "u1",
    onChange: () => () => undefined,
    request: (method: string, params: unknown) =>
      world.request(hostId, method, params),
    requestWithSignal: (method: string, params: unknown) =>
      world.request(hostId, method, params),
  };
  hostClients.set(hostId, client);
  return client;
}

function requestedTerminalId(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "terminalId" in params &&
    typeof params.terminalId === "string"
  )
    return params.terminalId;
  throw new Error("terminal.plain.create did not receive a terminal id");
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function automationsRow(): SandboxSummary {
  return sandboxSummaryFixture({
    id: "sbx-automations",
    hostId: AUTOMATIONS_HOST,
    displayName: "Automations",
    kind: "automation",
    state: "awake",
    burst: false,
    frozen: false,
  });
}

const INITIAL_TABS = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};

beforeEach(() => {
  resetNegotiatedManifests();
  recordNegotiatedHostMethods(AUTOMATIONS_HOST, [
    "terminal.plain.list",
    "terminal.plain.create",
    "worktree.listBindingsForEpic",
  ]);
  hostClients.clear();
  world.request.mockReset();
  world.hostBinding.auth.openSandboxAutomation.mockReset();
  world.hostBinding.auth.getSandboxAutomation.mockReset();
  world.navigate.mockReset();
  world.activateTab.mockReset();
  world.navigate.mockReturnValue(new Promise<void>(() => undefined));
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  useSurfaceHostSelectionStore.getState().resetForTests();
  useLandingPanelStore.getState().resetForTests();
  useTabsStore.setState({
    items: [
      {
        kind: "tab",
        id: "item-draft-a",
        ref: { kind: "draft", id: LANDING_PAGE_ID },
      },
    ],
    activeItemId: "item-draft-a",
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useLandingPanelStore.getState().resetForTests();
  useTabsStore.setState(INITIAL_TABS);
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a requested terminal and an Automations terminal opening together", () => {
  it("keeps a newer Open terminal ask from another row through the Automations shell landing, then serves it", async () => {
    const createGate = deferred<undefined>();
    // The requested host's home is not known until its list answers.
    const buildList = deferred<{
      readonly sessions: readonly [];
      readonly homeCwd: string;
    }>();
    world.request.mockImplementation(
      (hostId: string, method: string, params: unknown) => {
        if (method === "terminal.list")
          return hostId === BUILD_HOST
            ? buildList.promise
            : Promise.resolve({ sessions: [], homeCwd: "/Users/dev" });
        if (method === "worktree.listBindingsForEpic")
          return Promise.resolve({
            rows: [],
            folderlessCwd: "/automation/work",
          });
        if (method === "terminal.plain.list")
          return Promise.resolve({
            coverage: "complete-local",
            scope: { kind: "independent" },
            terminals: [],
          });
        if (method === "terminal.plain.create")
          return createGate.promise.then(() => ({
            terminal: {
              record: {
                hostId,
                terminalId: requestedTerminalId(params),
                scope: { kind: "independent" },
                launch: { cwd: "/automation/work" },
                manualTitle: null,
                revision: 1,
                createdAt: "2026-10-27T00:00:00Z",
                updatedAt: "2026-10-27T00:00:00Z",
              },
              runtime: {
                status: "running",
                sessionId: requestedTerminalId(params),
                currentCwd: "/automation/work",
                activeProcessName: "zsh",
                cols: 80,
                rows: 24,
              },
            },
          }));
        return Promise.reject(new Error(`Unexpected RPC ${method}`));
      },
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <TooltipProvider>
          <LandingTerminalGestureProvider draftId={LANDING_PAGE_ID}>
            <SandboxRowActions
              summary={automationsRow()}
              configuration={{ kind: "personal" }}
              unreachable={false}
              frozenNeedsOwnCredits={false}
              settingsFailed={false}
            />
            <SandboxRowActions
              summary={sandboxSummaryFixture({
                id: "sbx-build",
                hostId: BUILD_HOST,
                displayName: "build-box",
                state: "awake",
                burst: false,
                guestConfigured: true,
              })}
              configuration={{ kind: "personal" }}
              unreachable={false}
              frozenNeedsOwnCredits={false}
              settingsFailed={false}
            />
            <LandingTerminalPanel />
          </LandingTerminalGestureProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));
    await waitFor(() =>
      expect(
        world.request.mock.calls.some(
          ([, method]) => method === "terminal.plain.create",
        ),
      ).toBe(true),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "More actions for build-box" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open terminal" }),
    );
    expect(useLandingPanelStore.getState().terminalRequest).toMatchObject({
      surfaceKey: SURFACE,
      hostId: BUILD_HOST,
    });

    createGate.resolve(undefined);
    await waitFor(() =>
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1),
    );
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0],
    ).toMatchObject({ hostId: AUTOMATIONS_HOST });
    expect(useLandingPanelStore.getState().terminalRequest).toMatchObject({
      surfaceKey: SURFACE,
      hostId: BUILD_HOST,
    });

    act(() => buildList.resolve({ sessions: [], homeCwd: "/Users/dev" }));
    await waitFor(() =>
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs).map(
          (tab) => tab.hostId,
        ),
      ).toContain(BUILD_HOST),
    );
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });
});
