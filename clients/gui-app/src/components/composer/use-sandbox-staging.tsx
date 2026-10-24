import { useCallback, useMemo, type ReactNode } from "react";
import { create } from "zustand";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import type { TaskHostGroup } from "@/components/epic-canvas/sidebar/task-host-groups-model";
import { mirrorLineOtherHostName } from "@/components/home/composer/composer-mirror-line-model";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import { taskHasReadersOutsideTeam } from "@/components/hosts/team-host-disclosure-model";
import { hostOptionTeamOwner } from "@/components/settings/host-scope/host-option-model";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import type { HostSwitcherComposerMode } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherNewRow } from "@/components/settings/host-scope/host-switcher-new-rows";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useTaskHostGroups } from "@/hooks/epic/use-task-host-groups";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  useEpicCollaboratorsQuery,
  type EpicCollaboratorsView,
} from "@/hooks/epics/use-epic-collaborators-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  rememberedOrDefaultStageShape,
  stageBalanceMc,
  stageConfigurationCopy,
  stageConfigurationKey,
  stageConfigurations,
  stageNeedsCredits,
  stagePrice,
  stageProviderFor,
  type ConsequencesInput,
  type StageAudience,
  type StageConfiguration,
  type StagePrice,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  SANDBOXES_CANT_BE_CREATED,
  NEEDS_CREDITS,
  configurationLabel,
  needsCreditsRow,
  newSandboxRowLabel,
  reachRemedyLine,
  reachSentence,
  sandboxShapeLabel,
  shortPriceLabel,
  stagedChipLabel,
  stoppedPickLabel,
  suspendedPickLabel,
  usesCreditsClause,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";
import {
  rememberedSandboxShape,
  useSandboxShapeMemoryStore,
} from "@/stores/composer/sandbox-shape-memory-store";
import {
  useStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  setSandboxesPageConfiguration,
  type SandboxesPageConfigurationId,
} from "@/stores/sandboxes/sandboxes-page-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * What an in-task picker knows about its task: the hosts it already uses,
 * grouped as the Agents panel names them, and who can read it. `null`
 * collaborators is a list this person could not read, counted as readers.
 */
export interface SandboxStagingTask {
  readonly hosts: readonly TaskHostRow[] | null;
  readonly groups: readonly TaskHostGroup[];
  readonly collaborators: EpicCollaboratorsView | null;
}

export function useSandboxStagingTask(epicId: string): SandboxStagingTask {
  const view = useTaskHostsView(epicId);
  const hosts = view.kind === "hosts" ? view.hosts : null;
  const groups = useTaskHostGroups(epicId, hosts);
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const collaborators = useEpicCollaboratorsQuery(epicId, {
    client,
    enabled: cloudAuthorized,
    poll: false,
    staleTime: undefined,
  }).data;
  return useMemo(
    () => ({ hosts, groups, collaborators: collaborators ?? null }),
    [collaborators, groups, hosts],
  );
}

/** The shape sheet open per surface: the configuration it edits. */
const useShapeSheetStore = create<{
  readonly openFor: Readonly<Partial<Record<string, string>>>;
}>(() => ({ openFor: {} }));

function setShapeSheet(
  surfaceKey: string,
  configurationKey: string | null,
): void {
  useShapeSheetStore.setState((state) => {
    const openFor = { ...state.openFor };
    if (configurationKey === null) delete openFor[surfaceKey];
    else openFor[surfaceKey] = configurationKey;
    return { openFor };
  });
}

/**
 * Opens the shape sheet on the staged configuration: the setup line's
 * `Change shape or region` and `Choose a smaller shape`.
 */
export function openStagedShapeSheet(surfaceKey: string): void {
  const stage = useStagedSandboxStore.getState().bySurface[surfaceKey];
  if (stage === undefined || stage.target.kind !== "new") return;
  setShapeSheet(surfaceKey, stageConfigurationKey(stage.target.configuration));
}

/** The surface a picker stages for: its pin key, and its task once one exists. */
export interface SandboxStagingSurface {
  readonly surfaceKey: string;
  readonly task: SandboxStagingTask | null;
}

/**
 * An in-task picker's staging surface, keyed by its pin. `null` when the
 * request named its host: naming the machine is the request, so nothing is
 * staged.
 */
export function useInTaskSandboxStagingSurface(
  epicId: string,
  surfaceKey: string,
  namedHostId: string | null,
): SandboxStagingSurface | null {
  const task = useSandboxStagingTask(epicId);
  return useMemo(
    () => (namedHostId !== null ? null : { surfaceKey, task }),
    [namedHostId, surfaceKey, task],
  );
}

/** The pin key a staging surface stages under, or `null` for none. */
export function stagingSurfaceKey(
  surface: SandboxStagingSurface | null,
): string | null {
  return surface === null ? null : surface.surfaceKey;
}

/** A composer surface's staging, as the picker, the block and the sheet read it. */
export interface SandboxStaging {
  readonly composer: HostSwitcherComposerMode;
  readonly stage: StagedSandbox | null;
  /** The block under the staged host; `null` when nothing is staged. */
  readonly consequences: ConsequencesInput | null;
  /** The shape sheet, mounted beside the picker. */
  readonly sheet: ReactNode;
}

interface NewRowFacts {
  readonly configuration: StageConfiguration;
  /** `null` before the catalogue answers, or when it offers no shape. */
  readonly shape: StageShape | null;
  /** The catalogue answered with nothing this account can create. */
  readonly uncreatable: boolean;
  readonly price: StagePrice | null;
  readonly needsCredits: boolean;
}

/**
 * The composer and new-terminal pickers' staging (sandboxes redesign D9): the
 * New rows, what a pick stages, the staged chip's label, the consequences
 * block's input and the shape sheet. A pick only stages; the surface's first
 * action runs the create or wake.
 *
 * `memoryHostId` buckets the person's remembered shapes, as every composer
 * memory is bucketed by the composer's host. A `null` surface stages nothing
 * (a picker that is not a composer's) and returns `null`.
 */
export function useSandboxStaging(input: {
  readonly surface: SandboxStagingSurface | null;
  readonly memoryHostId: string | null;
  readonly hosts: readonly HostScopeOption[];
}): SandboxStaging | null {
  const { memoryHostId } = input;
  const surfaceKey = input.surface === null ? "" : input.surface.surfaceKey;
  const task = input.surface === null ? null : input.surface.task;
  const viewerUserId = useCloudChatViewerId();
  const user = useAuthUser().data ?? null;
  const catalogue = useSandboxCatalogue(input.surface !== null).data ?? null;
  const remembered = useSandboxShapeMemoryStore((s) => s.byHost);
  const lastConfigurationByHost = useSandboxShapeMemoryStore(
    (s) => s.lastConfigurationByHost,
  );
  const stage = useStagedSandbox(surfaceKey);
  const { openSettings } = useSystemTabModalActions();
  const sheetKey = useShapeSheetStore((s) => s.openFor[surfaceKey] ?? null);
  const setSheetKey = useCallback(
    (configurationKey: string | null): void => {
      setShapeSheet(surfaceKey, configurationKey);
    },
    [surfaceKey],
  );

  const rows = useMemo(
    () =>
      newRowFacts({
        user,
        catalogue,
        remembered: (key) =>
          rememberedSandboxShape(remembered, memoryHostId, key),
      }),
    [catalogue, memoryHostId, remembered, user],
  );
  const audienceFor = useCallback(
    (configuration: StageConfiguration): StageAudience =>
      stageAudience(task, configuration, viewerUserId),
    [task, viewerUserId],
  );
  const reachFor = useCallback(
    (startHostId: string, principal: TaskHostPrincipal): string | null => {
      if (task === null || task.hosts === null) return null;
      return mirrorLineOtherHostName({
        groups: task.groups,
        hosts: task.hosts,
        startHostId,
        startPrincipalFallback: principal,
      });
    },
    [task],
  );

  const stagedConfiguration =
    stage === null ? null : stage.target.configuration;
  const stagedFacts = useMemo(
    () =>
      stage === null || stage.target.kind !== "new" || catalogue === null
        ? null
        : stagedNewFacts(user, catalogue, stage.target),
    [catalogue, stage, user],
  );
  const consequences = useMemo<ConsequencesInput | null>(() => {
    if (stage === null || stagedConfiguration === null) return null;
    const principal = configurationPrincipal(stagedConfiguration, viewerUserId);
    return {
      configuration: stagedConfiguration,
      price: stagedFacts === null ? null : stagedFacts.price,
      needsCredits: stagedFacts !== null && stagedFacts.needsCredits,
      audience: audienceFor(stagedConfiguration),
      reachHost: reachFor(
        stage.target.kind === "existing" ? stage.target.hostId : "",
        principal,
      ),
      // No source carries a computer's unmoved settings yet.
      unmovedComputer: null,
    };
  }, [
    audienceFor,
    reachFor,
    stage,
    stagedConfiguration,
    stagedFacts,
    viewerUserId,
  ]);

  const stageNew = useCallback(
    (facts: NewRowFacts): void => {
      if (facts.shape === null || catalogue === null) return;
      const provider = stageProviderFor(catalogue, facts.shape.os);
      useStagedSandboxStore.getState().stage(surfaceKey, {
        kind: "new",
        configuration: facts.configuration,
        shape: facts.shape,
        name: "",
        wakeString:
          provider === null ? null : wakeString(provider.suspendFidelity),
      });
      useSandboxShapeMemoryStore
        .getState()
        .rememberConfiguration(
          memoryHostId,
          stageConfigurationKey(facts.configuration),
        );
    },
    [catalogue, memoryHostId, surfaceKey],
  );

  const composer = useMemo<HostSwitcherComposerMode>(() => {
    // The picker's own rule for a sandbox: an agent's burst sandbox is never
    // offered, and one whose row has not answered might be burst (fails closed).
    const inThisTask =
      task === null
        ? null
        : input.hosts.filter(
            (host) =>
              (task.hosts ?? []).some((row) => row.hostId === host.hostId) &&
              (host.sandbox === null ||
                (host.sandbox.summary !== null && !host.sandbox.summary.burst)),
          );
    return {
      viewerUserId: viewerUserId.length === 0 ? null : viewerUserId,
      inThisTask,
      subLinesFor: (hostId) => {
        const host = input.hosts.find((option) => option.hostId === hostId);
        if (host === undefined || task === null) return [];
        const owner = hostOptionTeamOwner(host);
        const principal: TaskHostPrincipal =
          owner === null
            ? { kind: "user", id: viewerUserId }
            : { kind: "team", id: owner.teamId };
        const other = reachFor(hostId, principal);
        if (other === null) return [];
        const remedyTeam =
          host.isLocalMachine && owner === null ? taskTeamTitle(task) : null;
        return remedyTeam === null
          ? [reachSentence(other)]
          : [reachSentence(other), reachRemedyLine(remedyTeam)];
      },
      newRows: rows.map(newRowPresentation),
      rememberedConfigurationKey:
        memoryHostId === null
          ? null
          : (lastConfigurationByHost[memoryHostId] ?? null),
      stagedConfigurationKey:
        stage === null || stage.target.kind !== "new"
          ? null
          : stageConfigurationKey(stage.target.configuration),
      stagedLabel:
        stage === null ? null : stagedLabel(stage.target, stagedFacts),
      // Running, not settled: a refusal or a failure ends the wait.
      stagedBusy:
        stage !== null && stage.phase !== "staged" && stage.failure === null,
      onPickHost: (host) => {
        const target = restingTargetFor(host);
        if (target === null) {
          useStagedSandboxStore.getState().clear(surfaceKey);
          return;
        }
        useStagedSandboxStore.getState().stage(surfaceKey, target);
      },
      onPickNew: (configurationKey) => {
        const facts = rows.find(
          (row) =>
            stageConfigurationKey(row.configuration) === configurationKey,
        );
        if (facts !== undefined) stageNew(facts);
      },
      onOpenShape: setSheetKey,
      onManage: () => {
        setSandboxesPageConfiguration(
          managedConfiguration(stage, input.hosts, memoryHostId),
        );
        openSettings({
          section: "sandboxes",
          resetToGeneral: false,
          tab: null,
          draft: null,
          hostId: null,
        });
      },
    };
  }, [
    input.hosts,
    lastConfigurationByHost,
    memoryHostId,
    openSettings,
    reachFor,
    rows,
    setSheetKey,
    stage,
    stageNew,
    stagedFacts,
    surfaceKey,
    task,
    viewerUserId,
  ]);

  const sheetFacts =
    sheetKey === null
      ? null
      : (rows.find(
          (row) => stageConfigurationKey(row.configuration) === sheetKey,
        ) ?? null);
  const stagedNewTarget =
    stage !== null &&
    stage.target.kind === "new" &&
    sheetFacts !== null &&
    stageConfigurationKey(stage.target.configuration) === sheetKey
      ? stage.target
      : null;
  const sheet =
    sheetFacts === null ? null : (
      <SandboxShapeSheet
        open
        onOpenChange={(open) => {
          if (!open) setSheetKey(null);
        }}
        configuration={sheetFacts.configuration}
        initialShape={
          stagedNewTarget === null ? sheetFacts.shape : stagedNewTarget.shape
        }
        initialName={stagedNewTarget === null ? "" : stagedNewTarget.name}
        context={{
          audience: audienceFor(sheetFacts.configuration),
          reachHost: reachFor(
            "",
            configurationPrincipal(sheetFacts.configuration, viewerUserId),
          ),
          unmovedComputer: null,
        }}
        onUseShape={(shape, name, wake) => {
          useStagedSandboxStore.getState().stage(surfaceKey, {
            kind: "new",
            configuration: sheetFacts.configuration,
            shape,
            name,
            wakeString: wake,
          });
          const key = stageConfigurationKey(sheetFacts.configuration);
          const memory = useSandboxShapeMemoryStore.getState();
          memory.remember(memoryHostId, key, shape);
          memory.rememberConfiguration(memoryHostId, key);
          setSheetKey(null);
        }}
      />
    );

  if (input.surface === null) return null;
  return { composer, stage, consequences, sheet };
}

function newRowFacts(input: {
  readonly user: AuthenticatedUser | null;
  readonly catalogue: SandboxCatalogue | null;
  readonly remembered: (configurationKey: string) => StageShape | null;
}): readonly NewRowFacts[] {
  return stageConfigurations(input.user).map((configuration) => {
    const shape =
      input.catalogue === null
        ? null
        : rememberedOrDefaultStageShape(
            input.catalogue,
            input.remembered(stageConfigurationKey(configuration)),
          );
    const price =
      input.catalogue === null || shape === null
        ? null
        : stagePrice(input.catalogue, shape);
    return {
      configuration,
      shape,
      uncreatable: input.catalogue !== null && shape === null,
      price,
      needsCredits: stageNeedsCredits(
        stageBalanceMc(input.user, configuration),
        price,
      ),
    };
  });
}

function stagedNewFacts(
  user: AuthenticatedUser | null,
  catalogue: SandboxCatalogue,
  target: Extract<StagedSandboxTarget, { kind: "new" }>,
): NewRowFacts {
  const price = stagePrice(catalogue, target.shape);
  return {
    configuration: target.configuration,
    shape: target.shape,
    uncreatable: false,
    price,
    needsCredits: stageNeedsCredits(
      stageBalanceMc(user, target.configuration),
      price,
    ),
  };
}

/** `New Acme sandbox · needs credits` over `2 vCPU · 4 GB · $0.12/h · uses your Acme credits`. */
function newRowPresentation(facts: NewRowFacts): HostSwitcherNewRow {
  const copy = stageConfigurationCopy(facts.configuration);
  const head = newSandboxRowLabel(copy);
  if (facts.uncreatable) {
    return {
      configurationKey: stageConfigurationKey(facts.configuration),
      label: head,
      subLine: SANDBOXES_CANT_BE_CREATED,
      configurationName: configurationLabel(copy),
      disabled: true,
    };
  }
  const parts: string[] = [];
  if (facts.shape !== null) {
    parts.push(sandboxShapeLabel(facts.shape.cpus, facts.shape.memoryMb));
  }
  if (facts.price !== null) {
    parts.push(newRowPrice(facts.price, facts.needsCredits));
  }
  parts.push(usesCreditsClause(copy));
  return {
    configurationKey: stageConfigurationKey(facts.configuration),
    label: facts.needsCredits ? `${head} · ${NEEDS_CREDITS}` : head,
    subLine: parts.join(" · "),
    configurationName: configurationLabel(copy),
    disabled: false,
  };
}

function newRowPrice(price: StagePrice, needsCredits: boolean): string {
  if (needsCredits) return needsCreditsRow(price.awakeMcPerHour);
  const label = shortPriceLabel(price.awakeMcPerHour);
  return price.exact ? label : `from ${label}`;
}

/**
 * The verb a resting sandbox's first action runs, or `null` when awake. One
 * still on its way to rest takes the same verb; a wake the server answers
 * with a conflict ends on the setup line's failure, with Retry.
 */
export function restingVerb(
  state: HostScopeSandbox["state"],
): "resume" | "start" | null {
  if (state === "suspended" || state === "suspending") return "resume";
  if (state === "stopped" || state === "stopping") return "start";
  return null;
}

function stagedLabel(
  target: StagedSandboxTarget,
  facts: NewRowFacts | null,
): string {
  if (target.kind === "existing") {
    return target.verb === "resume"
      ? suspendedPickLabel(target.name)
      : stoppedPickLabel(target.name);
  }
  return stagedChipLabel({
    configuration: stageConfigurationCopy(target.configuration),
    cpus: target.shape.cpus,
    memoryMb: target.shape.memoryMb,
    priceMcPerHour:
      facts === null || facts.price === null
        ? null
        : facts.price.awakeMcPerHour,
    priceIsFrom: facts !== null && facts.price !== null && !facts.price.exact,
  });
}

/**
 * A resting sandbox of the person's, picked: staged to resume or start at the
 * first action, since a pick never wakes. `null` for any other host.
 */
function restingTargetFor(host: HostScopeOption): StagedSandboxTarget | null {
  const sandbox = host.sandbox;
  if (sandbox === null || sandbox.frozen || sandbox.summary === null) {
    return null;
  }
  const verb = restingVerb(sandbox.state);
  if (verb === null) return null;
  const owner = hostOptionTeamOwner(host);
  return {
    kind: "existing",
    hostId: host.hostId,
    sandboxId: sandbox.summary.id,
    name: host.name,
    configuration:
      owner === null
        ? { kind: "personal" }
        : { kind: "team", teamId: owner.teamId, teamName: owner.teamName },
    verb,
  };
}

/**
 * The configuration `Manage sandboxes in Settings` opens on: the staged
 * one, else the team of the sandbox the surface is on, else Personal.
 */
function managedConfiguration(
  stage: StagedSandbox | null,
  hosts: readonly HostScopeOption[],
  activeHostId: string | null,
): SandboxesPageConfigurationId {
  const configuration =
    stage === null
      ? activeHostConfiguration(hosts, activeHostId)
      : stage.target.configuration;
  return configuration.kind === "team"
    ? { kind: "team", teamId: configuration.teamId }
    : { kind: "personal" };
}

function activeHostConfiguration(
  hosts: readonly HostScopeOption[],
  activeHostId: string | null,
): StageConfiguration {
  const host = hosts.find((option) => option.hostId === activeHostId);
  const owner = host === undefined ? null : hostOptionTeamOwner(host);
  return owner === null
    ? { kind: "personal" }
    : { kind: "team", teamId: owner.teamId, teamName: owner.teamName };
}

function configurationPrincipal(
  configuration: StageConfiguration,
  viewerUserId: string,
): TaskHostPrincipal {
  return configuration.kind === "personal"
    ? { kind: "user", id: viewerUserId }
    : { kind: "team", id: configuration.teamId };
}

/**
 * The landing composer's task does not exist yet and may gain readers: a
 * team's sandbox is told as shared, a personal one as private. In a task, a
 * list this person could not read counts as readers.
 */
function stageAudience(
  task: SandboxStagingTask | null,
  configuration: StageConfiguration,
  viewerUserId: string,
): StageAudience {
  if (task === null) {
    return configuration.kind === "team" ? "shared" : "private";
  }
  const collaborators = task.collaborators;
  if (collaborators === null) return "shared";
  if (configuration.kind === "team") {
    return taskHasReadersOutsideTeam({
      viewerUserId,
      teamId: configuration.teamId,
      collaborators,
    })
      ? "shared"
      : "private";
  }
  const others =
    collaborators.ownerTeam !== null ||
    collaborators.teams.length > 0 ||
    collaborators.flatRows.some(
      (row) => row.userId !== null && row.userId !== viewerUserId,
    );
  return others ? "shared" : "private";
}

/** The first team host group's title, for the reach remedy. */
function taskTeamTitle(task: SandboxStagingTask): string | null {
  return (
    task.groups.find((group) => group.key.startsWith("team:"))?.title ?? null
  );
}
