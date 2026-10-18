import type { QuoteChatTarget } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";

/** Focus is intent. Without it only a sole eligible chat is unambiguous. */
export function canvasAnnotationTarget(
  targets: readonly QuoteChatTarget[],
): QuoteChatTarget | null {
  const eligible = targets.filter((target) => !target.isOnOtherHost);
  const focused = eligible.find((target) => target.isLastFocused);
  return focused ?? (eligible.length === 1 ? eligible[0] : null);
}
