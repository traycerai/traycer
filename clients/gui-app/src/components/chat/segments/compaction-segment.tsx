import { ChevronDown, ChevronRight, Minimize2 } from "lucide-react";
import { useState } from "react";
import { useChatMeasuredBooleanToggle } from "@/components/chat/chat-measured-item-change-context";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TraycerMarkdown } from "@/markdown";

interface CompactionSegmentProps {
  status: "streaming" | "completed" | "errored";
  trigger: "auto" | "manual" | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
  findUnitId: string | null;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

// Pre-compaction token count is intentionally NOT shown on its own - a bare
// "before" number reads like a result/savings when it is not. Only the real
// before→after pair (when a harness reports both) or a standalone post count
// are meaningful enough to surface.
function compactionMetricText(
  preTokens: number | null,
  postTokens: number | null,
  durationMs: number | null,
): string {
  const metricParts: string[] = [];
  if (preTokens !== null && postTokens !== null) {
    metricParts.push(
      `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens`,
    );
  } else if (postTokens !== null) {
    metricParts.push(`${formatTokens(postTokens)} tokens`);
  }
  if (durationMs !== null) {
    metricParts.push(formatDuration(durationMs));
  }
  return metricParts.length === 0 ? "" : ` · ${metricParts.join(" · ")}`;
}

export function CompactionSegment(props: CompactionSegmentProps) {
  const { status, preTokens, postTokens, durationMs, summary, error } = props;
  const isStreaming = status === "streaming";
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useChatMeasuredBooleanToggle(setExpanded);

  const metricText = compactionMetricText(preTokens, postTokens, durationMs);

  const hasSummary = !isStreaming && summary !== null && summary.length > 0;
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;

  const labelInner = isStreaming ? (
    <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
      />
      <span>Compacting…</span>
    </div>
  ) : (
    <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
      <Minimize2 className="size-3.5 shrink-0" aria-hidden />
      <span>
        Compacted
        <span className="text-muted-foreground/80">{metricText}</span>
      </span>
      {hasSummary ? (
        <ExpandIcon className="size-3 shrink-0" aria-hidden />
      ) : null}
    </div>
  );

  return (
    <div
      data-chat-find-unit={props.findUnitId ?? undefined}
      className="flex w-full flex-col gap-1"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        {hasSummary ? (
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            className={cn(
              "rounded-sm outline-none transition-colors",
              "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {labelInner}
          </button>
        ) : (
          labelInner
        )}
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {hasSummary && expanded ? (
        <div
          className={cn(
            "mx-auto w-full max-w-[min(90vw,42rem)]",
            "rounded-md border border-border/60 bg-muted/30 p-3",
          )}
        >
          <TraycerMarkdown
            className={null}
            proseSize="compact"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {summary}
          </TraycerMarkdown>
        </div>
      ) : null}
      {error !== null && error.length > 0 ? (
        <div className="text-center text-ui-xs text-destructive">{error}</div>
      ) : null}
    </div>
  );
}
