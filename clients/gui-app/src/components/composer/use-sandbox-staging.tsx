import { useCallback, useMemo, type ReactNode } from "react";
import { create } from "zustand";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import type { TaskHostGroup } from "@/components/epic-canvas/sidebar/task-host-groups-model";
import { mirrorLineOtherHostName } from "@/components/home/composer/composer-mirror-line-model";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import { taskHasReadersOutsideTeam } from "@/components/hosts/team-host-disclosure-model";
import {
  hostOptionPickerGroup,
  hostOptionTeamOwner,
} from "@/components/settings/host-scope/host-option-model";
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
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useMaybeEpicStore } from "@/hooks/use-epic-store";
import { useSampledNow } from "@/lib/relative-time";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import {
  SANDBOX_DEFAULT_IDLE_MINUTES,
  sandboxAwakeTodayMs,
  sandboxTodayCost,
} from "@/lib/sandboxes/sandbox-row-lines";
import { useSandboxDefaultsLookup } from "@/hooks/sandboxes/use-sandbox-defaults";
import {
  configurationStageShape,
  stageBalanceMc,
  stageConfigurationCopy,
  stageConfigurationKey,
  stageConfigurations,
  stageNeedsCredits,
  stagePrice,
  stageProviderFor,
  type ConsequencesInput,
  type SandboxConfigurationDefaults,
  type StageAudience,
  type StageConfiguration,
  type StagePrice,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  AGENT_SANDBOX,
  agentSandboxCreatedByLine,
  burstIdleShortLine,
  SANDBOXES_CANT_BE_CREATED,
  NEEDS_CREDITS,
  fundedRowPrice,
  needsCreditsRow,
  newSandboxRowLabel,
  reachRemedyLine,
  reachSentence,
  sandboxOsLabel,
  sandboxShapeLabel,
  stagedChipLabel,
  stoppedPickLabel,
  suspendedPickLabel,
  awakePickLabel,
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
  requestSandboxesPageConfiguration,
  type SandboxesPageConfigurationId,
} from "@/stores/sandboxes/sandboxes-page-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

/**
 * What an in-task picker knows about its task: the hosts it already uses,
 * grouped as the Agents panel names them, and who can read it. `null`
 * collaborators is a list this person could not read, counted as readers.
 */
export interface SandboxStagingTask {
  readonly epicId: string;
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
    () => ({ epicId, hosts, groups, collaborators: collaborators ?? null }),
    [collaborators, epicId, groups, hosts],
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
  /**
   * The staged block's `Open terminal instead`, beside Send: a terminal on
   * the same staged sandbox, with the same credit checks and no agent
   * sign-in. `null` where the surface's own action is the terminal.
   */
  readonly openTerminalInstead: (() => void) | null;
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
  openTerminalInstead: (() => void) | null,
): SandboxStagingSurface | null {
  const task = useSandboxStagingTask(epicId);
  return useMemo(
    () =>
      namedHostId !== null ? null : { surfaceKey, task, openTerminalInstead },
    [namedHostId, openTerminalInstead, surfaceKey, task],
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
  /** The block's `Open terminal instead`; `null` when nothing is staged. */
  readonly openTerminalInstead: (() => void) | null;
  /** The shape sheet, mounted beside the picker. */
  readonly sheet: ReactNode;
}

/** A New row's target: what a pick stages, or what a chat's fork lands on. */
export type NewStagedSandboxTarget = Extract<
  StagedSandboxTarget,
  { readonly kind: "new" }
>;

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
 * A New row stages its configuration's defaults (Settings › Sandboxes); the
 * person's remembered pick only seeds their gear. `memoryHostId` buckets
 * those picks, as every composer memory is bucketed by the composer's host.
 * A `null` surface stages nothing (a picker that is not a composer's) and
 * returns `null`.
 *
 * `forkOnNew` is a chat's host chip: a chat cannot move, so a New row (or
 * the shape sheet's choice) is handed to the chat's fork instead of being
 * staged, and a host row's pick is the chip's own fork.
 */
export function useSandboxStaging(input: {
  readonly surface: SandboxStagingSurface | null;
  readonly memoryHostId: string | null;
  readonly hosts: readonly HostScopeOption[];
  readonly forkOnNew: ((target: NewStagedSandboxTarget) => void) | null;
}): SandboxStaging | null {
  const { forkOnNew } = input;
  const { memoryHostId } = input;
  const surfaceKey = input.surface === null ? "" : input.surface.surfaceKey;
  const task = input.surface === null ? null : input.surface.task;
  const viewerUserId = useCloudChatViewerId();
  const user = useAuthUser().data ?? null;
  const catalogue = useSandboxCatalogue(input.surface !== null).data ?? null;
  const defaultsFor = useSandboxDefaultsLookup(input.surface !== null);
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
    () => newRowFacts({ user, catalogue, defaults: defaultsFor }),
    [catalogue, defaultsFor, user],
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
      price: stagedTargetPrice(stage.target, input.hosts, stagedFacts),
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
    input.hosts,
    reachFor,
    stage,
    stagedConfiguration,
    stagedFacts,
    viewerUserId,
  ]);

  // A New target goes to the chat's fork, else it is staged on the surface.
  const placeNew = useCallback(
    (target: NewStagedSandboxTarget): void => {
      if (forkOnNew === null) {
        useStagedSandboxStore.getState().stage(surfaceKey, target);
      } else {
        forkOnNew(target);
      }
    },
    [forkOnNew, surfaceKey],
  );

  const stageNew = useCallback(
    (facts: NewRowFacts): void => {
      if (facts.shape === null || catalogue === null) return;
      const provider = stageProviderFor(catalogue, facts.shape.os);
      placeNew({
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
    [catalogue, memoryHostId, placeNew],
  );

  // In this task: every host the task already uses, and every agent sandbox
  // created for it: the task's hosts list only hosts that own a chat on it,
  // so one an agent created and has not used yet is the row's own fact.
  // Automations is never offered, and a sandbox whose row has not answered
  // is not either (it fails closed).
  const inThisTask = useMemo(
    () =>
      task === null
        ? null
        : input.hosts.filter((host) => {
            const summary = host.sandbox === null ? null : host.sandbox.summary;
            const used =
              (task.hosts ?? []).some((row) => row.hostId === host.hostId) ||
              (summary !== null &&
                summary.burst &&
                summary.createdByTaskId === task.epicId);
            return (
              used &&
              hostOptionPickerGroup(host, true, null) !== "hidden" &&
              (host.sandbox === null || summary !== null)
            );
          }),
    [input.hosts, task],
  );
  const epicId = task === null ? null : task.epicId;
  const creatorIds = useMemo(
    () => agentSandboxCreatorIds(inThisTask ?? [], epicId),
    [epicId, inThisTask],
  );
  // One line per creator, in `creatorIds`' order: a joined string, so the
  // store read stays a primitive.
  const creatorTitles = useMaybeEpicStore(
    (state) => creatorIds.map((id) => agentTitleIn(state, id)).join("\n"),
    "",
  );
  const costs = useSandboxCosts().data ?? null;
  const now = useSampledNow();

  const composer = useMemo<HostSwitcherComposerMode>(() => {
    // The picker's own rule: an agent's burst sandbox and Automations are
    // offered only under In this task, and a teammate's team sandbox stays on
    // the team's page.
    const composerViewerId = viewerUserId.length === 0 ? null : viewerUserId;
    const titles = creatorTitles.split("\n");
    const creatorName = (agentId: string): string | null => {
      const title = titles[creatorIds.indexOf(agentId)] ?? "";
      return title.length === 0 ? null : title;
    };
    return {
      viewerUserId: composerViewerId,
      inThisTask,
      subLinesFor: (hostId) => {
        const host = input.hosts.find((option) => option.hostId === hostId);
        if (host === undefined) return [];
        const sandboxLines = sandboxRowLines(host, {
          costs,
          now,
          epicId,
          creatorName,
        });
        if (task === null) return sandboxLines;
        const owner = hostOptionTeamOwner(host);
        const principal: TaskHostPrincipal =
          owner === null
            ? { kind: "user", id: viewerUserId }
            : { kind: "team", id: owner.teamId };
        const other = reachFor(hostId, principal);
        if (other === null) return sandboxLines;
        const remedyTeam =
          host.isLocalMachine && owner === null ? taskTeamTitle(task) : null;
        return remedyTeam === null
          ? [...sandboxLines, reachSentence(other)]
          : [
              ...sandboxLines,
              reachSentence(other),
              reachRemedyLine(remedyTeam),
            ];
      },
      tagFor: (hostId) => {
        const host = input.hosts.find((option) => option.hostId === hostId);
        if (host === undefined || host.sandbox === null) return null;
        const summary = host.sandbox.summary;
        if (summary === null || !summary.burst) return null;
        return hostConfigurationLabel(host);
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
      stagedLabel: stage === null ? null : stagedLabel(stage, stagedFacts),
      // Running, not settled: a refusal or a failure ends the wait.
      stagedBusy:
        stage !== null && stage.phase !== "staged" && stage.failure === null,
      onPickHost: (host) => {
        // A chat's pick is its fork onto that host, made by the chip itself;
        // a sleeping sandbox wakes for it, as any pin's pick does.
        if (forkOnNew !== null) {
          wakeSandboxOnPick(host, null);
          return;
        }
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
        requestSandboxesPageConfiguration(
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
    costs,
    creatorIds,
    creatorTitles,
    epicId,
    forkOnNew,
    inThisTask,
    input.hosts,
    lastConfigurationByHost,
    memoryHostId,
    now,
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

  const sheetFacts = newRowOf(rows, sheetKey);
  const stagedNewTarget =
    sheetFacts === null ? null : stagedNewTargetOf(stage, sheetKey);
  const sheet =
    sheetFacts === null ? null : (
      <SandboxShapeSheet
        open
        onOpenChange={(open) => {
          if (!open) setSheetKey(null);
        }}
        configuration={sheetFacts.configuration}
        defaults={defaultsFor(stageConfigurationKey(sheetFacts.configuration))}
        initialShape={
          stagedNewTarget === null
            ? rememberedSandboxShape(
                remembered,
                memoryHostId,
                stageConfigurationKey(sheetFacts.configuration),
              )
            : stagedNewTarget.shape
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
          placeNew({
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
  const openTerminalInstead =
    stage === null || stage.phase === "handoff"
      ? null
      : input.surface.openTerminalInstead;
  return { composer, stage, consequences, openTerminalInstead, sheet };
}

function newRowFacts(input: {
  readonly user: AuthenticatedUser | null;
  readonly catalogue: SandboxCatalogue | null;
  readonly defaults: (
    configurationKey: string,
  ) => SandboxConfigurationDefaults | null;
}): readonly NewRowFacts[] {
  return stageConfigurations(input.user).map((configuration) => {
    const shape =
      input.catalogue === null
        ? null
        : configurationStageShape(
            input.catalogue,
            input.defaults(stageConfigurationKey(configuration)),
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

/**
 * `New Acme sandbox` over `Linux · 2 vCPU · 4 GB · $0.12 an hour while awake ·
 * uses your Acme credits`; at a short balance `New Acme sandbox · needs
 * credits` over `Linux · 2 vCPU · 4 GB · from $0.12 an hour · uses your Acme
 * credits`.
 */
function newRowPresentation(facts: NewRowFacts): HostSwitcherNewRow {
  const copy = stageConfigurationCopy(facts.configuration);
  const head = newSandboxRowLabel(copy);
  if (facts.uncreatable) {
    return {
      configurationKey: stageConfigurationKey(facts.configuration),
      label: head,
      subLine: SANDBOXES_CANT_BE_CREATED,
      configuration: copy,
      disabled: true,
    };
  }
  const parts: string[] = [];
  if (facts.shape !== null) {
    parts.push(
      sandboxOsLabel(facts.shape.os),
      sandboxShapeLabel(facts.shape.cpus, facts.shape.memoryMb),
    );
  }
  if (facts.price !== null) {
    parts.push(newRowPrice(facts.price, facts.needsCredits));
  }
  parts.push(usesCreditsClause(copy));
  return {
    configurationKey: stageConfigurationKey(facts.configuration),
    label: facts.needsCredits ? `${head} · ${NEEDS_CREDITS}` : head,
    subLine: parts.join(" · "),
    configuration: copy,
    disabled: false,
  };
}

function newRowPrice(price: StagePrice, needsCredits: boolean): string {
  return needsCredits
    ? needsCreditsRow(price.awakeMcPerHour)
    : fundedRowPrice(price.awakeMcPerHour, price.exact);
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

function stagedLabel(stage: StagedSandbox, facts: NewRowFacts | null): string {
  const { target } = stage;
  if (target.kind === "existing") {
    // Its wake is ticked once the line is past it: the sandbox is awake now.
    if (
      stage.phase === "handoff" ||
      (stage.phase === "creating" &&
        (stage.step === "applying" || stage.step === "delivering"))
    ) {
      return awakePickLabel(target.name);
    }
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

/** `Personal`, or the team that owns the sandbox. */
function hostConfigurationLabel(host: HostScopeOption): string {
  const owner = hostOptionTeamOwner(host);
  return owner === null ? "Personal" : owner.teamName;
}

/** The agents in this task that created an in-task agent sandbox. */
function agentSandboxCreatorIds(
  hosts: readonly HostScopeOption[],
  epicId: string | null,
): readonly string[] {
  if (epicId === null) return [];
  const ids = hosts.flatMap((host) => {
    const summary = host.sandbox === null ? null : host.sandbox.summary;
    if (summary === null || !summary.burst) return [];
    const id = summary.createdByAgentId;
    return id === null || summary.createdByTaskId !== epicId ? [] : [id];
  });
  return [...new Set(ids)].sort();
}

function agentTitleIn(state: OpenEpicState, agentId: string): string {
  if (Object.hasOwn(state.chats.byId, agentId)) {
    return state.chats.byId[agentId].title;
  }
  if (Object.hasOwn(state.tuiAgents.byId, agentId)) {
    return state.tuiAgents.byId[agentId].title;
  }
  return "";
}

/**
 * A sandbox row's own line: an agent sandbox says who created it and when it
 * goes (`Agent sandbox · created by Planner · destroys itself after 30 idle
 * min`); one the person started says whose it is and what it cost today
 * (`Personal · $0.03 today`). A computer has none here.
 */
function sandboxRowLines(
  host: HostScopeOption,
  context: {
    readonly costs: UserSandboxCost | null;
    readonly now: number;
    readonly epicId: string | null;
    readonly creatorName: (agentId: string) => string | null;
  },
): readonly string[] {
  const summary = host.sandbox === null ? null : host.sandbox.summary;
  if (summary === null) return [];
  if (summary.burst) {
    const creator =
      summary.createdByAgentId === null ||
      summary.createdByTaskId !== context.epicId
        ? null
        : context.creatorName(summary.createdByAgentId);
    return [
      `${creator === null ? AGENT_SANDBOX : agentSandboxCreatedByLine(creator)} · ${burstIdleShortLine(summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES)}`,
    ];
  }
  const cost =
    context.costs?.sandboxes.find((row) => row.sandboxId === summary.id) ??
    null;
  const today = sandboxTodayCost(
    summary,
    cost,
    sandboxAwakeTodayMs(summary, context.now),
  );
  const configuration = hostConfigurationLabel(host);
  return [today === null ? configuration : `${configuration} · ${today}`];
}

/**
 * The staged target's price: an existing sandbox's from its row, a New
 * one's from the catalogue (`null` until it answers).
 */
function stagedTargetPrice(
  target: StagedSandboxTarget,
  hosts: readonly HostScopeOption[],
  stagedFacts: NewRowFacts | null,
): StagePrice | null {
  if (target.kind === "existing") {
    return existingTargetPrice(hosts, target.hostId);
  }
  return stagedFacts === null ? null : stagedFacts.price;
}

/** The New row of `configurationKey`; `null` for none, or no key. */
function newRowOf(
  rows: readonly NewRowFacts[],
  configurationKey: string | null,
): NewRowFacts | null {
  if (configurationKey === null) return null;
  return (
    rows.find(
      (row) => stageConfigurationKey(row.configuration) === configurationKey,
    ) ?? null
  );
}

/** The staged New target, when it is the one of `configurationKey`. */
function stagedNewTargetOf(
  stage: StagedSandbox | null,
  configurationKey: string | null,
): NewStagedSandboxTarget | null {
  if (stage === null || stage.target.kind !== "new") return null;
  return stageConfigurationKey(stage.target.configuration) === configurationKey
    ? stage.target
    : null;
}

function existingTargetPrice(
  hosts: readonly HostScopeOption[],
  hostId: string,
): StagePrice | null {
  const host = hosts.find((option) => option.hostId === hostId);
  const summary =
    host === undefined || host.sandbox === null ? null : host.sandbox.summary;
  if (summary === null || summary.priceMcPerHour === null) return null;
  return { awakeMcPerHour: summary.priceMcPerHour.awakeMc, exact: true };
}
