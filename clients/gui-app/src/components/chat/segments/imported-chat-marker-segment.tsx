import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { importedChatMarkerLabel } from "@/components/chat/segments/imported-chat-marker-display";

interface ImportedChatMarkerSegmentProps {
  readonly sourceProvider: GuiHarnessId;
  readonly importedAt: number;
  readonly sourceCwd: string;
}

/**
 * Provenance for a chat materialized from a CLI session the user ran before
 * Traycer saw it (spec T6, closing D14).
 *
 * This row is the ONLY place an imported chat is marked. A badge in the task
 * list or on a tile would compete with the several other reasons a row gets an
 * ornament, and would keep competing forever for a fact that stops mattering
 * the moment the user continues the conversation here. Inside the transcript
 * it sits exactly where the history it describes begins.
 *
 * `role="note"` is how the row names itself to assistive tech and to tests:
 * ancillary content about the conversation rather than part of it, which is
 * also why the two rules beside the label are `aria-hidden` decoration.
 */
export function ImportedChatMarkerSegment(
  props: ImportedChatMarkerSegmentProps,
) {
  const { sourceProvider, importedAt, sourceCwd } = props;
  const label = importedChatMarkerLabel({ sourceProvider, importedAt });
  return (
    <div
      role="note"
      data-testid="imported-chat-marker"
      className="flex w-full items-center gap-3 py-4 text-ui-sm text-muted-foreground"
    >
      <div className="h-px min-w-0 flex-1 bg-border" aria-hidden />
      <TooltipWrapper
        label={sourceCwd}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {/* A real button, not the span this used to be: Radix merges focus
            handlers onto whatever it is given but cannot make a span focusable,
            and the tooltip is the only disclosure of the source directory - so
            a span left keyboard users with no way to reach it at all. The
            directory rides in the accessible name for the same reason: a
            tooltip that only opens on hover or focus is not a place a screen
            reader will find it. */}
        <button
          type="button"
          data-find-include="true"
          aria-label={`${label}. Source directory ${sourceCwd}`}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <HarnessIcon harnessId={sourceProvider} className="size-3.5" />
          <span className="truncate">{label}</span>
        </button>
      </TooltipWrapper>
      <div className="h-px min-w-0 flex-1 bg-border" aria-hidden />
    </div>
  );
}
