import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/**
 * The landing composer's host picker is a SURFACE PIN (redesign P1.2,
 * selection model §2/§54), not the app-wide selection.
 *
 * The behaviour under test is the one the redesign exists to fix: before this,
 * placing a single chat on another machine moved the whole window - the picker
 * called `HostDirectoryService.selectById`, which is now the selection
 * authority bridge's alone. What has to be true instead is that a pick writes
 * this window's composer pin, that the chip resolves `pin ?? effective`, and
 * that the FIXED arm (fork dialogs, tab-context composers) still writes
 * nothing at all (§55).
 */

// The composer key is the BROWSER TAB's identity now, not the literal
// `"browser"` every tab used to share - two tabs on one origin would otherwise
// hydrate each other's placement pin out of localStorage. Pinned to a known id
// so this suite asserts against the key the hook actually builds.
vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => "tab-test",
  // The hook SUBSCRIBES to identity regeneration; a wholesale mock that omits
  // this throws on import rather than failing an assertion. This tab's id
  // never changes here, so the subscription is inert - see
  // `composer-surface-key-per-tab.test.tsx` for the arm that drives it.
  subscribeBrowserTabId: () => () => {},
}));

const COMPOSER_KEY = composerSurfaceKey("tab-test");

const mocks = vi.hoisted(() => ({
  selectById: vi.fn(),
  effectiveHostId: { current: "host-home" },
}));

const HOST_ENTRIES = [
  {
    hostId: "host-home",
    label: "Home Mac",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  },
  {
    hostId: "host-build",
    label: "Build Box",
    kind: "remote",
    websocketUrl: "wss://build.example/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  },
];

// `selectById` is the ONLY thing this suite asserts about the binding: it must
// never be reached from a composer pick again.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ directory: { selectById: mocks.selectById } }),
  useHostClient: () => null,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => null,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.effectiveHostId.current,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: HOST_ENTRIES }),
}));

vi.mock("@/hooks/host/use-refresh-host-directory-on-open", () => ({
  useRefreshHostDirectoryOnOpen: () => undefined,
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: [] },
    isFetching: false,
    isPending: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-workspaces-refresh", () => ({
  useWorktreeWorkspacesRefresh: () => ({
    canRefresh: false,
    refresh: () => Promise.resolve(),
    isRefreshing: false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: () => Promise.resolve(null),
  }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [
          hostScopeOptionFixture({ hostId: "host-home", name: "Home Mac" }),
          hostScopeOptionFixture({
            hostId: "host-build",
            name: "Build Box",
            isLocalMachine: false,
          }),
        ],
        activeHostId: mocks.effectiveHostId.current,
      }),
  };
});

function renderComposerPicker(
  hostScope:
    | { readonly kind: "active" }
    | {
        readonly kind: "fixed";
        readonly hostId: string;
        readonly hostClient: null;
      },
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          disabled={false}
          stagingKey={{ surface: "landing", hostId: null, draftId: null }}
          workspaceSeed={null}
          seedIntent={null}
          seedIntentOverride={null}
          layout="inline"
          hostScope={hostScope}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function pinnedHostId(): string | undefined {
  return useSurfaceHostSelectionStore.getState().selections[COMPOSER_KEY];
}

function chipLabel(): string {
  const label = screen
    .getByRole("button", { name: /^Host:/ })
    .querySelector(".truncate");
  if (label === null) throw new Error("host switcher label is missing");
  return label.textContent;
}

function pickBuildHost(): void {
  fireEvent.click(screen.getByRole("button", { name: /^Host:/ }));
  fireEvent.click(screen.getByRole("option", { name: /Build Box/ }));
}

beforeEach(() => {
  useSurfaceHostSelectionStore.getState().resetForTests();
  mocks.selectById.mockClear();
  mocks.effectiveHostId.current = "host-home";
});

afterEach(cleanup);

describe("composer host picker writes a surface pin", () => {
  it("pins the picked host instead of moving the app-wide selection", () => {
    renderComposerPicker({ kind: "active" });

    pickBuildHost();

    expect(pinnedHostId()).toBe("host-build");
    // The whole point of the row: placing one chat elsewhere must not move
    // the window. `selectById` belongs to the selection-authority bridge now.
    expect(mocks.selectById).not.toHaveBeenCalled();
  });

  it("keys the pin per WINDOW, so both composer instances agree", () => {
    renderComposerPicker({ kind: "active" });
    pickBuildHost();

    // ONE key for this window, whichever composer instance wrote it: a
    // per-component key would let the app-wide new-conversation modal
    // contradict the landing chip behind it. Outside desktop the "window" is
    // the browser tab, which is why the key carries a tab identity rather
    // than a constant.
    expect(
      Object.keys(useSurfaceHostSelectionStore.getState().selections),
    ).toEqual([COMPOSER_KEY]);
  });

  it("follows the effective host until a pick, then holds the pin through a failover", () => {
    renderComposerPicker({ kind: "active" });
    expect(chipLabel()).toBe("Home Mac");

    pickBuildHost();
    expect(chipLabel()).toBe("Build Box");

    // Derivation moves the effective host; a PINNED surface keeps its own (D6).
    cleanup();
    mocks.effectiveHostId.current = "host-home";
    renderComposerPicker({ kind: "active" });
    expect(chipLabel()).toBe("Build Box");
  });

  it("re-points a FOLLOWING chip when the effective host moves", () => {
    renderComposerPicker({ kind: "active" });
    expect(chipLabel()).toBe("Home Mac");

    cleanup();
    mocks.effectiveHostId.current = "host-build";
    renderComposerPicker({ kind: "active" });

    expect(chipLabel()).toBe("Build Box");
    expect(pinnedHostId()).toBeUndefined();
  });

  it("names a pinned host that left the directory rather than reading as Local", () => {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(COMPOSER_KEY, "host-retired");
    renderComposerPicker({ kind: "active" });

    // "Local" is the pre-directory default for a FOLLOWING surface. The
    // shared picker keeps identity and status separate, then combines both in
    // the accessible name.
    expect(chipLabel()).toBe("Unavailable");
    expect(
      screen.getByRole("button", { name: "Host: Unavailable, offline" }),
    ).toBeTruthy();
  });

  it("writes nothing from the FIXED arm (§55: fork dialogs are inert)", () => {
    renderComposerPicker({
      kind: "fixed",
      hostId: "host-home",
      hostClient: null,
    });

    const trigger = screen.getByRole("button", { name: /^Host:/ });
    fireEvent.click(trigger);
    expect(screen.queryByRole("option", { name: /Build Box/ })).toBeNull();

    expect(pinnedHostId()).toBeUndefined();
    expect(mocks.selectById).not.toHaveBeenCalled();
  });
});
