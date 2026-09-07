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

/** The scan is the page's, not this stage's: it has been running since the tour opened, so the list is already
 * filled in by the time this act is reached. */
export function OnboardingSessionImportStage(props: {
  readonly scan: SessionImportScanHandle;
  readonly hostPicker: OnboardingHostPicker;
}) {
  const { scan, hostPicker } = props;
  // Those are the same host until someone picks another, and a host that predates session import negotiates the
  // methods away - so without this the act would offer a wizard the picked machine cannot serve.
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
      <OnboardingHostPickerBar picker={hostPicker} trafficLights className="" />
      {hostReady && scanSupported ? (
        <SessionImportWizard
          surface="onboarding"
          scan={scan}
          // The wizard switches to its progress view on its own, and the tour's "Start building" stays where it is -
          // there is nothing for the page to do when a run starts.
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
