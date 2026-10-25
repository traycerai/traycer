import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
import type { EnvironmentSkill } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ProviderSkillDetailDialog } from "@/components/settings/panels/provider-skill-detail-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import {
  useEnvironmentSkillMutations,
  useEnvironmentSkillsQuery,
} from "@/hooks/environment/team/use-environment-skills";
import { fileContentRevision } from "@/lib/workspace/file-content-revision";
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
  BUILT_IN_SKILL_LINE,
  REMOVE_SKILL_LABEL,
  SKILL_SWITCHES_UNAVAILABLE,
  providersPhrase,
  removeReach,
  removeTitle,
  skillSourcePhrase,
  skillsCardHeading,
  skillsPageSubtitle,
  skillsReadFailed,
} from "./mcp-skills-copy";
import { OnHostOnlySkills } from "./on-host-only-entries";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { TeamReadFailed } from "./team-read-failed";
import { TeamSkillUpload } from "./team-skill-upload";
import { TeamSkills } from "./team-skills";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import { typedWriteIssue } from "./configuration-write-issue";

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
 * The configuration's skills as the viewing host serves them, and whether
 * that host switches skills per provider. `fallback` is drawn for a host that
 * predates the list.
 */
function useServedSkills() {
  const scope = useTeamViewingHost();
  const listVersion = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.configuration.skills.list",
  );
  const switchesVersion = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.configuration.skills.setProviders",
  );
  const listed = listVersion !== null && listVersion !== false;
  const query = useEnvironmentSkillsQuery(scope.client, listed);
  return {
    scope,
    listVersion,
    query,
    switchesAvailable: switchesVersion !== null && switchesVersion !== false,
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
  const name = useConfigurationName();
  const canEdit = useCanEditConfiguration();
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
  if (served.scope.client === null)
    return (
      <section className="flex flex-col gap-3">
        {picker}
        {noHost}
      </section>
    );
  if (served.listVersion === null) return <MutedAgentSpinner />;
  if (served.listVersion === false)
    return <TeamSkills providerId={props.providerId} />;
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
  return (
    <section className="flex flex-col gap-3">
      {picker}
      <TeamViewingHostBinding unavailable={noHost}>
        {props.providerId === null ? (
          <SkillsPageList
            skills={skills}
            canEdit={canEdit}
            switchesAvailable={served.switchesAvailable}
          />
        ) : (
          <ProviderSkillsList
            providerId={props.providerId}
            skills={skills}
            revision={revision}
            canEdit={canEdit}
            switchesAvailable={served.switchesAvailable}
          />
        )}
        {props.providerId === null && canEdit ? (
          <TeamSkillUpload onNotServed={() => setPicking(true)} />
        ) : null}
      </TeamViewingHostBinding>
    </section>
  );
}

function SkillsPageList(props: {
  readonly skills: readonly EnvironmentSkill[];
  readonly canEdit: boolean;
  readonly switchesAvailable: boolean;
}): ReactNode {
  const providers = useSkillProviders();
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const { remove } = useEnvironmentSkillMutations(scope.client);
  const [open, setOpen] = useState<EnvironmentSkill | null>(null);
  const [removing, setRemoving] = useState<EnvironmentSkill | null>(null);
  const removeIssue =
    remove.data === undefined
      ? null
      : typedWriteIssue(remove.data, "Couldn't remove this skill.");
  if (props.skills.length === 0)
    return (
      <p className="text-ui-sm text-muted-foreground">
        Skills give agents instructions for a kind of task.
      </p>
    );
  return (
    <>
      <h3 className="text-ui-sm font-medium">Skills</h3>
      <ul className="flex flex-col gap-2" aria-label="Skills">
        {props.skills.map((skill) => {
          const using = props.switchesAvailable
            ? providers.filter((id) => !skill.offFor.includes(id))
            : providers;
          return (
            <li
              key={skill.name}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-ui-sm font-medium">
                  {skill.name}
                </div>
                {skill.description === null ? null : (
                  <div className="truncate text-ui-xs text-muted-foreground">
                    {skill.description}
                  </div>
                )}
                <div className="text-ui-xs text-muted-foreground">
                  {skillSourcePhrase(skill.origin)} ·{" "}
                  {providersPhrase(
                    using.map((id) => providerDisplayName(id)),
                    providers.length,
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(skill)}
                >
                  {skill.origin === "room" && props.canEdit
                    ? "Edit"
                    : "Preview"}
                </Button>
                {/* A built-in can't be removed, only switched off per provider. */}
                {props.canEdit && skill.origin === "room" ? (
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
      <ConfigurationWriteFeedback issue={removeIssue} />
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
      {open === null ? null : (
        <EnvironmentSkillDetail
          skill={open}
          providerId={providers.at(0) ?? "claude-code"}
          canEdit={editable(props.canEdit, open)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function RemoveSkillDialog(props: {
  readonly skill: EnvironmentSkill;
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
      description={removeReach(personal, name, props.skill.name)}
      cascadeSummary={null}
      actionLabel={REMOVE_SKILL_LABEL}
      isPending={props.pending}
      blockedReason={null}
      onConfirm={props.onConfirm}
    />
  );
}

/** A skill written in Settings is edited in place; a built-in is previewed. */
function editable(canEdit: boolean, skill: EnvironmentSkill): boolean {
  return canEdit && skill.origin === "room";
}

/**
 * One skill's files, read and edited where the viewing host projects the
 * configuration's skills: the row a provider lists for it there. An edit
 * there reaches the configuration like any change in its skills.
 */
function EnvironmentSkillDetail(props: {
  readonly skill: EnvironmentSkill;
  readonly providerId: ProviderId;
  readonly canEdit: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const list = useProvidersSkillsList({
    providerId: props.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: true,
  });
  const mutate = useProvidersSkillsMutate();
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const row: ProviderSkill | undefined = list.data?.skills.find(
    (skill) => skill.source === "managed" && skill.name === props.skill.name,
  );
  // Edit or Preview opens on this second read, so it says where that read
  // is rather than opening nothing.
  if (list.isError && !list.isFetching)
    return (
      <TeamReadFailed
        message="Couldn't read this skill's files."
        onRetry={() => void list.refetch()}
      />
    );
  if (list.data === undefined) return <MutedAgentSpinner />;
  if (row === undefined)
    return (
      <TeamReadFailed
        message="Couldn't find this skill's files."
        onRetry={() => void list.refetch()}
      />
    );
  return (
    <ProviderSkillDetailDialog
      skill={row}
      removal={{ kind: "hidden" }}
      removePending={false}
      // The flag disables Edit too, and Remove is not offered here.
      removeDisabled={false}
      actionError={error}
      lockedNote={null}
      canEdit={props.canEdit}
      canUpdate={false}
      origin={null}
      updatePending={false}
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
          .catch(() => {
            setError("Couldn't edit this skill.");
            return false;
          })
      }
      onRequestUpdate={() => undefined}
      onRequestRemove={() => undefined}
      onClose={props.onClose}
      fileEpoch={epoch}
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

function ProviderSkillsList(props: {
  readonly providerId: ProviderId;
  readonly skills: readonly EnvironmentSkill[];
  readonly revision: string | null;
  readonly canEdit: boolean;
  readonly switchesAvailable: boolean;
}): ReactNode {
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const name = useConfigurationName();
  const { setProviders } = useEnvironmentSkillMutations(scope.client);
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
            const uses = !skill.offFor.includes(props.providerId);
            return (
              <li
                key={skill.name}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-ui-sm">{skill.name}</div>
                  <div className="text-ui-xs text-muted-foreground">
                    {skillSourcePhrase(skill.origin)}
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
                    setProviders.isPending
                  }
                  onCheckedChange={(next) => {
                    if (source.kind !== "pool") return;
                    const group = skillSwitchGroup(props.providerId);
                    const others = skill.offFor.filter(
                      (id) => !group.some((member) => member === id),
                    );
                    setProviders.mutate({
                      environmentId: source.environmentId,
                      name: skill.name,
                      offFor: next ? others : [...others, ...group],
                      revision: props.revision,
                    });
                  }}
                />
              </li>
            );
          })}
        </ul>
        <ConfigurationWriteFeedback issue={switchIssue} />
      </section>
      <OnHostOnlySkills
        providerId={props.providerId}
        environmentNames={props.skills.map((skill) => skill.name)}
      />
    </div>
  );
}
