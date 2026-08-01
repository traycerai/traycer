import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useResetCountdown } from "@/lib/relative-time";
import { prSourceNoticeMessage } from "@/lib/pr/pr-source-notice-message";

/**
 * The ⓘ that explains why rows have stopped refreshing.
 *
 * The pause never shows as an error state: the rows on screen are real, just
 * not being refreshed, and `sourceStatus` stays `cached` to say exactly that.
 * The words themselves live in `pr-source-notice-message.ts`, one dialect for
 * every surface that shows this icon.
 */
export function PrSourceNoticeHint(props: {
  readonly notice: PrSourceNotice;
}): ReactNode {
  const countdown = useResetCountdown(props.notice.retryAt);
  const message = prSourceNoticeMessage(props.notice, countdown);
  return (
    // Two elements, two jobs. The live region announces the pause when it
    // appears, without anyone having to go looking for it; the button is what
    // makes the tooltip reachable, because a hover-only trigger hands the only
    // full explanation to pointer users and leaves sighted keyboard users
    // staring at an icon they cannot open. They cannot be the same element: a
    // focusable `role="status"` is precisely what `no-noninteractive-tabindex`
    // forbids, and it is right to - a live region is not a control.
    //
    // The message is rendered as visually-hidden TEXT, not as the region's
    // `aria-label`. A live region announces its accessible CONTENT when that
    // content changes; labelling an empty region gives it nothing to announce,
    // so the pause would land silently. The button keeps its own `aria-label`
    // because it is a control, and a control is named by its label.
    <span
      className="flex shrink-0 items-center"
      data-testid="pr-source-notice"
      data-notice-kind={props.notice.kind}
      role="status"
    >
      <span className="sr-only" data-testid="pr-source-notice-message">
        {message}
      </span>
      <TooltipWrapper label={message} side="bottom" sideOffset={4} align="end">
        <button
          type="button"
          className="focus-visible:ring-ring flex items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2"
          data-testid="pr-source-notice-trigger"
          aria-label={message}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipWrapper>
    </span>
  );
}
