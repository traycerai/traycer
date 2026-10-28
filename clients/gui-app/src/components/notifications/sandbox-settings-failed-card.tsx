import type { ReactNode } from "react";
import { sandboxSettingsStepsLine } from "@traycer/protocol/host/sandbox-settings";
import {
  sandboxSettingsNoticeSaysAwake,
  useSandboxSettingsNoticeRow,
  type SandboxApplyFailedDetail,
} from "@/hooks/sandboxes/use-sandbox-settings-notice";
import {
  useSandboxConfigurations,
  sandboxConfigurationOf,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { Button } from "@/components/ui/button";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";
import {
  COMPUTE_CHARGED_WHILE_AWAKE,
  DETAILS,
} from "@/lib/sandboxes/sandbox-strings";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/**
 * The notice's expansion and actions, read off the sandbox's current row: the
 * row's own actions, and one Details, the sandbox's. `details` is only for a
 * notice that names no sandbox id once its row is gone.
 */
export function SandboxSettingsFailedCard(props: {
  readonly detail: SandboxApplyFailedDetail;
  readonly details: ReactNode;
  readonly onSettingsApplied?: () => void;
}) {
  const row = useSandboxSettingsNoticeRow(props.detail.hostId);
  const configurations = useSandboxConfigurations();
  const configuration =
    row === undefined || row === null
      ? null
      : sandboxConfigurationOf(row, configurations.configurations);
  const evidence = props.detail.sandbox;
  const sandboxId = row?.id ?? evidence?.sandboxId ?? null;
  return (
    <div className="flex flex-col gap-2 text-ui-xs">
      {sandboxSettingsNoticeSaysAwake(row) ? (
        <p>{COMPUTE_CHARGED_WHILE_AWAKE}</p>
      ) : null}
      {evidence === null || evidence === undefined ? null : (
        <p>{sandboxSettingsStepsLine(evidence)}</p>
      )}
      {row !== undefined && row !== null && configuration !== null ? (
        <SandboxRowActions
          summary={row}
          settingsFailed
          configuration={configuration}
          unreachable={false}
          frozenNeedsOwnCredits={false}
          onSettingsApplied={props.onSettingsApplied}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {row?.state === "awake" ? (
            <SandboxRetryApplyingButton
              hostId={props.detail.hostId}
              guestSetupFailed={row.guestConfigured === false}
              onApplied={props.onSettingsApplied}
            />
          ) : null}
          {sandboxId === null ? (
            props.details
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openSandboxDetails(sandboxId)}
            >
              {DETAILS}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
