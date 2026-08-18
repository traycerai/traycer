import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";
import { Card, CardContent } from "@/components/ui/card";

/**
 * THE ONE SHAPE every pre-app host surface wears.
 *
 * A launch crosses three of them in sequence - the runtime-binding fallback
 * ("Starting Traycer…"), the gate's attach cover, and the window narrator's
 * startup card - and they are necessarily different React trees: the first
 * mounts above `HostRuntimeProvider`, the second inside the gate frame, the
 * third beside it. Nothing can make them one component.
 *
 * What CAN be shared is their geometry, and it has to be, because the user
 * does not see three components - they see one card that changes shape twice
 * mid-launch. Reported exactly that way: "the UX design gap between them, it
 * looks very weird, non aligned". Before this, the sequence went `max-w-sm`
 * centred with a small muted spinner, then `max-w-md` left-aligned with a
 * large foreground spinner floating on its own line.
 *
 * One width, one alignment, one spinner treatment: later phases then ADD
 * content (a progress bar, a details toggle, actions) into a box that does not
 * move, which reads as one surface filling in rather than three modals taking
 * turns.
 */
export function HostBootCard(props: {
  readonly children: ReactNode;
  readonly testId: string | null;
}): ReactNode {
  const cardProps =
    props.testId === null ? {} : { "data-testid": props.testId };
  return (
    <Card
      {...cardProps}
      role="status"
      aria-live="polite"
      className="w-full max-w-sm shadow-sm"
    >
      {/* CENTRED, and narrow. Ruled by the user against rendered screenshots,
          twice: the released card centred its content and "the centered one
          was better looking". A wide `max-w-md` box with a left-aligned line
          in it leaves most of the card empty to the right, which is what "this
          alignment is bad" was about.

          This REVERSES the earlier branch-left decision recorded in
          `local-host-loading.tsx`. That decision was correct for what it was
          deciding - a DIALOG whose own left-aligned title and description sat
          above the body, where a centred body fought the heading above it. The
          healthy boot card has no title and no description now, so there is
          nothing left for the body to align WITH, and the winning argument for
          left-alignment went with it. */}
      <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
        {props.children}
      </CardContent>
    </Card>
  );
}

/**
 * The spinner and the line it belongs to - stacked and centred, the way the
 * released card drew them.
 *
 * The spinner is MUTED and text-sized on purpose. It was briefly `text-title-md
 * text-foreground`, which made it the loudest thing on a card whose whole job
 * is to be calm, and left it looking like an unanchored glyph rather than the
 * label's own activity indicator. This is a TEXT spinner (braille frames scaled
 * by font-size), so sizing it to the copy is what keeps the pair legible as one
 * unit.
 */
export function HostBootHeadline(props: {
  readonly message: string;
  readonly spinnerVariant: AgentSpinnerVariant | null;
  readonly spinnerTestId: string | null;
  readonly messageTestId: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3">
      {props.spinnerVariant === null ? null : (
        <AgentSpinningDots
          testId={props.spinnerTestId ?? undefined}
          variant={props.spinnerVariant}
          className="text-ui text-muted-foreground"
        />
      )}
      <p
        data-testid={props.messageTestId}
        className="text-ui font-medium text-foreground"
      >
        {props.message}
      </p>
    </div>
  );
}

export interface CenteredCardProps {
  readonly message: string;
  readonly spinnerVariant: AgentSpinnerVariant | null;
  readonly testId: string | null;
}

/**
 * Full-viewport centered boot card, for the surfaces that own the whole window
 * (the host-runtime fallback, which renders before any app chrome exists).
 *
 * The viewport wrapper is the ONLY thing this adds over {@link HostBootCard} -
 * surfaces that sit inside the gate frame supply their own centering, because
 * that frame already carries the header and a second `min-h-svh` inside it
 * would push the card below the fold.
 */
export function CenteredCard(props: CenteredCardProps): ReactNode {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground">
      <HostBootCard testId={props.testId}>
        <HostBootHeadline
          message={props.message}
          spinnerVariant={props.spinnerVariant}
          spinnerTestId="centered-card-agent-spinner"
          messageTestId={null}
        />
      </HostBootCard>
    </div>
  );
}
