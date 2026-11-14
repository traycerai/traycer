import { NotificationHookRefusalError } from "@traycer-clients/shared/environment/notification-hook-refusal";
import { CloudNotificationHooksSection } from "../panels/cloud-notification-hooks-section";
import { TEAM_NOTIFICATION_HOOKS_COPY } from "../panels/cloud-notification-copy";
import { SettingsPanelShell } from "../settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useTeamNotificationHooks } from "@/hooks/environment/team/use-team-notification-hooks";
import { useConfigurationName } from "./team-pick-label";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import { configurationWriteIssue } from "./configuration-write-issue";

export function TeamNotificationHooksSettingsPanel() {
  const pick = useEnvironmentPick();
  return (
    <SettingsPanelShell
      title={TEAM_NOTIFICATION_HOOKS_COPY.title}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {pick.kind === "team" ? <TeamHooks /> : null}
    </SettingsPanelShell>
  );
}

function TeamHooks() {
  const name = useConfigurationName();
  const { read, put, canEdit } = useTeamNotificationHooks();
  const refusal =
    put.error instanceof NotificationHookRefusalError ? put.error : null;
  const refusedHookId =
    refusal !== null && refusal.index !== null
      ? (put.variables?.hooks[refusal.index]?.id ?? null)
      : null;
  const editorProblem =
    refusal?.code === "hook_local_only"
      ? {
          hookId: refusedHookId,
          message: TEAM_NOTIFICATION_HOOKS_COPY.localOnly("$NAME"),
        }
      : null;
  return (
    <div className="space-y-3">
      <p className="text-ui-sm text-muted-foreground">
        {TEAM_NOTIFICATION_HOOKS_COPY.description(name)}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        {TEAM_NOTIFICATION_HOOKS_COPY.visibility(name)}
      </p>
      {read.isLoading ? (
        <AgentSpinningDots
          className={undefined}
          testId="team-notification-hooks-loading"
          variant={undefined}
        />
      ) : null}
      {read.error === null ? null : (
        <p role="alert" className="text-ui-sm text-destructive">
          {read.error.message}
        </p>
      )}
      <ConfigurationWriteFeedback
        issue={
          put.data === undefined ? null : configurationWriteIssue(put.data)
        }
      />
      {read.data === undefined || read.error !== null ? null : (
        <CloudNotificationHooksSection
          key={canEdit ? "edit" : "read"}
          scope="team"
          teamName={name}
          snapshot={read.data}
          saving={put.isPending || read.isFetching}
          canEdit={canEdit}
          refusedHookId={refusedHookId}
          error={put.error?.message ?? null}
          editorProblem={editorProblem}
          onClearProblem={() => {
            if (!put.isPending) put.reset();
          }}
          onSave={(hooks, revision, onSuccess, onConflict) => {
            if (!canEdit) return;
            put.mutate(
              { hooks, revision },
              {
                onSuccess: (result) => {
                  if (result.outcome === "saved") onSuccess();
                  else if (result.outcome === "conflict") onConflict();
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}
