import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

interface Row {
  readonly hostId: string;
  readonly runningDir: string;
  readonly disabledReason: string | null;
  readonly mode: "local" | "worktree";
  readonly isGitRepo: boolean;
}

const state = vi.hoisted(() => ({ rows: [] as ReadonlyArray<Row> }));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  // Read on the epic's own host client since PR #1243 round 6; this suite is
  // about which roots are listed, not which client asked.
  useWorktreeListBindingsForEpicForClient: () => ({
    data: { rows: state.rows },
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => ({ mockHostId: hostId }),
}));

vi.mock("@/lib/commands/sources/open/use-active-epic-projection", () => ({
  useActiveEpicHostId: () => "epic-host",
}));

import { useSearchOpenerItems } from "@/lib/commands/sources/open/search-subpage";

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

function items(): ReadonlyArray<CommandItem> {
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() =>
    useSearchOpenerItems(CTX),
  ).result.current;
}

function row(
  runningDir: string,
  disabledReason: string | null,
  mode: "local" | "worktree",
  isGitRepo: boolean,
): Row {
  return { hostId: "host-a", runningDir, disabledReason, mode, isGitRepo };
}

beforeEach(() => {
  state.rows = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSearchOpenerItems (step 1: target selection)", () => {
  it("always lists the Epic artifact workspace even with no code workspace", () => {
    const result = items();
    expect(result.map((i) => i.label)).toEqual(["Artifacts"]);
    expect(result[0].subpage?.id).toBe("open:search:run:artifact");
  });

  it("lists setup-pending roots but excludes a genuinely missing worktree", () => {
    state.rows = [
      row("/ws/alpha", null, "local", false),
      row("/worktrees/setting-up", "setup_pending", "worktree", true),
      row("/worktrees/missing", "missing_worktree_path", "worktree", false),
      row("/worktrees/feature", null, "worktree", true),
    ];
    const result = items();
    expect(result.map((i) => i.label)).toEqual([
      "Artifacts",
      "alpha",
      "setting-up",
      "feature",
    ]);
    expect(result[1].subpage?.id).toBe(
      "open:search:run:code:host-a:%2Fws%2Falpha",
    );
  });
});
