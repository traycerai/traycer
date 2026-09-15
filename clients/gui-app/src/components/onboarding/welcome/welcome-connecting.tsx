import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { WelcomeModalFooter } from "@/components/onboarding/welcome/welcome-modal-footer";

/**
 * The modal's body before the default host can answer: the frame is already
 * up (so a slow local boot does not show a bare app under a modal that
 * appears seconds later), and the one thing on offer is Skip.
 *
 * Deliberately no dead-end copy for an unavailable or failed host - the
 * window narrator owns those cards, and a second telling here would be a
 * second narrator.
 */
export function WelcomeConnecting(props: {
  readonly onSkip: () => void;
}): ReactNode {
  return (
    <>
      <div
        role="status"
        data-testid="welcome-connecting"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <AgentSpinningDots
          className="text-muted-foreground"
          testId="welcome-connecting-spinner"
          variant={undefined}
        />
        <p className="text-ui-sm text-muted-foreground">
          Connecting to your machine…
        </p>
      </div>
      <WelcomeModalFooter
        leading={null}
        secondary={null}
        primary={{
          label: "Skip",
          onSelect: props.onSkip,
          disabled: false,
          pending: false,
        }}
      />
    </>
  );
}
