import type { ReactNode } from "react";
import {
  formatThinkingTokensEstimate,
  useActiveThinkingTokensEstimate,
} from "@/components/chat/thinking-tokens-source";

/**
 * The thinking-token estimate beside a STREAMING "Thinking" label, and
 * nowhere else. Draws nothing without an estimate for the live turn - a host
 * below `chat.subscribe@1.17`, a provider that sends none, or a turn that has
 * ended.
 *
 * Skipped by chat find: it is a live counter, not transcript text.
 */
export function ThinkingTokensEstimate(): ReactNode {
  const estimate = useActiveThinkingTokensEstimate();
  if (estimate === null) return null;
  return (
    <span
      data-find-skip=""
      data-testid="thinking-tokens-estimate"
      className="shrink-0 text-muted-foreground/80 tabular-nums"
    >
      {formatThinkingTokensEstimate(estimate)}
    </span>
  );
}
