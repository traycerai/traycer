import type { ReactNode } from "react";
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
  /** Last `onValueChange` handed to the mocked `Select`. */
  onValueChange: { current: null as ((value: string) => void) | null },
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

// Radix `Select` never opens in jsdom without pointer plumbing, so the picker
// is reduced to its contract: a value, a change handler, and one clickable row
// per host. That is exactly the surface this suite is about.
vi.mock("@/components/ui/select", () => ({
  Select: (props: {
    readonly children: ReactNode;
    readonly value: string | undefined;
    readonly onValueChange: (value: string) => void;
    readonly disabled: boolean;
  }) => {
    mocks.onValueChange.current = props.onValueChange;
    return (
      <div data-testid="host-select" data-value={props.value ?? ""}>
        {props.children}
      </div>
    );
  },
  SelectTrigger: (props: { readonly children: ReactNode }) => (
    <button type="button">{props.children}</button>
  ),
  SelectValue: (props: { readonly placeholder: string }) => (
    <span data-testid="host-select-label">{props.placeholder}</span>
  ),
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: {
    readonly children: ReactNode;
    readonly value: string;
    readonly disabled: boolean;
  }) => (
    <button
      type="button"
      data-testid={`host-option-${props.value}`}
      disabled={props.disabled}
      onClick={() => mocks.onValueChange.current?.(props.value)}
    >
      {props.children}
    </button>
  ),
}));

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

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Home Mac",
    unavailability: null,
  }),
  useRemoteSessionPollReadiness: () => true,
}));

vi.mock("@/hooks/host/use-remote-hosts-plan-gate", () => ({
  useRemoteHostsPlanRestricted: () => false,
}));

vi.mock("@/hooks/host/use-refresh-host-directory-on-open", () => ({
  useRefreshHostDirectoryOnOpen: () => undefined,
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
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({}) };
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
  return screen.getByTestId("host-select-label").textContent;
}

beforeEach(() => {
  useSurfaceHostSelectionStore.getState().resetForTests();
  mocks.selectById.mockClear();
  mocks.effectiveHostId.current = "host-home";
  mocks.onValueChange.current = null;
});

afterEach(cleanup);

describe("composer host picker writes a surface pin", () => {
  it("pins the picked host instead of moving the app-wide selection", () => {
    renderComposerPicker({ kind: "active" });

    fireEvent.click(screen.getByTestId("host-option-host-build"));

    expect(pinnedHostId()).toBe("host-build");
    // The whole point of the row: placing one chat elsewhere must not move
    // the window. `selectById` belongs to the selection-authority bridge now.
    expect(mocks.selectById).not.toHaveBeenCalled();
  });

  it("keys the pin per WINDOW, so both composer instances agree", () => {
    renderComposerPicker({ kind: "active" });
    fireEvent.click(screen.getByTestId("host-option-host-build"));

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

    fireEvent.click(screen.getByTestId("host-option-host-build"));
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

    // "Local" is the pre-directory default for a FOLLOWING surface. Showing it
    // for a pin to a machine the directory no longer carries would report a
    // dead pin as the local host.
    expect(chipLabel()).toBe("Unavailable");
  });

  it("writes nothing from the FIXED arm (§55: fork dialogs are inert)", () => {
    renderComposerPicker({
      kind: "fixed",
      hostId: "host-home",
      hostClient: null,
    });

    fireEvent.click(screen.getByTestId("host-option-host-build"));

    expect(pinnedHostId()).toBeUndefined();
    expect(mocks.selectById).not.toHaveBeenCalled();
  });
});
