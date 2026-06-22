/**
 * `buildCommandContext(router)` snapshots the app state every
 * source cares about. Called when the palette can't subscribe
 * reactively (test shells, unit tests).
 */
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { CommandContext, FocusedComposerKind } from "@/lib/commands/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface BuildCommandContextArgs {
  readonly router: KeybindingRouter;
  readonly focusedComposerKind: FocusedComposerKind | null;
}

export function buildCommandContext(
  args: BuildCommandContextArgs,
): CommandContext {
  const pathname = args.router.getPathname();
  const canvas = useEpicCanvasStore.getState();
  const activeTabId = canvas.activeTabId;
  const activeEpicId =
    activeTabId === null
      ? null
      : (canvas.tabsById[activeTabId]?.epicId ?? null);
  return {
    pathname,
    router: args.router,
    activeTabId,
    activeEpicId,
    focusedComposerKind: args.focusedComposerKind,
    // The global ⌘K palette never targets a pane; the in-pane opener builds its
    // own ctx with a non-null targetGroupId (see pane-opener.tsx).
    targetGroupId: null,
  };
}
