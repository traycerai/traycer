import { CircleAlert, Clock, SquareArrowOutUpRight } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthOpenVerificationPageMutation } from "@/hooks/auth/use-auth-open-verification-page-mutation";
import { useAuthSignInMutation } from "@/hooks/auth/use-auth-sign-in-mutation";
import { type DeviceFlowProgress } from "@/lib/auth/auth-service";
import { formatClockDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import { DeviceCodeFallback } from "./device-code-fallback";
import { useRemainingSeconds } from "./use-remaining-seconds";

/** The panel's card and the inset inside it; unframed, a popover is its card. */
function frameOf(
  isHero: boolean,
  framed: boolean,
): { readonly card: string | null; readonly inset: string } {
  if (!framed) return { card: null, inset: "p-1.5" };
  if (isHero) {
    return {
      card: "rounded-lg border border-white/15 bg-white/[0.075] text-white shadow-[0_1.5rem_4rem_rgba(0,0,0,0.34)]",
      inset: "p-5",
    };
  }
  return {
    card: "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
    // In a narrow `signin` container (the strip's foot), tighter insets give
    // the device code room for one line.
    inset: "p-4 @max-[15rem]/signin:p-3",
  };
}

/**
 * Active device-flow progress. The app already auto-opens the pre-filled
 * approval page; this surface leads with a one-click "open approval page"
 * affordance (re-opening `verification_uri_complete`, code embedded) so the
 * user only ever has to click Approve - never type the code. The code + bare
 * URL remain as a manual fallback, and the spinner keeps it from being a silent
 * wait. Rendered while a device attempt is in flight.
 */
export function DeviceCodeProgress(props: {
  readonly progress: DeviceFlowProgress;
  readonly isHero: boolean;
  /** Its own card; off inside a popover, whose frame it already is. */
  readonly framed: boolean;
}) {
  const openVerificationPageMutation = useAuthOpenVerificationPageMutation();
  const signInMutation = useAuthSignInMutation();
  const progress = props.progress;
  const remainingSeconds = useRemainingSeconds(progress.expiresAtMs);
  const isFinalizing = progress.phase === "finalizing";
  // A consumed (approved) code can no longer expire - finalizing wins over the
  // countdown reaching zero while the token is validated.
  const isExpired = !isFinalizing && remainingSeconds === 0;
  const expiryCopy = isExpired
    ? "Code expired"
    : `Expires in ${formatClockDuration(remainingSeconds)}`;

  const frame = frameOf(props.isHero, props.framed);

  return (
    <div
      className={cn("flex w-full flex-col overflow-hidden", frame.card)}
      data-testid="signin-device-progress"
    >
      <div className={cn("flex flex-col gap-4", frame.inset)}>
        <div className="space-y-1.5 text-center">
          <h2 className="font-heading font-medium tracking-normal">
            Approve in your browser
          </h2>
          <p className="mx-auto max-w-[32ch] leading-5 text-ui-sm text-muted-foreground">
            After you approve, Traycer will continue here.
          </p>
        </div>

        <Button
          size={props.isHero ? "lg" : "sm"}
          className={cn(
            "w-full",
            props.isHero
              ? "h-11 border-white/20 bg-white text-zinc-950 hover:bg-white/90"
              : null,
          )}
          onClick={() => openVerificationPageMutation.mutate()}
          data-testid="signin-open-approval"
        >
          Open approval page
          {/* At the strip's narrowest, the label alone fills the button. */}
          <SquareArrowOutUpRight
            className="size-4 @max-[13rem]/signin:hidden"
            aria-hidden="true"
          />
        </Button>

        <div
          className={cn(
            // Wraps its two halves onto two lines where they do not fit (the
            // strip), rather than drawing one over the other.
            "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-ui-xs",
            props.isHero
              ? "border-white/10 bg-black/[0.18] text-white/[0.65]"
              : "border-border/70 bg-foreground/3 text-muted-foreground",
          )}
        >
          {isExpired ? (
            <div className="flex items-center gap-1">
              <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="shrink-0">Approval code expired</span>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <AgentSpinningDots
                variant="dots"
                className="shrink-0"
                testId="signin-device-spinner"
              />
              <span className="shrink-0">
                {isFinalizing
                  ? "Approved - finishing sign-in"
                  : "Waiting for approval"}
              </span>
            </div>
          )}
          {!isFinalizing && (
            <div className="flex items-center gap-1">
              <Clock className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{expiryCopy}</span>
            </div>
          )}
        </div>

        <DeviceCodeFallback progress={progress} isHero={props.isHero} />

        <Button
          type="button"
          size={props.isHero ? "inline" : "inline-xs"}
          variant="link"
          data-testid="signin-retry-link"
          onClick={() => {
            signInMutation.mutate();
          }}
          className={cn(
            "self-center",
            props.isHero ? "text-white/[0.72] hover:text-white" : null,
          )}
        >
          Taking too long? Start over
        </Button>
      </div>
    </div>
  );
}
