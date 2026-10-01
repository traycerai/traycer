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
import "./onboarding-import.css";

/** The live import wizard uses the tour's early scan and selected host. */
export function OnboardingSessionImportStage(props: {
  readonly scan: SessionImportScanHandle;
  readonly hostPicker: OnboardingHostPicker;
  readonly onBeforeTaskOpen: () => Promise<boolean>;
  readonly onImportStarted: () => void;
}) {
  const { scan, hostPicker } = props;
  // Asked of the client the scan and the import would actually RUN on, not of
  // the ambient one the tour's step list was built from. Those are the same host
  // until someone picks another, and a host that predates session import
  // negotiates the methods away - so without this the step would offer a wizard
  // the picked machine cannot serve. `null` client answers "supported": the
  // gate above has already withheld the stage in that case.
  const binding = useStreamRuntimeBinding();
  const scanSupported = useSessionImportAvailableFor(
    binding?.wsStreamClient ?? null,
  );
  const hostReady = onboardingHostIsUsable(hostPicker);
  const hostPickerControl = (
    <OnboardingHostPickerBar
      picker={hostPicker}
      className="onboarding-import-host"
    />
  );
  return (
    <div
      data-testid="onboarding-session-import-stage"
      className="onboarding-import-stage flex h-full min-h-0 w-full min-w-0 flex-col text-foreground"
    >
      {hostReady && scanSupported ? (
        <SessionImportWizard
          surface="onboarding"
          hostPicker={hostPickerControl}
          scan={scan}
          onImportStarted={props.onImportStarted}
          onTaskOpened={() => undefined}
          onBeforeTaskOpen={props.onBeforeTaskOpen}
          secondaryAction={null}
        />
      ) : (
        <>
          {hostPickerControl}
          <OnboardingHostUnavailableNotice
            picker={hostPicker}
            refusal={
              hostReady
                ? `${hostPicker.scope.hostLabel} can't import sessions`
                : null
            }
          />
        </>
      )}
    </div>
  );
}
