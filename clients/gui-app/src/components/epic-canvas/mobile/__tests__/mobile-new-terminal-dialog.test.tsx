import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";

/**
 * The phone "New terminal" dialog, on its two contracts:
 *
 * 1. Geometry - header, one scrolled region, and the Launch bar pinned outside
 *    it under a viewport height cap, so Launch cannot end up below the fold.
 * 2. Focus - the dialog and the picker body used to disagree about it. The
 *    dialog declined Radix's open-autofocus precisely so the workspace search
 *    could claim focus, and the search claimed it unconditionally, which on a
 *    touch device raises a keyboard over a two-tap pick. The pointer decides
 *    now, and the two halves move together.
 */

const bindingsQuery = vi.hoisted(() => ({
  current: null as {
    readonly data:
      | {
          readonly rows: WorktreeBindingSelectorRowV12[];
          readonly folderlessCwd: string | null;
        }
      | undefined;
    readonly isPending: boolean;
    readonly isError: boolean;
  } | null,
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => bindingsQuery.current,
  useWorktreeListBindingsForEpicForClient: () => bindingsQuery.current,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "MacBook",
    unavailability: null,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: "host-1" }],
    fetchStatus: "idle",
  }),
}));

// The host list is not what this suite is about; mocking at the option
// boundary is the same shape the sidebar picker's suite uses.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-1", name: "MacBook" })],
        activeHostId: "host-1",
      }),
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: {
      refresh: () => Promise.resolve([]),
      selectById: () => undefined,
    },
  }),
}));

import { MobileNewTerminalDialog } from "../mobile-new-terminal-dialog";

const SEARCH_PLACEHOLDER = "Search repo, branch, or path…";

function makeRow(
  hostId: string,
  runningDir: string,
  branch: string,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId,
    runningDir,
    workspacePath: "/work/traycer",
    worktreePath: runningDir,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch,
    isPrimary: runningDir.endsWith("traycer"),
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
  };
}

const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

function TestProviders(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={testQueryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderDialog(): void {
  render(
    <MobileNewTerminalDialog
      epicId="epic-1"
      tabId="tab-1"
      open
      onOpenChange={() => undefined}
      onLaunched={null}
    />,
    { wrapper: TestProviders },
  );
}

/**
 * The global test shim answers every media query with `matches: false`, which
 * is the fine-pointer arm. This narrows the coarse-pointer query alone so the
 * rest of the app's queries keep the shim's answer.
 */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe("<MobileNewTerminalDialog />", () => {
  beforeEach(() => {
    bindingsQuery.current = {
      data: {
        rows: [makeRow("host-1", "/work/traycer", "main")],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    stubCoarsePointer(false);
  });

  afterEach(() => {
    bindingsQuery.current = null;
    cleanup();
  });

  it("caps its height and pins Launch outside the scrolled region", () => {
    renderDialog();

    const dialog = screen.getByTestId("mobile-epic-new-terminal-dialog");
    expect(dialog.className).toContain("max-h-[min(86dvh,calc(100dvh-2rem))]");
    expect(dialog.className).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");

    const scroller = screen.getByTestId("new-terminal-picker-scroller");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(screen.getByTestId("worktree-folder-list"))).toBe(
      true,
    );
    // The whole point of the split: the host and folder pick can run long, and
    // Launch still cannot be scrolled away from.
    expect(
      scroller.contains(screen.getByRole("button", { name: "Launch" })),
    ).toBe(false);
  });

  it("focuses the workspace search when a fine pointer is driving", () => {
    renderDialog();

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(SEARCH_PLACEHOLDER),
    );
  });

  it("leaves the workspace search alone on a coarse pointer", () => {
    stubCoarsePointer(true);
    renderDialog();

    const search = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    expect(document.activeElement).not.toBe(search);
    // Focus still has to land inside the dialog - declining the search's claim
    // is not a licence to strand it on a trigger outside the focus scope.
    expect(
      screen
        .getByTestId("mobile-epic-new-terminal-dialog")
        .contains(document.activeElement),
    ).toBe(true);
  });
});
