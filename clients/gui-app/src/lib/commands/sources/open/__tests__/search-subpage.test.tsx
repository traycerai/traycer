import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

interface Row {
  readonly hostId: string;
  readonly runningDir: string;
  readonly disabledReason: string | null;
}

const state = vi.hoisted(() => ({ rows: [] as ReadonlyArray<Row> }));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: state.rows },
    isPending: false,
    isError: false,
  }),
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

function row(runningDir: string, disabledReason: string | null): Row {
  return { hostId: "host-a", runningDir, disabledReason };
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

  it("lists only browsable workspace/worktree roots after the artifact target", () => {
    state.rows = [
      row("/ws/alpha", null),
      row("/ws/disabled", "setup_pending"),
      row("/worktrees/feature", null),
    ];
    const result = items();
    expect(result.map((i) => i.label)).toEqual([
      "Artifacts",
      "alpha",
      "feature",
    ]);
    expect(result[1].subpage?.id).toBe(
      "open:search:run:code:host-a:%2Fws%2Falpha",
    );
  });
});
