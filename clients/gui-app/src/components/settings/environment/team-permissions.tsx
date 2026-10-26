import { useState, type ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { MarkdownEditPreview } from "@/components/markdown-edit-preview";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import {
  useConfigurationPolicyQuery,
  useConfigurationPolicyMutation,
} from "@/hooks/environment/team/use-policy-query";
import {
  useConfigurationSource,
  useCanAdministerConfiguration,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { useConfigurationAdminNames } from "@/hooks/environment/team/use-admin-names";
import { ConfigurationConflict } from "./configuration-conflict";
import { ConfigurationReadFailed } from "./team-read-failed";
import { usePickedTeamLabel, useConfigurationName } from "./team-pick-label";

/** A team's Permissions; `children` are the page's regions below the policy. */
export function TeamPermissions(props: {
  readonly children: ReactNode;
}): ReactNode {
  const personal = useConfigurationIsPersonal();
  const source = useConfigurationSource();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const query = useConfigurationPolicyQuery();
  const read = useBoundedRead(query);
  const [conflict, setConflict] = useState(false);
  return (
    <SettingsPanelShell
      title="Permissions"
      description={
        personal
          ? "What your agents may do without asking, on every computer and sandbox running Personal."
          : `What ${teamName}'s agents may do without asking, on every host running ${teamName}.`
      }
      bodyClassName="flex flex-col gap-3 overflow-visible rounded-none border-none bg-transparent"
    >
      {conflict ? <ConfigurationConflict changedBy={null} /> : null}
      {read.pending ? <MutedAgentSpinner /> : null}
      {read.failed ? (
        <ConfigurationReadFailed page="permissions" onRetry={read.retry} />
      ) : null}
      {query.data === undefined ? null : (
        <TeamPolicyEditor
          key={query.data.revision}
          body={query.data.body}
          revision={query.data.revision}
          onConflict={() => setConflict(true)}
        />
      )}
      {props.children}
    </SettingsPanelShell>
  );
}

function TeamPolicyEditor(props: {
  readonly body: string;
  readonly revision: number | null;
  readonly onConflict: () => void;
}): ReactNode {
  const personal = useConfigurationIsPersonal();
  const teamName = useConfigurationName();
  const source = useConfigurationSource();
  const canAdminister = useCanAdministerConfiguration();
  const members = useConfigurationAdminNames();
  const mutation = useConfigurationPolicyMutation();
  const [body, setBody] = useState(props.body);
  const [confirm, setConfirm] = useState(false);
  const save = (text: string): void => {
    if (source.kind !== "pool") return;
    mutation.mutate(
      {
        environmentId: source.environmentId,
        body: text,
        policyVersion: props.revision?.toString() ?? null,
      },
      {
        onSuccess: (result) => {
          if (result.outcome === "saved") setConfirm(false);
          else if (
            result.outcome === "refused" &&
            result.reason === "policy_stale"
          )
            props.onConflict();
        },
      },
    );
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-ui-sm font-medium">Approval policy</h2>
      <MarkdownEditPreview
        value={body}
        onChange={setBody}
        readOnly={!canAdminister || mutation.isPending}
        placeholder={undefined}
        ariaLabel="Approval policy"
        testId="team-approval-policy"
        showPreview={canAdminister}
      />
      {canAdminister ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => setConfirm(true)}
          >
            Reset to default
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={body === props.body || mutation.isPending}
            onClick={() => save(body)}
          >
            Save{mutation.isPending ? <MutedAgentSpinner /> : null}
          </Button>
        </div>
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          Admins change this
          {members.adminNames.length === 0
            ? "."
            : `: ${members.adminNames.join(", ")}.`}
        </p>
      )}
      {mutation.data?.outcome === "forbidden" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          You no longer have access to change this policy.
        </p>
      ) : null}
      {mutation.data?.outcome === "refused" &&
      mutation.data.reason !== "policy_stale" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          This policy could not be saved.
        </p>
      ) : null}
      <ConfirmDestructiveDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Reset the approval policy?"
        description={
          personal
            ? "This removes your custom rules and goes back to the default approval policy on every computer and sandbox running Personal."
            : `This removes ${teamName}'s custom rules and goes back to the default approval policy for every member's agents.`
        }
        cascadeSummary={null}
        actionLabel="Reset to default"
        isPending={mutation.isPending}
        blockedReason={null}
        onConfirm={() => save("")}
      />
    </section>
  );
}
