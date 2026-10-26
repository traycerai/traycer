import { useId, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  findTierConflicts,
  FALLBACK_RUNG_KINDS,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { FallbackBehaviorGroup } from "@/components/settings/panels/fallback/fallback-behavior-group";
import { FallbackLadderEditor } from "@/components/settings/panels/fallback/fallback-ladder-editor";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";
import { FallbackConflictAnnouncementsProvider } from "@/components/settings/panels/fallback/fallback-conflict-announcements-provider";
import { useFallbackCatalogOptionsForClient } from "@/components/settings/panels/fallback/fallback-catalog-options";
import {
  toKeyedGroups,
  applyGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import {
  clearPolicyOverride,
  clearPolicyOverrides,
} from "@/components/settings/panels/fallback/fallback-overrides-model";
import {
  moveFallbackRung,
  fallbackLadderFrom,
} from "@/components/settings/panels/fallback/fallback-policy-draft";
import { fallbackPolicySchema } from "@traycer/protocol/host/fallback-policy";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useConfigurationModelRoutingQuery } from "@/hooks/environment/team/use-model-routing-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import {
  FallbackTestModelButton,
  FallbackTestModelPanel,
} from "@/components/settings/panels/fallback/fallback-test-model-panel";
import { useConfigurationRoutingPreviewQuery } from "@/hooks/environment/team/use-routing-preview-query";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { usePickedTeamLabel } from "./team-pick-label";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import {
  useCanEditConfiguration,
  useConfigurationSource,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { ConfigurationReadFailed, TeamReadFailed } from "./team-read-failed";

type TeamRoutingSnapshot = {
  readonly policy: FallbackPolicy;
  readonly revision: number | null;
  readonly profiles: readonly {
    readonly key: string;
    readonly name: string;
    readonly enabled: boolean;
  }[];
};

export function TeamModelRouting(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const query = useConfigurationModelRoutingQuery();
  const read = useBoundedRead(query);
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  let editor: ReactNode = null;
  if (query.data !== undefined) {
    editor =
      query.data.revision === null ? (
        <TeamRoutingDefaults snapshot={query.data} onIssue={setIssue} />
      ) : (
        <FallbackConflictAnnouncementsProvider key={query.data.revision}>
          <TeamRoutingEditor snapshot={query.data} onIssue={setIssue} />
        </FallbackConflictAnnouncementsProvider>
      );
  }
  return (
    <SettingsPanelShell
      title="Model routing"
      description={
        personal
          ? "Applies to your agents on every computer and sandbox running Personal."
          : "How agents recover when an account or model cannot continue."
      }
      bodyClassName="flex flex-col gap-4 overflow-visible rounded-none border-none bg-transparent"
    >
      <ConfigurationWriteFeedback issue={issue} />
      {read.pending ? <MutedAgentSpinner /> : null}
      {read.failed ? (
        <ConfigurationReadFailed page="model routing" onRetry={read.retry} />
      ) : null}
      {editor}
    </SettingsPanelShell>
  );
}

/** A first team edit starts with real seeded tiers from the named host. */
function TeamRoutingDefaults(props: {
  readonly snapshot: TeamRoutingSnapshot;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const source = useConfigurationSource();
  const viewerId = useCloudChatViewerId();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const [picking, setPicking] = useState(false);
  const query = useHostQuery({
    client: scope.client,
    cacheKeyIdentity: [
      viewerId,
      source.kind === "pool" ? source.environmentId : "",
    ],
    method: "providers.fallbackPolicy.get",
    params: {},
    options: { enabled: scope.client !== null, staleTime: 0 },
  });
  if (
    scope.client !== null &&
    query.data !== undefined &&
    !query.data.storedPolicyUnreadable &&
    query.data.policy.tierGroups.length > 0
  ) {
    return (
      <FallbackConflictAnnouncementsProvider key={scope.viewingHost?.hostId}>
        <TeamRoutingEditor
          snapshot={{ ...props.snapshot, policy: query.data.policy }}
          onIssue={props.onIssue}
        />
      </FallbackConflictAnnouncementsProvider>
    );
  }
  let state: ReactNode = <MutedAgentSpinner />;
  if (scope.client === null) {
    state = (
      <TeamContentNeedsHost
        content="model-tiers"
        teamName={teamName}
        onPickHost={() => setPicking(true)}
      />
    );
  } else if (!query.isPending) {
    state = (
      <TeamReadFailed
        message="Couldn't read this host's default model tiers."
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <p className="text-ui-sm text-muted-foreground">
        Each host uses its default model tiers.
      </p>
      <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      {state}
    </section>
  );
}

function TeamRoutingEditor(props: {
  readonly snapshot: TeamRoutingSnapshot;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const scope = useTeamViewingHost();
  const { put, remove } = useConfigurationItemMutations();
  const isPending = put.isPending || remove.isPending;
  const [picking, setPicking] = useState(false);
  const [testing, setTesting] = useState(false);
  const panelId = useId();
  const testButton = useRef<HTMLButtonElement | null>(null);
  const [policy, setPolicy] = useState(props.snapshot.policy);
  const [groups, setGroups] = useState<readonly KeyedGroup[]>(() =>
    toKeyedGroups(props.snapshot.policy.tierGroups),
  );
  const [order, setOrder] = useState<readonly FallbackRungKind[]>(() => [
    ...policy.ladder,
    ...FALLBACK_RUNG_KINDS.filter((rung) => !policy.ladder.includes(rung)),
  ]);
  const preview = useConfigurationRoutingPreviewQuery(policy.tierGroups);
  const previewLine = useHostMethodSchemaVersion(
    scope.viewingHost?.hostId ?? null,
    "providers.fallbackPolicy.previewTierGroups",
  );
  const canSimulate =
    previewLine !== null &&
    ((previewLine.major === 1 && previewLine.minor >= 1) ||
      previewLine.major === 2);
  const catalog = useFallbackCatalogOptionsForClient(
    scope.client,
    policy.tierGroups,
  );
  const labelFor = (profileId: string): string =>
    props.snapshot.profiles.find((profile) =>
      profile.key.endsWith(`:${profileId}`),
    )?.name ?? "Unavailable account";
  const changed =
    JSON.stringify(policy) !== JSON.stringify(props.snapshot.policy);
  const valid =
    policy.tierGroups.length > 0 &&
    fallbackPolicySchema.safeParse(policy).success;
  const editGroups = (
    next: FallbackPolicy,
    nextGroups: readonly KeyedGroup[],
  ): void => {
    setPolicy(next);
    setGroups(nextGroups);
  };
  const restoreDefaults = (): void => {
    if (source.kind !== "pool") return;
    if (props.snapshot.revision === null) {
      const defaults = props.snapshot.policy;
      setPolicy(defaults);
      setGroups(toKeyedGroups(defaults.tierGroups));
      setOrder([...defaults.ladder]);
      return;
    }
    remove.mutate(
      {
        environmentId: source.environmentId,
        kind: "fallback_policy",
        key: "fallback",
        os: null,
        revision: props.snapshot.revision,
      },
      { onSuccess: (result) => props.onIssue(configurationWriteIssue(result)) },
    );
  };
  const save = (): void => {
    if (source.kind !== "pool") return;
    put.mutate(
      {
        environmentId: source.environmentId,
        kind: "fallback_policy",
        key: "fallback",
        os: null,
        value: { document: z.json().parse(policy) },
        revision: props.snapshot.revision,
      },
      { onSuccess: (result) => props.onIssue(configurationWriteIssue(result)) },
    );
  };
  const renderTestPanel = (
    goToRow: (tierIndex: number, candidateIndex: number) => void,
  ): ReactNode => (
    <TeamViewingHostBinding unavailable={null}>
      <FallbackTestModelPanel
        id={panelId}
        policy={policy}
        committedTiers={{
          tierGroups: policy.tierGroups,
          defaultTierGroupId: policy.defaultTierGroupId,
        }}
        catalog={catalog}
        conflicts={findTierConflicts(
          policy.tierGroups,
          catalog.catalogsByHarness,
        )}
        labelFor={labelFor}
        simulates={canSimulate}
        unsimulatedPreview={preview.data?.candidates ?? null}
        onClose={() => {
          setTesting(false);
          testButton.current?.focus();
        }}
        onGoToRow={goToRow}
      />
    </TeamViewingHostBinding>
  );
  if (!canEdit)
    return (
      <TeamRoutingReadOnly policy={policy} profiles={props.snapshot.profiles} />
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-sm font-medium">Route automatically</span>
        <Switch
          aria-label="Route automatically"
          checked={policy.enabled}
          disabled={isPending}
          onCheckedChange={(enabled) => setPolicy({ ...policy, enabled })}
        />
      </div>
      <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      {props.snapshot.revision === null ? (
        <p className="text-ui-xs text-muted-foreground">
          Each host uses its default model tiers.
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Accounts:{" "}
        {props.snapshot.profiles
          .filter((profile) => profile.enabled)
          .map((profile) => profile.name)
          .join(", ") || "None linked"}
        .
      </p>
      <fieldset disabled={isPending} className="flex min-w-0 flex-col gap-4">
        <FallbackLadderEditor
          displayOrder={order}
          enabled={new Set(policy.ladder)}
          profileStepHint={
            props.snapshot.profiles.filter((profile) => profile.enabled)
              .length < 2
              ? "Link another plan to switch accounts."
              : null
          }
          tierStepHint={null}
          onToggle={(rung, next) => {
            const enabled = new Set(policy.ladder);
            if (next) enabled.add(rung);
            else enabled.delete(rung);
            setPolicy({
              ...policy,
              ladder: [...fallbackLadderFrom(order, enabled)],
            });
          }}
          onMove={(from, to) => {
            const next = moveFallbackRung(order, from, to);
            setOrder(next);
            setPolicy({
              ...policy,
              ladder: [...fallbackLadderFrom(next, new Set(policy.ladder))],
            });
          }}
        />
        <FallbackBehaviorGroup
          policy={policy}
          onChange={setPolicy}
          status={null}
        />
        <FallbackTierGroupsEditor
          policy={policy}
          groups={groups}
          preview={preview.data?.candidates ?? null}
          labelFor={labelFor}
          catalog={catalog}
          patternsSupported
          conflicts={findTierConflicts(
            policy.tierGroups,
            catalog.catalogsByHarness,
          )}
          previewPending={preview.isFetching}
          previewUnavailable={preview.isError}
          onRetryPreview={() => void preview.refetch()}
          onChange={editGroups}
          onCommit={editGroups}
          onUndo={(inverse) => {
            const next = applyGroupsInverse(groups, inverse);
            setGroups(next);
            setPolicy({
              ...policy,
              tierGroups: next.map((group) => ({
                id: group.id,
                candidates: group.candidates.map(
                  (candidate) => candidate.value,
                ),
              })),
            });
          }}
          onRestoreDefaults={restoreDefaults}
          restorePending={remove.isPending}
          status={null}
          headerAction={
            <FallbackTestModelButton
              offered={scope.client !== null && canSimulate}
              open={testing}
              panelId={panelId}
              buttonRef={testButton}
              onToggle={() => setTesting(!testing)}
            />
          }
          testPanel={testing ? renderTestPanel : null}
        />
        <FallbackOverridesMatrix
          policy={policy}
          rungOrder={order}
          onChange={setPolicy}
          onReset={(reason) =>
            setPolicy(
              reason === null
                ? clearPolicyOverrides(policy)
                : clearPolicyOverride(policy, reason),
            )
          }
          onUndo={() => {}}
          undo={null}
          attentionReason={null}
          previewUnconfirmed={false}
          status={null}
        />
      </fieldset>
      <TeamRoutingSave
        valid={valid}
        changed={changed}
        isPending={isPending}
        onReset={restoreDefaults}
        onSave={save}
      />
    </div>
  );
}

function TeamRoutingReadOnly(props: {
  readonly policy: FallbackPolicy;
  readonly profiles: TeamRoutingSnapshot["profiles"];
}): ReactNode {
  const policy = props.policy;
  return (
    <section className="flex flex-col gap-3 text-ui-sm">
      <p>Route automatically: {policy.enabled ? "On" : "Off"}</p>
      <p>Try these in order: {policy.ladder.join(" → ")}</p>
      <p>
        Time to cancel: {policy.graceWindowSeconds} seconds. Maximum wait:{" "}
        {policy.maxWaitMinutes} minutes.
      </p>
      <p>Return to preferred: {policy.returnToPreferred}.</p>
      <p>
        Accounts:{" "}
        {props.profiles.map((profile) => profile.name).join(", ") || "None"}.
      </p>
      {policy.tierGroups.map((group) => (
        <div key={group.id}>
          <h3 className="font-medium">{group.id}</h3>
          {group.candidates.map((candidate) => (
            <p
              key={`${candidate.harnessId}:${candidate.modelFamily}:${candidate.reasoningEffort}`}
            >
              {candidate.harnessId} · {candidate.modelFamily} ·{" "}
              {candidate.reasoningEffort}
            </p>
          ))}
        </div>
      ))}
      {Object.entries(policy.reasonOverrides ?? {}).map(([reason, value]) => (
        <p key={reason}>
          {reason}: {value === "off" ? "Off" : value.join(" → ")}
        </p>
      ))}
    </section>
  );
}

function TeamRoutingSave(props: {
  readonly valid: boolean;
  readonly changed: boolean;
  readonly isPending: boolean;
  readonly onReset: () => void;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <>
      {!props.valid ? (
        <p role="status" className="text-ui-xs text-warning-foreground">
          Complete the model routing settings before saving.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.isPending}
          onClick={props.onReset}
        >
          Reset to default
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!props.changed || !props.valid || props.isPending}
          onClick={props.onSave}
        >
          Save{props.isPending ? <MutedAgentSpinner /> : null}
        </Button>
      </div>
    </>
  );
}
