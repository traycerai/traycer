import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useStatusGlyphTooltipOpen } from "@/components/notifications/status-glyph-focus";
import { harnessDisplayName } from "@/components/session-import/session-import-model";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

/**
 * The task list's unread dot: an imported task the user has not opened yet.
 *
 * Deliberately NOT part of the notification-indicator registry - that slot's
 * vocabulary is agent-work status (completed, failed, waiting), and provenance
 * is a different kind of fact. This is the unread idiom instead: a quiet dot
 * by the title that disappears the first time the task is opened.
 *
 * Not in the registry, but it reads the registry glyphs' `StatusGlyphFocusContext`
 * so a slot that chooses to hold its mark open on row keyboard focus can. The
 * history row's imported slot does not choose to: a row holds ONE tooltip open
 * and the leading status mark's is it, while this dot's sentence reaches a
 * screen reader through the row's `aria-describedby` and on screen it stays
 * the quiet unread dot it is by design (`HistoryRowStatusSlot`).
 */
export function ImportedUnseenDot(props: { readonly epicId: string }) {
  const harness = useImportedUnseenStore((state) => state.unseen[props.epicId]);
  const tooltipOpen = useStatusGlyphTooltipOpen();
  if (harness === undefined) return null;
  return (
    <TooltipWrapper
      label={`Imported from ${harnessDisplayName(harness)} - not opened yet`}
      side="top"
      sideOffset={undefined}
      align={undefined}
      open={tooltipOpen.open}
      onOpenChange={tooltipOpen.onOpenChange}
    >
      <span
        data-testid="imported-unseen-dot"
        role="img"
        aria-label={`Imported from ${harnessDisplayName(harness)}, not opened yet`}
        className="size-1.5 shrink-0 rounded-full bg-primary"
      />
    </TooltipWrapper>
  );
}
