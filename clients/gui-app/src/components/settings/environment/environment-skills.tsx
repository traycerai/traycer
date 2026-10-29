import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  ENVIRONMENT_SKILL_READ_ONLY_REASON,
  type EnvironmentConfigurationSkillsListResponseV11,
  type EnvironmentConfigurationSkillsStateResponse,
  type EnvironmentConfigurationSkillSetPolicyResponse,
  type EnvironmentConfigurationSkillUpdateResponse,
  type EnvironmentConfigurationSkillRestoreBundledResponse,
  type EnvironmentSkillPolicy,
  type EnvironmentSkillV11,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ProviderSkillDetailDialog } from "@/components/settings/panels/provider-skill-detail-dialog";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { useConfigurationReadClient } from "@/hooks/environment/team/use-configuration-read-client";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import {
  useEnvironmentSkillHostMutations,
  useEnvironmentSkillMutations,
  useEnvironmentSkillsQuery,
  useEnvironmentSkillsStateQuery,
} from "@/hooks/environment/team/use-environment-skills";
import { isProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { fileContentRevision } from "@/lib/workspace/file-content-revision";
import type { HostRpcRegistry } from "@/lib/host";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";
import { useConfigurationName } from "./mcp-servers-model";
import {
  AUTO_UPDATE_LABEL,
  BUILT_IN_SKILL_LINE,
  CHECK_SKILL_UPDATES_LABEL,
  DELETED_BUILT_INS_HEADING,
  EVOLVE_LABEL,
  IMPORT_SKILL_LABEL,
  READ_ONLY_EDIT_REFUSAL,
  skillRemovedLine,
  REMOVE_SKILL_LABEL,
  RESTORE_SKILL_LABEL,
  SKILL_POLICIES_LINE,
  SKILL_POLICY_LABELS,
  SKILL_SWITCHES_UNAVAILABLE,
  SKILL_UPDATE_AVAILABLE,
  SKILL_UPDATE_NOW_LABEL,
  autoUpdateDescription,
  autoUpdateTitle,
  evolveDescription,
  evolveTitle,
  providersPhrase,
  removeSkillReach,
  removeTitle,
  skillPageLine,
  skillSourcePhrase,
  skillUpstreamLine,
  skillWriteRefusal,
  skillsCardHeading,
  skillsPageSubtitle,
  skillsReadFailed,
  updateDescription,
  updateTitle,
} from "./mcp-skills-copy";
import { OnHostOnlySkills } from "./on-host-only-entries";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { TeamReadFailed } from "./team-read-failed";
import { TeamSkillUpload } from "./team-skill-upload";
import { TeamSkills } from "./team-skills";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import { EnvironmentSkillImportDialog } from "./environment-skill-import-dialog";
import {
  typedWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";

/**
 * The providers on the viewing host that list skills at global scope, in
 * rail order; every provider when no host answers.
 */
function useSkillProviders(): readonly ProviderId[] {
  const scope = useTeamViewingHost();
  const catalog = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const capable = catalog.data?.providers
    .filter(
      (state) =>
        state.nativeCapabilities.skills?.actionScopes.list.includes(
          "global",
        ) === true,
    )
    .map((state) => state.providerId);
  return ORDERED_PROVIDERS.map((provider) => provider.providerId).filter(
    (id) => capable === undefined || capable.includes(id),
  );
}

/**
 * The configuration's skills from its room, and which of its writes the
 * serving tier takes: each is offered only once that tier advertised it.
 * `TeamSkills` is drawn for a serving tier that predates the list.
 */
function useServedSkills() {
  const scope = useTeamViewingHost();
  const readClient = useConfigurationReadClient();
  const servingHostId = readClient.getActiveHostId();
  const listVersion = useHostNegotiatedMethodVersion(
    readClient,
    "environment.configuration.skills.list",
  );
  const switchesVersion = useHostNegotiatedMethodVersion(
    readClient,
    "environment.configuration.skills.setProviders",
  );
  const removable = useHostSupportsMethod(
    servingHostId,
    "environment.configuration.skills.remove",
  );
  const uploadable = useHostSupportsMethod(
    servingHostId,
    "environment.configuration.skills.upload",
  );
  const policiesSettable = useHostSupportsMethod(
    servingHostId,
    "environment.configuration.skills.setPolicy",
  );
  // An update and a restore write the viewing host's own build's skills.
  const viewingHostId = scope.viewingHost?.hostId ?? null;
  const updatable = useHostSupportsMethod(
    viewingHostId,
    "environment.configuration.skills.update",
  );
  const restorable = useHostSupportsMethod(
    viewingHostId,
    "environment.configuration.skills.restoreBundled",
  );
  const importable = useHostSupportsMethod(
    viewingHostId,
    "environment.configuration.skills.import",
  );
  const searchable = useHostSupportsMethod(
    viewingHostId,
    "environment.configuration.skills.search",
  );
  // What only the serving host knows (an update available, the built-ins
  // it can restore), read beside the room's list: a pool knows neither.
  const stateReadable = useHostSupportsMethod(
    viewingHostId,
    "environment.configuration.skills.state",
  );
  const listed = listVersion !== null && listVersion !== false;
  const query = useEnvironmentSkillsQuery(readClient, listed);
  const state = useEnvironmentSkillsStateQuery(
    scope.client,
    listed && stateReadable,
  );
  return {
    scope,
    listVersion,
    query,
    state: state.data,
    stateReadable,
    importable,
    searchable,
    switchesAvailable: switchesVersion !== null && switchesVersion !== false,
    removable,
    uploadable,
    policiesSettable,
    updatable,
    restorable,
  };
}

export function EnvironmentSkillsPage(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  // Keyed by configuration: a draft or a write's outcome stays with the
  // configuration it was made in.
  const configurationKey = useConfigurationKey();
  return (
    <SettingsPanelShell
      title="Skills"
      description={skillsPageSubtitle(personal, name)}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <EnvironmentSkills key={configurationKey} providerId={null} />
    </SettingsPanelShell>
  );
}

/**
 * The configuration's skills, once each: on the page (`providerId` null) with
 * the providers that use each, Preview or Edit and Remove; on a provider's
 * tab with that provider's switch.
 */
function EnvironmentSkills(props: {
  readonly providerId: ProviderId | null;
}): ReactNode {
  const served = useServedSkills();
  const viewerId = useCloudChatViewerId();
  const configurationKey = useConfigurationKey();
  const name = useConfigurationName();
  const canEdit = useCanEditConfiguration();
  const canRemove = canEdit && served.removable;
  const [picking, setPicking] = useState(false);
  const noHost = (
    <TeamContentNeedsHost
      content="skills"
      teamName={name}
      onPickHost={() => setPicking(true)}
    />
  );
  const picker = (
    <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
  );
  // Listing and the writes go through the room; Preview and Edit read the
  // skill's files where a picked host projects them.
  const hosted =
    served.scope.client !== null && served.scope.viewingHost !== null;
  if (served.listVersion === null) return <MutedAgentSpinner />;
  if (served.listVersion === false)
    return hosted ? (
      <TeamSkills providerId={props.providerId} />
    ) : (
      <TeamReadFailed
        message={skillsReadFailed(name)}
        onRetry={() => void served.query.refetch()}
      />
    );
  const { query } = served;
  if (query.isPending) return <MutedAgentSpinner />;
  if (query.isError)
    return (
      <TeamReadFailed
        message={skillsReadFailed(name)}
        onRetry={() => void query.refetch()}
      />
    );
  if (query.data.outcome === "not_served")
    return (
      <section className="flex flex-col gap-3">
        {picker}
        {noHost}
      </section>
    );
  const { skills, revision } = query.data;
  // An editor checks sources and imports on the viewing host, which only a
  // picked host offers.
  const checkable: boolean = canEdit && hosted && served.stateReadable;
  const importable: boolean = hosted && served.importable;
  const list =
    props.providerId === null ? (
      <SkillsPageList
        listed={withServedState(query.data, served.state)}
        checkable={checkable}
        canEdit={canEdit}
        canRemove={canRemove}
        switchesAvailable={served.switchesAvailable}
        hosted={hosted}
        policiesSettable={served.policiesSettable}
        updatable={served.updatable}
        restorable={served.restorable}
        hostClient={served.scope.client}
        reread={async () => {
          const reread = await query.refetch();
          return reread.data?.outcome === "listed" ? reread.data : null;
        }}
      />
    ) : (
      <ProviderSkillsList
        key={JSON.stringify([viewerId, configurationKey, props.providerId])}
        providerId={props.providerId}
        skills={skills}
        revision={revision}
        canEdit={canEdit}
        switchesAvailable={served.switchesAvailable}
        hosted={hosted}
      />
    );
  return (
    <section className="flex flex-col gap-3">
      {picker}
      {hosted ? (
        <TeamViewingHostBinding unavailable={noHost}>
          {list}
        </TeamViewingHostBinding>
      ) : (
        list
      )}
      {props.providerId === null && canEdit ? (
        <AddSkill
          uploadable={served.uploadable}
          importable={importable}
          searchable={served.searchable}
          hostClient={served.scope.client}
          onNotServed={() => setPicking(true)}
        />
      ) : null}
    </section>
  );
}

/**
 * The page's ways to add a skill: an archive upload through the serving
 * tier and, beside it, an import from a source on the viewing host.
 */
function AddSkill(props: {
  readonly uploadable: boolean;
  readonly importable: boolean;
  /** The import offers a search of the public skills directory. */
  readonly searchable: boolean;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly onNotServed: () => void;
}): ReactNode {
  const [importing, setImporting] = useState(false);
  const importAction = props.importable ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setImporting(true)}
    >
      {IMPORT_SKILL_LABEL}
    </Button>
  ) : null;
  return (
    <>
      {props.uploadable ? (
        <TeamSkillUpload
          onNotServed={props.onNotServed}
          importAction={importAction}
        />
      ) : (
        importAction
      )}
      {importing ? (
        <EnvironmentSkillImportDialog
          hostClient={props.hostClient}
          searchable={props.searchable}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The room's list with what the serving host answered over it: each
 * skill's version and whether an update is available, and the built-ins it
 * can restore. The list stands as it is while the host has not answered.
 */
function withServedState(
  listed: ListedSkills,
  state: EnvironmentConfigurationSkillsStateResponse | undefined,
): ListedSkills {
  if (state === undefined || state.outcome !== "listed") return listed;
  const byName = new Map(state.skills.map((skill) => [skill.name, skill]));
  return {
    ...listed,
    skills: listed.skills.map((skill) => {
      const served = byName.get(skill.name);
      return served === undefined
        ? skill
        : {
            ...skill,
            version: served.version ?? skill.version,
            updateAvailable: served.updateAvailable,
          };
    }),
    deletedBundled: state.deletedBundled,
  };
}

type ListedSkills = Extract<
  EnvironmentConfigurationSkillsListResponseV11,
  { readonly outcome: "listed" }
>;

/** A policy, update or restore answer as the page's issue. */
function skillWriteIssue(
  result:
    | EnvironmentConfigurationSkillSetPolicyResponse
    | EnvironmentConfigurationSkillUpdateResponse
    | EnvironmentConfigurationSkillRestoreBundledResponse,
  failedLine: string,
): ConfigurationWriteIssue {
  switch (result.outcome) {
    case "saved":
    case "applied":
    case "nothing_to_apply":
    case "restored":
      return null;
    case "stale":
      return { kind: "conflict", changedBy: null };
    case "forbidden":
      return { kind: "forbidden" };
    case "not_served":
      return { kind: "refused", line: failedLine };
    case "refused":
      return {
        kind: "refused",
        line: skillWriteRefusal(result.reason, failedLine),
      };
  }
}

/** A choice that needs a confirm before it is sent. */
type PendingSkillChoice =
  | {
      readonly kind: "policy";
      readonly skill: EnvironmentSkillV11;
      readonly policy: EnvironmentSkillPolicy;
      /** The policies' revision the choice was read against. */
      readonly revision: string | null;
    }
  | { readonly kind: "update"; readonly skill: EnvironmentSkillV11 };

/** Stopping a skill's updates, and replacing a person's changes, are each confirmed first. */
function policyNeedsConfirm(
  skill: EnvironmentSkillV11,
  policy: EnvironmentSkillPolicy,
): boolean {
  return (
    (policy === "evolve" && skill.policy === "auto-update") ||
    (policy === "auto-update" && skill.edited)
  );
}

function SkillsPageList(props: {
  readonly listed: ListedSkills;
  /** The viewing host checks each skill's source again on asking. */
  readonly checkable: boolean;
  /** May change the configuration's skills: their policies included. */
  readonly canEdit: boolean;
  /** May remove one: `canEdit` on a serving tier that removes skills. */
  readonly canRemove: boolean;
  readonly switchesAvailable: boolean;
  /** Whether a viewing host serves Preview and Edit; the list needs none. */
  readonly hosted: boolean;
  /** The serving tier sets policies; an older one shows none. */
  readonly policiesSettable: boolean;
  /** The viewing host updates a skill and restores a built-in. */
  readonly updatable: boolean;
  readonly restorable: boolean;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /** Lists again: the answer, or `null` when it is not a list. */
  readonly reread: () => Promise<ListedSkills | null>;
}): ReactNode {
  const providers = useSkillProviders();
  const source = useConfigurationSource();
  const name = useConfigurationName();
  const readClient = useConfigurationReadClient();
  const { remove, setPolicy } = useEnvironmentSkillMutations(readClient);
  const { update, restoreBundled, checkUpdates } =
    useEnvironmentSkillHostMutations(props.hostClient);
  // The open detail follows its row in the list as it is read again: its
  // version and Update now, after an update or anyone else's change.
  const [openName, setOpenName] = useState<string | null>(null);
  // Moves when a write replaced skill files, so an open detail reads them again.
  const [contentEpoch, setContentEpoch] = useState(0);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [removing, setRemoving] = useState<EnvironmentSkillV11 | null>(null);
  const [pending, setPending] = useState<PendingSkillChoice | null>(null);
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  // A list read this page awaits before it acts on the answer: nothing else
  // starts meanwhile, so that answer never lands over a newer action's.
  const [rereading, setRereading] = useState(false);
  const { skills, deletedBundled } = props.listed;
  const open = rowNamed(skills, openName);
  // A detail holding unsaved changes stays open on the last row it showed
  // when its skill leaves the list (another editor removed it); a clean one
  // closes with it.
  const [draftHeld, setDraftHeld] = useState(false);
  const detailSkill = useLastRow(open, draftHeld);
  const removeIssue =
    remove.data === undefined
      ? null
      : typedWriteIssue(remove.data, "Couldn't remove this skill.");
  const writing =
    setPolicy.isPending ||
    update.isPending ||
    restoreBundled.isPending ||
    rereading;

  const whileRereading = <T,>(work: () => Promise<T>): Promise<T> => {
    setRereading(true);
    return work().finally(() => setRereading(false));
  };

  const savePolicy = async (
    skill: EnvironmentSkillV11,
    policy: EnvironmentSkillPolicy,
    revision: string | null,
  ): Promise<void> => {
    if (source.kind !== "pool") return;
    const failed = "Couldn't save this skill's updates setting.";
    const request = {
      environmentId: source.environmentId,
      name: skill.name,
      policy,
    };
    try {
      let result = await setPolicy.mutateAsync({ ...request, revision });
      // Another write moved the policies: list again, and send once more
      // only as the skill stands now. Already holding the choice needs
      // nothing; a change that now replaces edits or stops updates asks
      // first, as a choice from the row does.
      if (result.outcome === "stale") {
        const fresh = await whileRereading(props.reread);
        const row = fresh?.skills.find((entry) => entry.name === skill.name);
        if (fresh === null || row === undefined) {
          setIssue({ kind: "conflict", changedBy: null });
          return;
        }
        if (row.policy === policy) {
          setIssue(null);
          return;
        }
        if (policyNeedsConfirm(row, policy)) {
          setPending({
            kind: "policy",
            skill: row,
            policy,
            revision: fresh.policyRevision,
          });
          return;
        }
        result = await setPolicy.mutateAsync({
          ...request,
          revision: fresh.policyRevision,
        });
      }
      setIssue(skillWriteIssue(result, failed));
    } catch {
      // The mutation's own error handling has told the person.
    }
  };

  const choosePolicy = (
    skill: EnvironmentSkillV11,
    policy: EnvironmentSkillPolicy,
  ): void => {
    const revision = props.listed.policyRevision;
    if (policyNeedsConfirm(skill, policy)) {
      setPending({ kind: "policy", skill, policy, revision });
      return;
    }
    void savePolicy(skill, policy, revision);
  };

  // The skill's files were replaced: list again, so a detail shows the
  // version it holds now, then read its files again from where the list is.
  const rereadContent = (): Promise<void> =>
    whileRereading(async () => {
      await props.reread();
      setContentEpoch((value) => value + 1);
    });

  const runUpdate = (skill: EnvironmentSkillV11, confirm: boolean): void => {
    if (source.kind !== "pool") return;
    update.mutate(
      { environmentId: source.environmentId, name: skill.name, confirm },
      {
        onSuccess: (result) => {
          // Changes the page did not know of: confirm before replacing them.
          if (
            !confirm &&
            result.outcome === "refused" &&
            result.reason === "has_edits"
          ) {
            setPending({ kind: "update", skill });
            return;
          }
          setPending(null);
          setIssue(skillWriteIssue(result, "Couldn't update this skill."));
          if (result.outcome === "applied") void rereadContent();
        },
      },
    );
  };

  // A person's changes go only on a confirm, under evolve and frozen alike.
  const requestUpdate = (skill: EnvironmentSkillV11): void => {
    if (skill.edited) setPending({ kind: "update", skill });
    else runUpdate(skill, false);
  };

  const restore = (skillName: string): void => {
    if (source.kind !== "pool") return;
    restoreBundled.mutate(
      { environmentId: source.environmentId, name: skillName },
      {
        onSuccess: (result) => {
          setIssue(skillWriteIssue(result, "Couldn't restore this skill."));
          if (result.outcome === "restored") void rereadContent();
        },
      },
    );
  };

  const canUpdate = (skill: EnvironmentSkillV11): boolean =>
    props.canEdit && props.hosted && props.updatable && skill.updateAvailable;

  return (
    <>
      {skills.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          Skills give agents instructions for a kind of task.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-ui-sm font-medium">Skills</h3>
            {props.checkable &&
            skills.some((skill) => skill.upstream !== null) ? (
              <Button
                type="button"
                variant="link"
                size="inline-xs"
                disabled={checkUpdates.isPending}
                onClick={() => {
                  if (source.kind !== "pool") return;
                  checkUpdates.mutate({
                    environmentId: source.environmentId,
                    refresh: true,
                  });
                }}
              >
                {CHECK_SKILL_UPDATES_LABEL}
                {checkUpdates.isPending ? <MutedAgentSpinner /> : null}
              </Button>
            ) : null}
          </div>
          {props.policiesSettable ? (
            <p className="text-ui-xs text-muted-foreground">
              {SKILL_POLICIES_LINE}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2" aria-label="Skills">
            {skills.map((skill) => {
              const using = props.switchesAvailable
                ? providers.filter((id) => !skill.offFor.includes(id))
                : providers;
              return (
                <li
                  key={skill.name}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-ui-sm font-medium">
                        {skill.name}
                      </span>
                      {skill.updateAvailable ? (
                        <Badge variant="info">{SKILL_UPDATE_AVAILABLE}</Badge>
                      ) : null}
                    </div>
                    {skill.upstream === null ? null : (
                      <div className="truncate text-ui-xs text-muted-foreground">
                        {skillUpstreamLine(
                          skill.upstream.source,
                          skill.upstream.ref,
                        )}
                      </div>
                    )}
                    {skill.description === null ? null : (
                      <div className="truncate text-ui-xs text-muted-foreground">
                        {skill.description}
                      </div>
                    )}
                    <div className="text-ui-xs text-muted-foreground">
                      {skillPageLine(
                        skill.origin,
                        skill.version,
                        providersPhrase(
                          using.map((id) => providerDisplayName(id)),
                          providers.length,
                        ),
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {props.policiesSettable ? (
                      <SettingsSegmentedControl
                        value={skill.policy}
                        options={policyOptions(skill)}
                        ariaLabel={`Updates for ${skill.name}`}
                        disabled={!props.canEdit || writing}
                        onChange={(next) => choosePolicy(skill, next)}
                      />
                    ) : null}
                    {canUpdate(skill) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={writing}
                        onClick={() => requestUpdate(skill)}
                      >
                        {SKILL_UPDATE_NOW_LABEL}
                        {update.isPending &&
                        update.variables.name === skill.name ? (
                          <MutedAgentSpinner />
                        ) : null}
                      </Button>
                    ) : null}
                    {props.hosted ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpenName(skill.name)}
                      >
                        {editable(props.canEdit, skill) ? "Edit" : "Preview"}
                      </Button>
                    ) : null}
                    {/* A removed built-in comes back from Deleted built-ins. */}
                    {props.canRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => setRemoving(skill)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ConfigurationWriteFeedback issue={removeIssue} />
      <ConfigurationWriteFeedback issue={issue} />
      {deletedBundled.length === 0 ? null : (
        <Collapsible open={deletedOpen} onOpenChange={setDeletedOpen}>
          <CollapsibleTrigger variant="quiet" className="text-ui-xs">
            {DELETED_BUILT_INS_HEADING}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul
              className="flex flex-col gap-2 pt-2"
              aria-label={DELETED_BUILT_INS_HEADING}
            >
              {deletedBundled.map((skillName) => (
                <li
                  key={skillName}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 truncate text-ui-sm">
                    {skillName}
                  </span>
                  {props.canEdit && props.hosted && props.restorable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={writing}
                      onClick={() => restore(skillName)}
                    >
                      {RESTORE_SKILL_LABEL}
                      {restoreBundled.isPending &&
                      restoreBundled.variables.name === skillName ? (
                        <MutedAgentSpinner />
                      ) : null}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {removing === null ? null : (
        <RemoveSkillDialog
          skill={removing}
          pending={remove.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            if (source.kind !== "pool") return;
            remove.mutate(
              { environmentId: source.environmentId, name: removing.name },
              { onSettled: () => setRemoving(null) },
            );
          }}
        />
      )}
      {pending === null ? null : (
        <SkillChoiceDialog
          choice={pending}
          pending={setPolicy.isPending || update.isPending}
          onClose={() => setPending(null)}
          onConfirm={() => {
            if (pending.kind === "update") {
              runUpdate(pending.skill, true);
              return;
            }
            setPending(null);
            void savePolicy(pending.skill, pending.policy, pending.revision);
          }}
        />
      )}
      {detailSkill === null ? null : (
        <EnvironmentSkillDetail
          skill={detailSkill}
          removed={open === null}
          configuration={name}
          providerId={providers.at(0) ?? "claude-code"}
          canEdit={editable(props.canEdit, detailSkill)}
          canUpdate={canUpdate(detailSkill)}
          updatePending={update.isPending}
          actionsDisabled={writing}
          contentEpoch={contentEpoch}
          draftHeld={draftHeld}
          onDraftHeldChange={setDraftHeld}
          onRequestUpdate={() => requestUpdate(detailSkill)}
          onClose={() => setOpenName(null)}
        />
      )}
    </>
  );
}

/**
 * `row` while there is one; once it is gone, the last one seen while `keep`
 * holds, so a detail with unsaved changes outlives its row.
 */
function useLastRow<Row>(row: Row | null, keep: boolean): Row | null {
  const [last, setLast] = useState<Row | null>(row);
  if (row !== null && row !== last) setLast(row);
  return row ?? (keep ? last : null);
}

/** The row of the skill named `name`; `null` when none is named or the list no longer holds it. */
function rowNamed(
  skills: readonly EnvironmentSkillV11[],
  name: string | null,
): EnvironmentSkillV11 | null {
  if (name === null) return null;
  return skills.find((skill) => skill.name === name) ?? null;
}

/**
 * The policies a skill can take: Auto-update only for one with something to
 * follow, a built-in or a skill from a source.
 */
function policyOptions(skill: EnvironmentSkillV11): ReadonlyArray<{
  readonly value: EnvironmentSkillPolicy;
  readonly label: string;
}> {
  const follows = skill.origin === "bundled" || skill.upstream !== null;
  return (["auto-update", "evolve", "frozen"] as const)
    .filter((policy) => follows || policy !== "auto-update")
    .map((policy) => ({ value: policy, label: SKILL_POLICY_LABELS[policy] }));
}

/** What a choice's confirm says. */
function choiceWords(choice: PendingSkillChoice): {
  readonly title: string;
  readonly description: string;
  readonly action: string;
} {
  const skill = choice.skill.name;
  if (choice.kind === "update")
    return {
      title: updateTitle(skill),
      description: updateDescription(skill),
      action: SKILL_UPDATE_NOW_LABEL,
    };
  if (choice.policy === "evolve")
    return {
      title: evolveTitle(skill),
      description: evolveDescription(skill),
      action: EVOLVE_LABEL,
    };
  return {
    title: autoUpdateTitle(skill),
    description: autoUpdateDescription(skill),
    action: AUTO_UPDATE_LABEL,
  };
}

/** The confirm a policy change or an update asks for, and what it says. */
function SkillChoiceDialog(props: {
  readonly choice: PendingSkillChoice;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const words = choiceWords(props.choice);
  return (
    <ConfirmDestructiveDialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      title={words.title}
      description={words.description}
      cascadeSummary={null}
      actionLabel={words.action}
      isPending={props.pending}
      blockedReason={null}
      onConfirm={props.onConfirm}
    />
  );
}

function RemoveSkillDialog(props: {
  readonly skill: EnvironmentSkillV11;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  return (
    <ConfirmDestructiveDialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      title={removeTitle(props.skill.name)}
      description={removeSkillReach(personal, name, props.skill.name)}
      cascadeSummary={null}
      actionLabel={REMOVE_SKILL_LABEL}
      isPending={props.pending}
      blockedReason={null}
      onConfirm={props.onConfirm}
    />
  );
}

/**
 * Only an `evolve` skill is edited in place, a built-in included; any other
 * is previewed, and its policy control is the way to make it editable.
 */
function editable(canEdit: boolean, skill: EnvironmentSkillV11): boolean {
  return canEdit && skill.policy === "evolve";
}

/** Where a skill's version comes from, as the detail's Source row says it. */
function skillOriginLine(skill: EnvironmentSkillV11): string | null {
  let from: string;
  if (skill.upstream !== null) from = `Imported from ${skill.upstream.source}`;
  else if (skill.origin === "bundled") from = "Built-in";
  else return null;
  return skill.version === null ? from : `${from} · ${skill.version}`;
}

/**
 * One skill's files, read and edited where the viewing host projects the
 * configuration's skills: the row a provider lists for it there. An edit
 * there reaches the configuration like any change in its skills.
 */
function EnvironmentSkillDetail(props: {
  readonly skill: EnvironmentSkillV11;
  /** Another editor removed it while this detail held unsaved changes. */
  readonly removed: boolean;
  readonly configuration: string;
  readonly providerId: ProviderId;
  readonly canEdit: boolean;
  readonly canUpdate: boolean;
  readonly updatePending: boolean;
  /**
   * The page is writing or rereading what a write changed (an update or a
   * restore replacing files included): no edit or second update starts
   * meanwhile, so no draft is lost and no answer lands over a newer one.
   */
  readonly actionsDisabled: boolean;
  /** Moves when an update or a restore replaced the skill's files. */
  readonly contentEpoch: number;
  /** The dialog holds unsaved changes: it stays through its files leaving. */
  readonly draftHeld: boolean;
  readonly onDraftHeldChange: (held: boolean) => void;
  readonly onRequestUpdate: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const name = props.configuration;
  const list = useProvidersSkillsList({
    providerId: props.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: true,
  });
  const mutate = useProvidersSkillsMutate();
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const row = useLastRow(
    list.data?.skills.find(
      (skill) => skill.source === "managed" && skill.name === props.skill.name,
    ) ?? null,
    props.draftHeld,
  );
  // Edit or Preview opens on this second read, so it says where that read
  // is rather than opening nothing.
  if (list.isError && !list.isFetching && row === null)
    return (
      <TeamReadFailed
        message="Couldn't read this skill's files."
        onRetry={() => void list.refetch()}
      />
    );
  if (list.data === undefined && row === null) return <MutedAgentSpinner />;
  if (row === null)
    return (
      <TeamReadFailed
        message="Couldn't find this skill's files."
        onRetry={() => void list.refetch()}
      />
    );
  return (
    <ProviderSkillDetailDialog
      skill={row}
      // The provider lists the configuration's skills as its managed ones;
      // the badge names the source as this page does.
      sourceLabel={skillSourcePhrase(props.skill.origin, name)}
      removal={{ kind: "hidden" }}
      removePending={false}
      // The flag disables Edit and Update too; Remove is not offered here.
      removeDisabled={props.actionsDisabled}
      actionError={error}
      lockedNote={null}
      // A removed skill takes no edit or update: its draft can be discarded.
      canEdit={props.canEdit ? !props.removed : false}
      // A draft open when the skill turns read-only, or leaves, stays, Save off.
      editRevokedNote={
        props.removed ? skillRemovedLine(name) : READ_ONLY_EDIT_REFUSAL
      }
      onDraftHeldChange={props.onDraftHeldChange}
      canUpdate={props.canUpdate ? !props.removed : false}
      origin={skillOriginLine(props.skill)}
      updatePending={props.updatePending}
      editPending={mutate.isPending}
      onStartEdit={() => setError(null)}
      onSave={(target) =>
        fileContentRevision(target.baseline)
          .then((expectedHash) =>
            mutate.mutateAsync({
              providerId: props.providerId,
              environmentId:
                source.kind === "pool" ? source.environmentId : null,
              scope: "global",
              workspaceRoot: null,
              mutation: {
                action: "edit",
                path: target.path,
                expectedHash,
                name: target.name,
                description: target.description,
                body: target.body,
              },
              suppressToast: true,
            }),
          )
          .then(() => {
            setEpoch((value) => value + 1);
            return true;
          })
          .catch((error: unknown) => {
            // The host refuses an edit its policy takes none of.
            setError(
              isProviderNativeRpcError(error) &&
                error.nativeDetail === ENVIRONMENT_SKILL_READ_ONLY_REASON
                ? READ_ONLY_EDIT_REFUSAL
                : "Couldn't edit this skill.",
            );
            return false;
          })
      }
      onRequestUpdate={props.onRequestUpdate}
      onRequestRemove={() => undefined}
      onClose={props.onClose}
      // Either move reads the files again: this dialog's edit, or a write
      // that replaced them; so does the listed version moving under the
      // open detail, another editor's update or restore.
      fileEpoch={epoch + props.contentEpoch}
      contentVersion={props.skill.version}
    />
  );
}

/**
 * The OpenCode family runs on one generated config, so it shares one skills
 * list: the host switches the four together, and so does the tab.
 */
const OPENCODE_FAMILY: readonly ProviderId[] = [
  "opencode",
  "traycer",
  "openrouter",
  "huggingface",
];

function skillSwitchGroup(providerId: ProviderId): readonly ProviderId[] {
  return OPENCODE_FAMILY.includes(providerId) ? OPENCODE_FAMILY : [providerId];
}

/**
 * A provider's Skills tab on Personal or a team: the configuration's skills
 * with this provider's switch (drawn disabled until the serving host switches
 * skills per provider), then what the provider holds on the viewing host by
 * itself.
 */
export function EnvironmentProviderSkillsTab(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const configurationKey = useConfigurationKey();
  return (
    <EnvironmentSkills key={configurationKey} providerId={props.providerId} />
  );
}

interface PendingSkillSwitch {
  readonly name: string;
  readonly offFor: readonly string[];
  readonly revision: string | null;
  readonly accepted: boolean;
}

function ProviderSkillsList(props: {
  readonly providerId: ProviderId;
  readonly skills: readonly EnvironmentSkillV11[];
  readonly revision: string | null;
  readonly canEdit: boolean;
  readonly switchesAvailable: boolean;
  /** Whether a viewing host lists what the provider holds by itself. */
  readonly hosted: boolean;
}): ReactNode {
  const source = useConfigurationSource();
  const name = useConfigurationName();
  const { setProviders } = useEnvironmentSkillMutations(
    useConfigurationReadClient(),
  );
  const [pending, setPending] = useState<PendingSkillSwitch | null>(null);
  // A same-revision read may still lag the accepted write. A moved revision
  // settles it even if another member removed the skill or switched it again.
  const settled =
    pending !== null &&
    pending.accepted &&
    (props.revision !== pending.revision ||
      props.skills.some(
        (skill) =>
          skill.name === pending.name &&
          skill.offFor.length === pending.offFor.length &&
          skill.offFor.every((provider) => pending.offFor.includes(provider)),
      ));
  if (settled) setPending(null);
  const switchIssue =
    setProviders.data === undefined
      ? null
      : typedWriteIssue(setProviders.data, "Couldn't save these settings.");
  const label = providerDisplayName(props.providerId);
  const heading = skillsCardHeading(name, label);
  return (
    <div className="flex flex-col gap-4">
      <section
        className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        aria-label={heading}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui-sm font-medium">{heading}</h3>
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            onClick={() => navigateToSettingsSection("skills")}
          >
            Manage skills
          </Button>
        </div>
        {props.switchesAvailable ? null : (
          <p className="text-ui-xs text-muted-foreground">
            {SKILL_SWITCHES_UNAVAILABLE}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {props.skills.map((skill) => {
            const offFor =
              pending?.name === skill.name ? pending.offFor : skill.offFor;
            const uses = !offFor.includes(props.providerId);
            return (
              <li
                key={skill.name}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-ui-sm">{skill.name}</div>
                  <div className="text-ui-xs text-muted-foreground">
                    {skillSourcePhrase(skill.origin, name)}
                  </div>
                  {skill.origin === "bundled" ? (
                    <div className="text-ui-xs text-muted-foreground">
                      {BUILT_IN_SKILL_LINE}
                    </div>
                  ) : null}
                </div>
                <Switch
                  aria-label={`${skill.name} for ${label}`}
                  checked={props.switchesAvailable ? uses : true}
                  disabled={
                    !props.switchesAvailable ||
                    !props.canEdit ||
                    setProviders.isPending ||
                    pending !== null
                  }
                  onCheckedChange={(next) => {
                    if (source.kind !== "pool") return;
                    const group = skillSwitchGroup(props.providerId);
                    const others = skill.offFor.filter(
                      (id) => !group.some((member) => member === id),
                    );
                    const write: PendingSkillSwitch = {
                      name: skill.name,
                      offFor: next ? others : [...others, ...group],
                      revision: props.revision,
                      accepted: false,
                    };
                    setPending(write);
                    setProviders.mutate(
                      {
                        environmentId: source.environmentId,
                        name: skill.name,
                        offFor: [...write.offFor],
                        revision: write.revision,
                      },
                      {
                        onError: () => setPending(null),
                        onSuccess: (answer) =>
                          setPending(
                            answer.outcome === "saved"
                              ? { ...write, accepted: true }
                              : null,
                          ),
                      },
                    );
                  }}
                />
              </li>
            );
          })}
        </ul>
        <ConfigurationWriteFeedback issue={switchIssue} />
      </section>
      {props.hosted ? (
        <OnHostOnlySkills
          providerId={props.providerId}
          environmentNames={props.skills.map((skill) => skill.name)}
        />
      ) : null}
    </div>
  );
}
