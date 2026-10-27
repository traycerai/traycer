import type { ReactNode } from "react";
import { sandboxSettingsStepsLine } from "@traycer/protocol/host/sandbox-settings";
import type { EnvironmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  useSandboxConfigurations,
  sandboxConfigurationOf,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";

export function SandboxSettingsFailedCard(props: {
  readonly detail: Extract<
    EnvironmentNotificationDetail,
    { kind: "environment_apply_failed" }
  >;
  readonly details: ReactNode;
  readonly onSettingsApplied?: () => void;
}) {
  const rows = useSandboxList().data?.sandboxes ?? [];
  const configurations = useSandboxConfigurations();
  const row = rows.find(
    (candidate) => candidate.hostId === props.detail.hostId,
  );
  const configuration =
    row === undefined
      ? null
      : sandboxConfigurationOf(row, configurations.configurations);
  const evidence = props.detail.sandbox;
  return (
    <div className="flex flex-col gap-2 text-ui-xs">
      <p>Compute is charged while it is awake.</p>
      {evidence === null || evidence === undefined ? null : (
        <p>{sandboxSettingsStepsLine(evidence)}</p>
      )}
      {row === undefined || configuration === null ? (
        <SandboxRetryApplyingButton hostId={props.detail.hostId} onApplied={props.onSettingsApplied} />
      ) : (
        <SandboxRowActions
          summary={{ ...row, guestConfigured: false }}
          configuration={configuration}
          unreachable={false}
          frozenNeedsOwnCredits={false}
          onSettingsApplied={props.onSettingsApplied}
        />
      )}
      {props.details}
    </div>
  );
}
