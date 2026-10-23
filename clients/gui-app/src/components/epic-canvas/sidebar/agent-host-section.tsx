import { useEffect, type ReactNode } from "react";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  SandboxMember,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mintNewEpicTerminalTile } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { AgentHostProjection } from "@/hooks/epic/use-agent-host-projection";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useMaybeEpicStore } from "@/hooks/use-epic-store";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useSampledNow } from "@/lib/relative-time";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  AGENT_SANDBOX,
  burstIdleLine,
  DETAILS,
  FILES,
  HOST_LABEL,
  hoverAgentIdentity,
  hoverAlsoInTask,
  hoverAwakeMinutes,
  hoverMoreSessions,
  hoverSandboxIdentity,
  hoverTaskConfiguration,
  hoverTodayCost,
  KEEP_THIS_SANDBOX,
  idleAndRestingLine,
  OPEN_TERMINAL,
  reachSentence,
  REACH_UNNAMED_HOSTS,
  sandboxShapeLabel,
  SESSIONS_UNKNOWN,
  shortPriceLabel,
  TASK_FILES,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import {
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

export function AgentHostSection(props: {
  readonly projection: AgentHostProjection;
  readonly epicId: string;
  readonly nodeId: string;
  readonly ownerHostUnreachable: boolean;
  readonly onKeep: (sandbox: SandboxSummary) => void;
}): ReactNode {
  return props.projection.kind === "host" ? (
    <AuthorizedHostSection
      sandbox={props.projection.sandbox}
      epicId={props.epicId}
      nodeId={props.nodeId}
      ownerHostUnreachable={props.ownerHostUnreachable}
      onKeep={props.onKeep}
    />
  ) : (
    <TaskHostSection host={props.projection.host} nodeId={props.nodeId} />
  );
}

function TaskHostSection(props: {
  readonly host: TaskHostRow;
  readonly nodeId: string;
}): ReactNode {
  const teams = useAuthStore((state) => state.shareableTeams);
  const principal = props.host.principal;
  let configuration: string | null = "Personal";
  if (principal.kind === "team") {
    configuration =
      teams.find((team) => team.teamId === principal.id)?.slug ?? null;
  }
  const others = useMaybeEpicStore(
    (state) =>
      [
        ...Object.values(state.chats.byId),
        ...Object.values(state.tuiAgents.byId),
      ]
        .filter(
          (agent) =>
            agent.hostId === props.host.hostId && agent.id !== props.nodeId,
        )
        .map((agent) => agent.title)
        .join(", "),
    "",
  );
  return (
    <section className="space-y-1 px-3 py-2 text-ui-xs" aria-label={HOST_LABEL}>
      <p className="font-medium text-muted-foreground">{HOST_LABEL}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium break-words">{props.host.label}</span>
        {configuration === null ? null : (
          <Badge size="xs" variant="muted">
            {configuration}
          </Badge>
        )}
        {principal.kind === "team" ? (
          <span className="text-muted-foreground">
            {hoverTaskConfiguration(configuration)}
          </span>
        ) : null}
      </div>
      {props.host.reach === "other_principal" ? (
        <p className="text-muted-foreground">
          {reachSentence(REACH_UNNAMED_HOSTS)}
        </p>
      ) : null}
      {others.length === 0 ? null : (
        <p className="text-muted-foreground">{hoverAlsoInTask(others)}</p>
      )}
      <HostFilesAction hostId={null} />
    </section>
  );
}

function memberName(
  member: SandboxMember | null,
  viewerUserId: string | null,
): string | null {
  if (member === null) return null;
  return member.userId === viewerUserId ? "you" : member.displayName;
}

function AuthorizedHostSection(props: {
  readonly sandbox: SandboxSummary;
  readonly epicId: string;
  readonly nodeId: string;
  readonly ownerHostUnreachable: boolean;
  readonly onKeep: (sandbox: SandboxSummary) => void;
}): ReactNode {
  const { sandbox } = props;
  const registry = useRegisteredHosts();
  const owner = registry.data?.hosts.find(
    (host) => host.hostId === sandbox.hostId,
  )?.owner;
  let configuration: string | null = null;
  if (owner?.kind === "team") configuration = owner.name;
  else if (owner?.kind === "user" || sandbox.environmentId === null)
    configuration = "Personal";
  const awake = sandbox.state === "awake" && !sandbox.frozen;
  return (
    <section className="space-y-1 px-3 py-2 text-ui-xs" aria-label={HOST_LABEL}>
      <p className="font-medium text-muted-foreground">{HOST_LABEL}</p>
      <HostHeading
        sandbox={sandbox}
        configuration={configuration}
        awake={awake}
      />
      <HostIdentityLine
        sandbox={sandbox}
        epicId={props.epicId}
        configuration={configuration}
        awake={awake}
      />
      <HostIdlePolicy sandbox={sandbox} />
      {awake ? (
        <HostActivity
          sandbox={sandbox}
          epicId={props.epicId}
          nodeId={props.nodeId}
          ownerHostUnreachable={props.ownerHostUnreachable}
        />
      ) : null}
      <HostActions
        sandbox={sandbox}
        epicId={props.epicId}
        ownerHostUnreachable={props.ownerHostUnreachable}
        awake={awake}
        onKeep={props.onKeep}
      />
    </section>
  );
}

function HostHeading(props: {
  readonly sandbox: SandboxSummary;
  readonly configuration: string | null;
  readonly awake: boolean;
}): ReactNode {
  const { sandbox } = props;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          props.awake ? "bg-success" : "bg-muted-foreground/50",
        )}
      />
      <span className="font-medium break-words">{sandbox.displayName}</span>
      {props.configuration === null ? null : (
        <Badge size="xs" variant="muted">
          {props.configuration}
        </Badge>
      )}
      <span className="text-muted-foreground">
        {sandbox.frozen ? "frozen" : sandbox.state}
        {props.awake && sandbox.priceMcPerHour !== null
          ? ` · ${shortPriceLabel(sandbox.priceMcPerHour.awakeMc)}`
          : ""}
      </span>
    </div>
  );
}

function HostIdentityLine(props: {
  readonly sandbox: SandboxSummary;
  readonly epicId: string;
  readonly configuration: string | null;
  readonly awake: boolean;
}): ReactNode {
  const { sandbox } = props;
  const costs = useSandboxCosts();
  useRefreshSandboxCosts();
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const createdBy = memberName(sandbox.createdBy, viewerUserId);
  const payer = memberName(sandbox.wakePayer, viewerUserId);
  const creatorName = useMaybeEpicStore((state) => {
    const id = sandbox.createdByAgentId;
    if (id === null || sandbox.createdByTaskId !== props.epicId) return null;
    if (Object.hasOwn(state.chats.byId, id)) return state.chats.byId[id].title;
    if (Object.hasOwn(state.tuiAgents.byId, id))
      return state.tuiAgents.byId[id].title;
    return null;
  }, null);
  const now = useSampledNow();
  const cost = costs.data?.sandboxes.find(
    (row) => row.sandboxId === sandbox.id,
  );
  const payerName =
    payer ?? (props.configuration === "Personal" ? "you" : null);
  const startedBy =
    createdBy ?? (props.configuration === "Personal" ? "you" : null);
  return (
    <p className="text-muted-foreground">
      <HostIdentity
        sandbox={sandbox}
        creatorName={creatorName}
        startedBy={startedBy}
        payerName={payerName}
      />
      {props.awake
        ? ` · ${hoverAwakeMinutes(Math.max(0, Math.floor((now - sandbox.lastTransitionAt) / 60_000)))}`
        : ""}
      {cost === undefined ? "" : ` · ${hoverTodayCost(cost.todayMillicredits)}`}
    </p>
  );
}

function HostActions(props: {
  readonly sandbox: SandboxSummary;
  readonly epicId: string;
  readonly ownerHostUnreachable: boolean;
  readonly awake: boolean;
  readonly onKeep: (sandbox: SandboxSummary) => void;
}): ReactNode {
  const { sandbox } = props;
  const canOpen =
    !sandbox.frozen &&
    sandbox.state !== "destroyed" &&
    sandbox.state !== "destroying" &&
    sandbox.state !== "failed";
  const { openTile } = useEpicTileNavigation();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!canOpen || (props.awake && props.ownerHostUnreachable)}
        onClick={() => {
          openTile(
            tileIntent(
              mintNewEpicTerminalTile({
                hostId: sandbox.hostId,
                epicId: props.epicId,
                cwd: "",
              }),
              { epicId: props.epicId },
              "explicit",
              "direct_ui",
            ),
          );
        }}
      >
        {OPEN_TERMINAL}
      </Button>
      <HostFilesAction
        hostId={sandbox.hostId}
        disabled={!canOpen || props.ownerHostUnreachable}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => navigateToSettingsSection("devices")}
      >
        {DETAILS}
      </Button>
      {sandbox.burst && canOpen ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => props.onKeep(sandbox)}
        >
          {KEEP_THIS_SANDBOX}
        </Button>
      ) : null}
    </div>
  );
}

function HostIdentity(props: {
  readonly sandbox: SandboxSummary;
  readonly creatorName: string | null;
  readonly startedBy: string | null;
  readonly payerName: string | null;
}): ReactNode {
  const { sandbox } = props;
  const shape = `${sandbox.os === "linux" ? "Linux" : "Windows"} · ${sandboxShapeLabel(sandbox.cpus, sandbox.memoryMb)}`;
  if (!sandbox.burst) {
    return hoverSandboxIdentity({
      shape,
      creator: props.startedBy,
      payer: props.payerName,
    });
  }
  let identity = AGENT_SANDBOX;
  if (props.creatorName !== null && props.payerName !== null) {
    identity = hoverAgentIdentity(props.creatorName, props.payerName);
  }
  return (
    <>
      {identity}
      {" · "}
      {shape}
    </>
  );
}

function HostIdlePolicy(props: {
  readonly sandbox: SandboxSummary;
}): ReactNode {
  const catalogue = useSandboxCatalogue(
    !props.sandbox.burst && !props.sandbox.frozen,
  );
  const fidelity = catalogue.data?.providers.find(
    (provider) =>
      provider.provider === props.sandbox.provider &&
      provider.os.includes(props.sandbox.os),
  )?.suspendFidelity;
  const wake = fidelity === undefined ? null : wakeString(fidelity);
  if (props.sandbox.frozen || props.sandbox.state === "destroyed") return null;
  const idleMinutes = props.sandbox.idleMinutes ?? 30;
  const policy = props.sandbox.burst
    ? burstIdleLine(idleMinutes)
    : idleAndRestingLine(idleMinutes, props.sandbox.destroyAfterRestingMinutes);
  return (
    <p className="text-muted-foreground">
      {policy}
      {!props.sandbox.burst && wake !== null ? ` · ${wake}` : ""}
    </p>
  );
}

interface SessionSnapshot<T> {
  readonly data: T | undefined;
  readonly dataUpdatedAt: number;
  readonly isError: boolean;
  readonly isFetching: boolean;
}

/** Session facts must have settled after the host total they are subtracted from. */
function isCurrentSessionSnapshot<T>(
  snapshot: SessionSnapshot<T>,
  statusUpdatedAt: number,
): snapshot is SessionSnapshot<T> & { readonly data: T } {
  return (
    snapshot.data !== undefined &&
    !snapshot.isError &&
    !snapshot.isFetching &&
    snapshot.dataUpdatedAt >= statusUpdatedAt
  );
}

/** Published task files and a host's filesystem are separate destinations. */
function HostFilesAction(props: {
  readonly hostId: string | null;
  readonly disabled?: boolean;
}): ReactNode {
  const tabId = useEpicViewTabId();
  const openPanel = useEpicLeftPanelStore(
    (state) => state.setActivePanelIdAndExpand,
  );
  const setHost = useSurfaceHostSelectionStore((state) => state.setSelection);
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={props.disabled === true || tabId === null}
      onClick={() => {
        if (tabId === null) return;
        if (props.hostId !== null)
          setHost(tabSurfaceKey("file-tree", tabId), props.hostId);
        openPanel(tabId, props.hostId === null ? "artifacts" : "file-tree");
      }}
    >
      {props.hostId === null ? TASK_FILES : FILES}
    </Button>
  );
}

/** Observe a held status without dialing or waking a host to inspect it. */
function HostActivity(props: {
  readonly sandbox: SandboxSummary;
  readonly epicId: string;
  readonly nodeId: string;
  readonly ownerHostUnreachable: boolean;
}): ReactNode {
  const client = useHostClientForHostId(props.sandbox.hostId);
  const status = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: {},
    options: { enabled: false },
  });
  const count = status.data?.busySessionCount ?? null;
  const expired = useDeadlineReached(status.dataUpdatedAt + 30_000);
  const live =
    !props.ownerHostUnreachable &&
    !status.isError &&
    count !== null &&
    !expired;
  const agents = useHostQuery<HostRpcRegistry, "agent.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.list",
    params: { epicId: props.epicId, senderAgentId: props.nodeId, scope: "all" },
    options: { enabled: false },
  });
  const terminals = useHostQuery<HostRpcRegistry, "terminal.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "terminal.list",
    params: { scope: { kind: "epic", epicId: props.epicId } },
    options: { enabled: false },
  });
  const refreshAgents = agents.refetch;
  const refreshTerminals = terminals.refetch;
  useEffect(() => {
    if (!live) return;
    void refreshAgents();
    void refreshTerminals();
  }, [live, status.dataUpdatedAt, refreshAgents, refreshTerminals]);
  // A new count cannot be combined with this task's older session snapshots:
  // that would attribute newly started work here to an unreadable other task.
  if (
    !live ||
    !isCurrentSessionSnapshot(agents, status.dataUpdatedAt) ||
    !isCurrentSessionSnapshot(terminals, status.dataUpdatedAt)
  ) {
    return <p className="text-muted-foreground">{SESSIONS_UNKNOWN}</p>;
  }
  const here = agents.data.agents.filter(
    (agent) => agent.hostId === props.sandbox.hostId && agent.active,
  );
  const runningTerminals = terminals.data.sessions.filter(
    (terminal) =>
      terminal.status === "running" && terminal.sessionKind === "terminal",
  );
  const names = [
    ...here.flatMap((agent) => (agent.title === null ? [] : [agent.title])),
    ...runningTerminals.flatMap((terminal) =>
      terminal.title === null ? [] : [terminal.title],
    ),
  ];
  const more = Math.max(0, count - here.length - runningTerminals.length);
  return (
    <div className="text-muted-foreground">
      {names.length === 0 ? null : <p>{names.join(", ")}</p>}
      {more > 0 ? <p>{hoverMoreSessions(more)}</p> : null}
    </div>
  );
}
