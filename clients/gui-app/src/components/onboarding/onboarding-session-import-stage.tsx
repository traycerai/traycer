import { SessionImportWizard } from "@/components/session-import/session-import-wizard";

/**
 * The session-import act's stage: the real wizard, dressed as the same mini-app
 * window the rest of the tour previews.
 *
 * It stands in for the diorama rather than sitting under the copy, because this
 * act has no mock-up to show - the panel IS the live app reading the user's own
 * machine, and a folder list is unreadable squeezed into the copy rail. The
 * height comes from the diorama's own budget so the two windows are the same
 * object from act to act, and the flex chain below it is what gives the list a
 * bounded box to scroll inside.
 */
export function OnboardingSessionImportStage(props: {
  readonly registerSubmit: (submit: () => void) => void;
}) {
  const { registerSubmit } = props;
  return (
    <div
      data-testid="onboarding-session-import-stage"
      className="flex h-[var(--onboarding-diorama-max-height)] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/12 bg-background text-foreground shadow-[0_2rem_4rem_-1.75rem_rgba(0,0,0,0.72),0_0.875rem_2rem_-1.25rem_rgba(0,0,0,0.55)]"
    >
      <header className="relative flex h-10 shrink-0 items-center justify-center bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']">
        <div
          aria-hidden="true"
          className="absolute left-3 flex items-center gap-1.5"
        >
          <span className="size-2 rounded-full bg-[#ff5f57]" />
          <span className="size-2 rounded-full bg-[#ffbd2e]" />
          <span className="size-2 rounded-full bg-[#28c840]" />
        </div>
        <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
          Your work on this machine
        </span>
      </header>
      <SessionImportWizard
        surface="onboarding"
        // The tour advances on Continue, which is also what submits - so the
        // wizard has nothing left to tell the page when a run starts.
        onImportStarted={() => undefined}
        secondaryAction={null}
        registerSubmit={registerSubmit}
      />
    </div>
  );
}
