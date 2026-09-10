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
 * Not in the registry, but under the same rule as its glyphs: the dot is not
 * a tab stop, so the containing row's keyboard focus holds the tooltip open
 * (`StatusGlyphFocusContext`), or the sentence would be hover-only.
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
