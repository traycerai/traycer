import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Marker every card of this family carries (`data-surface`), so a test can prove a surface is drawn through
 * this component rather than merely resembling it. */
export const HOST_BOOT_CARD_SURFACE = "host-boot-card";

/** Only a settled failure adds to it (a title, diagnostics, actions), which reads as one surface filling in
 * rather than several modals taking turns. */
export function HostBootCard(props: {
  readonly children: ReactNode;
  readonly testId: string | null;
  /** Extra `data-*` markers for the card element (a narration's variant and cause, for tests and for a
   * screenshot's provenance). */
  readonly dataset: Readonly<Record<`data-${string}`, string>>;
  /** Caps the card at its layer's height and scrolls it inside, for a card drawn in a fixed layer that cannot
   * grow the page. A percentage of the layer's own content box cannot. */
  readonly viewportCapped: boolean;
}): ReactNode {
  const testIdProps =
    props.testId === null ? {} : { "data-testid": props.testId };
  return (
    <Card
      {...props.dataset}
      {...testIdProps}
      data-surface={HOST_BOOT_CARD_SURFACE}
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto w-full max-w-sm shadow-sm",
        props.viewportCapped ? "max-h-full overflow-y-auto" : null,
      )}
    >
      {/* The boot card is not a dialog: when a face of it does carry a title (a settled failure), the title centres
         with everything else, the way an alert card reads. */}
      <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
        {props.children}
      </CardContent>
    </Card>
  );
}

/** It was briefly `text-title-md text-foreground`, which made it the loudest thing on a card whose whole job is
 * to be calm, and left it looking like an unanchored glyph rather than the label's own activity indicator. */
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
