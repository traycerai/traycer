import type { ReactNode } from "react";
import { HostBootCard, HostBootHeadline } from "@/components/centered-card";
import { BootstrapLogDisclosure } from "@/components/local-host-loading";

/**
 * The WHOLE boot card - headline, details disclosure and `Open settings` -
 * for the two phases that precede the window narrator.
 *
 * WHY THE CONTROLS ARE HERE AND NOT ONLY ON THE LAST CARD. A launch crosses
 * three surfaces, and only the last one used to carry `Show details` and
 * `Open settings`; the first two were bare. So the card visibly GREW controls
 * partway through a wait, which reads as a different dialog replacing the
 * first rather than one surface progressing - the "why do we have these 2
 * modals" report. Same controls in the same places at every phase means the
 * only thing that changes across a launch is the sentence and, once a lane
 * reports, a progress bar.
 *
 * Both controls are genuinely LIVE here, which is why they are rendered rather
 * than stubbed disabled:
 *
 *  - `Show details` reads `traycer host status` through the runner host, which
 *    is mounted well above this surface. It self-hides on a shell with no CLI
 *    (web/mobile have no bootstrap log to show), which is the one honest
 *    absence in this family - see `BootstrapLogDisclosure`.
 *  - `Open settings` navigates the router instance, which exists from app
 *    construction even before `RouterProvider` mounts. On the earliest phase
 *    the navigation is therefore QUEUED: it takes effect the moment the router
 *    mounts, and Settings bypasses the readiness gate - so a user staring at a
 *    stuck launch can still get to the page that fixes it. That is the escape
 *    hatch this family must never lose.
 */
export function HostBootSurface(props: {
  readonly message: string;
  readonly testId: string | null;
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <HostBootCard testId={props.testId}>
      <HostBootHeadline
        message={props.message}
        spinnerVariant="sparkle"
        spinnerTestId="host-boot-spinner"
        messageTestId="host-boot-message"
      />
      <BootstrapLogDisclosure
        onConfigureShell={props.onConfigureShell}
        trailing={
          <BootOpenSettingsButton onOpenSettings={props.onOpenSettings} />
        }
      />
    </HostBootCard>
  );
}

/**
 * `Open settings` as a FOOTER PEER of `Show details`, not an accent link.
 *
 * Same muted weight and same size, because the two sit on one row and an
 * accent link beside a muted toggle reads as the card's primary action - on a
 * surface whose primary action is "wait". The escape hatch stays present and
 * clickable; it just stops shouting.
 */
export function BootOpenSettingsButton(props: {
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onOpenSettings}
      data-testid="host-boot-open-settings"
      className="inline-flex items-center text-ui-xs text-muted-foreground hover:text-foreground"
    >
      Open settings
    </button>
  );
}
