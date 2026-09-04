import {
  OnboardingHostPickerBar,
  OnboardingHostUnavailableNotice,
} from "@/components/onboarding/onboarding-host-picker";
import {
  onboardingHostIsUsable,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import { SessionImportWizard } from "@/components/session-import/session-import-wizard";
import type { SessionImportScanHandle } from "@/components/session-import/use-session-import-scan";
import { useSessionImportAvailableFor } from "@/hooks/session-import/use-session-import-available";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

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
 *
 * The window's title says WHICH machine, and says it with the picker: the
 * sessions listed here and the run started from here belong to one host, and
 * that host is the one thing about this window a person may want to change.
 *
 * The scan is the page's, not this stage's: it has been running since the tour
 * opened, so the list is already filled in by the time this act is reached.
 */
export function OnboardingSessionImportStage(props: {
  readonly scan: SessionImportScanHandle;
  readonly hostPicker: OnboardingHostPicker;
}) {
  const { scan, hostPicker } = props;
  // Asked of the client the scan and the import would actually RUN on, not of
  // the ambient one the tour's act list was built from. Those are the same host
  // until someone picks another, and a host that predates session import
  // negotiates the methods away - so without this the act would offer a wizard
  // the picked machine cannot serve. `null` client answers "supported": the
  // gate above has already withheld the stage in that case.
  const binding = useStreamRuntimeBinding();
  const scanSupported = useSessionImportAvailableFor(
    binding?.wsStreamClient ?? null,
  );
  const hostReady = onboardingHostIsUsable(hostPicker);
  return (
    <div
      data-testid="onboarding-session-import-stage"
      className="flex h-[var(--onboarding-diorama-max-height)] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/12 bg-background text-foreground shadow-[0_2rem_4rem_-1.75rem_rgba(0,0,0,0.72),0_0.875rem_2rem_-1.25rem_rgba(0,0,0,0.55)]"
    >
      <OnboardingHostPickerBar
        label="Your work on"
        picker={hostPicker}
        trafficLights
      />
      {hostReady && scanSupported ? (
        <SessionImportWizard
          surface="onboarding"
          scan={scan}
          // The wizard switches to its progress view on its own, and the tour's
          // "Start building" stays where it is - there is nothing for the page
          // to do when a run starts.
          onImportStarted={() => undefined}
          secondaryAction={null}
        />
      ) : (
        <OnboardingHostUnavailableNotice
          picker={hostPicker}
          refusal={
            hostReady
              ? `${hostPicker.scope.hostLabel} can't import sessions`
              : null
          }
        />
      )}
    </div>
  );
}
