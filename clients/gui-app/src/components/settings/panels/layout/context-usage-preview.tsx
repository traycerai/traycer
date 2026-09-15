import type { ReactNode } from "react";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * One turn's usage, invented, and the only numbers this preview ever draws.
 *
 * Chosen so every control in the group has something to change: a window this
 * far gone reads `5% left`, which is the destructive tone rather than the
 * muted one a healthy reading would show; both cache figures are present, so
 * `Fresh`, `Cache read` and `Cache write` are rows the strip can actually
 * print and each of their chips does something; and `Output` is small enough
 * to render as a plain count beside the abbreviated ones.
 *
 * The figures are a matched set, not five independent numbers:
 * `buildContextUsageRows` derives `Fresh` as used − cache read − cache write,
 * so 946,956 / 945,800 / 1,100 is what makes the strip read
 * `Used 947K / 1M · Fresh 56 · Cache read 945.8k · Cache write 1.1k`. Changing
 * one of them changes a figure the user sees somewhere else.
 */
const CONTEXT_USAGE_PREVIEW_SAMPLE: TokenUsage = {
  inputTokens: 56,
  outputTokens: 3,
  totalTokens: 946_959,
  contextTokens: 946_956,
  cacheReadInputTokens: 945_800,
  cacheCreationInputTokens: 1_100,
  contextWindow: 1_000_000,
};

const SAMPLE_FIGURES_CAPTION =
  "Sample figures — the real strip reads the open chat's usage.";

/**
 * The context indicator as the settings below it draw it.
 *
 * It renders the REAL `ContextUsageChip`, from a fixed sample usage, so the
 * pin switch, the field chips and the three indicator styles are answered by
 * the component that answers them in a chat rather than by a second drawing of
 * it that could drift. That is the whole design: there is no preview-only
 * rendering path, and a change to the chip shows up here without this file
 * being touched.
 *
 * It needs no chat and reaches nothing that has one. The chip's only inputs
 * are the usage it is handed and the two settings stores, so a sample usage is
 * the entire substitution - no session handle, no host client, no query, no
 * fetch. `onCompact` is a no-op rather than `null` because the compaction
 * shortcut is part of what the strip looks like (Layout ▸ Composer can remove
 * it, and that has to show here too), and a `null` would quietly preview a
 * harness that cannot compact.
 *
 * The frame is `inert` and `aria-hidden` for the reason the status-bar preview
 * is: every control inside it is a real one that would be a dead end here, and
 * the rows below are where each is configured. `inert` takes the compact
 * button, the popover trigger and the unpin action out of the tab order and
 * stops the tooltips inside from ever opening; `aria-hidden` keeps a screen
 * reader from reading the same strip twice.
 *
 * Inside the frame the chip is mounted in `ComposerWorkspaceRow` itself - the
 * component the chat's bottom strip lays it out with - rather than in a copy
 * of its classes, because the chip's own layout is written against that row:
 * the pinned strip spans it, the inline chip is `justify-self-end`, and both
 * collapse at CONTAINER widths rather than viewport ones. Reusing the row is
 * what keeps a change to those tracks arriving here too. The empty leading
 * cell is the host / workspace cluster's place, so the trailing chip sits
 * where it sits in a chat.
 */
export function ContextUsagePreview(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <div
      data-testid="context-usage-preview-block"
      className={cn(
        "space-y-3 border-b border-border/40",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div className="space-y-1">
        <div className="font-medium text-foreground">Preview</div>
        <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
          The context indicator as these settings draw it.
        </p>
      </div>
      <div
        inert
        aria-hidden
        data-testid="context-usage-preview-frame"
        className="max-w-full overflow-hidden rounded-md border border-border/70 bg-canvas px-2 py-1.5 text-canvas-foreground"
      >
        <ComposerWorkspaceRow
          workspaceControls={
            <>
              <div className="min-w-0" />
              <ContextUsageChip
                usage={CONTEXT_USAGE_PREVIEW_SAMPLE}
                onCompact={previewCompact}
              />
            </>
          }
        />
      </div>
      <p
        data-testid="context-usage-preview-caption"
        className="text-ui-sm text-muted-foreground"
      >
        {SAMPLE_FIGURES_CAPTION}
      </p>
    </div>
  );
}

/**
 * The compaction shortcut's handler, which nothing can reach: the frame is
 * `inert`, so this exists to make the button RENDER rather than to run. Module
 * level so the chip's props keep one identity across re-renders.
 */
function previewCompact(): void {
  return undefined;
}
