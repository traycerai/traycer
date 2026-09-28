import { useCallback, useEffect, useId, useMemo } from "react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
  ManagedCommandStatus,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type { DockRowHotspot } from "@/components/chat/chat-lower-dock";
import { dockMemberFolded } from "@/components/chat/chat-dock-fold";
import type {
  ChatDockCompactChipModel,
  ChatDockCompactStripValue,
} from "@/components/chat/chat-dock-compact-strip";
import {
  chatDockSection,
  type ChatDockSection,
} from "@/lib/chat/chat-dock-sections";
import { CHAT_DOCK_FAILURE_PULSE_PREFIX } from "@/components/chat/chat-dock-compact-chip";
import {
  useChatDockOpenSection,
  useChatDockOpenStore,
} from "@/stores/chats/chat-dock-open-store";
import { chatChangesPanelHasContent } from "@/components/chat/chat-pinned-stack-utils";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { accumulatedDiffTotals } from "@/lib/chat/accumulated-change-rows";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import {
  backgroundHeaderSummary,
  backgroundSectionCounts,
  buildBackgroundTree,
  buildRememberedBackgroundNodes,
  dedupeByTaskId,
} from "@/lib/chat/background-item-tree";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { useArrangementValue, useRegionValues } from "@/lib/layout-overrides";

export interface ChatDockChrome {
  /** Sections standing as a pill right now, for the dock and for the spacing. */
  readonly folded: ReadonlySet<ChatDockSection>;
  /** The one pill whose panel is attached above the composer, or `null`. */
  readonly openSection: ChatDockSection | null;
  readonly strip: ChatDockCompactStripValue;
  /** The vertical order of the three reorderable dock rows. */
  readonly dockOrder: ReadonlyArray<ChatDockSection>;
  /** This tile's layout region for each of the three reorderable rows. */
  readonly hotspots: Readonly<Record<ChatDockSection, DockRowHotspot>>;
}

interface ChatDockChromeInput {
  readonly snapshotLoaded: boolean;
  readonly chatId: string;
  readonly restore: ChatRestoreContextValue;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly activeAgentsVisible: boolean;
  readonly backgroundVisible: boolean;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly runningManagedCommands: ReadonlyArray<ManagedCommand>;
  readonly heldManagedCommands: ReadonlyArray<HeldManagedCommandUpdate>;
  /**
   * The Background pill's failure-flavoured pulse token, or `null` when the
   * section's most recent news is not a failure.
   */
  readonly backgroundFailureToken: string | null;
  readonly portForwardCount: number;
  readonly queue: ChatSessionState["queue"];
  readonly todo: PinnedTodoSnapshot | null;
}

const NO_BACKGROUND_ITEMS: ReadonlyArray<BackgroundItem> = [];

/**
 * The Background pill's pulse token while the last thing to have happened in
 * the section is a shell that FAILED, else `null`.
 *
 * "Last thing to have happened" rather than "anything ever failed", because
 * the token is what the pill is standing in for RIGHT NOW: a live shell
 * outranks any finished one, and a failure the user has already seen must not
 * hold the ring red over work that started since. Keyed on the failed
 * command's id so a second failure is a second token and rings again, and a
 * re-render of the same one does not.
 */
export function failedManagedCommandPulseToken(
  commands: ReadonlyArray<ManagedCommand>,
): string | null {
  let latest: ManagedCommand | null = null;
  for (const command of commands) {
    if (command.status.state === "running") return null;
    if (latest === null || command.updatedAtMs > latest.updatedAtMs) {
      latest = command;
    }
  }
  if (latest === null || !managedCommandFailed(latest.status)) return null;
  return `${CHAT_DOCK_FAILURE_PULSE_PREFIX}${latest.id}`;
}

/**
 * A shell that ended badly. `stopped` is the user's own doing and never one;
 * `interrupted` is the host dying under a running command; an exit is a
 * failure unless it is a clean zero, which covers the killed-by-signal case
 * and the lost-process case (`exitCode` and `signal` both null) together.
 */
function managedCommandFailed(status: ManagedCommandStatus): boolean {
  switch (status.state) {
    case "running":
    case "stopped":
      return false;
    case "interrupted":
      return true;
    case "exited":
      return status.exitCode !== 0 || status.signal !== null;
  }
}

/**
 * Which dock rows are folded into a chip, what those chips say, and how the
 * user gets a row back.
 *
 * Expansion is component state, so it dies with the tile and is never written
 * to the setting: `compact` is a statement about how a chat OPENS, and having
 * one glance at a row silently redefine that for every chat is the failure a
 * per-tile reveal exists to avoid.
 */
export function useChatDockChrome(input: ChatDockChromeInput): ChatDockChrome {
  const dockRegionOrder = useArrangementValue("dock");
  const changedFilesValues = useRegionValues("changedFiles");
  const runningAgentsValues = useRegionValues("runningAgents");
  const backgroundValues = useRegionValues("background");
  const todoValues = useRegionValues("todo");
  const dockOrder = useMemo(
    () => dockRegionOrder.map(chatDockSection),
    [dockRegionOrder],
  );
  // Which pill this CHAT has open, remembered outside the React tree: a
  // same-pane chat switch is a full remount, and losing the open panel to one
  // is not what "I opened Files changed in this conversation" means. Nothing
  // ever opens on its own - a chat with no entry has no panel attached.
  const storedOpenSection = useChatDockOpenSection(input.chatId);
  const toggleOpenSection = useChatDockOpenStore(
    (state) => state.toggleSection,
  );
  const closeOpenSection = useChatDockOpenStore((state) => state.closeSection);
  const chatId = input.chatId;
  const onToggle = useCallback(
    (section: ChatDockSection) => {
      toggleOpenSection(chatId, section);
    },
    [toggleOpenSection, chatId],
  );
  // One id per dock, for the open pill's `aria-controls` and the panel it
  // names. `useId` because two chat tiles can be on screen at once.
  const panelId = useId();

  const changesPresent =
    input.snapshotLoaded && chatChangesPanelHasContent(input.restore);
  // This tile's three dock regions, registered here because this is the
  // component that DRAWS them. There is exactly one gate deciding whether a
  // mounted component's region reaches the editor, and it is inside
  // `useLayoutRegion`: it registers nothing from a surface whose
  // `PaneVisibilityContext` is false. Every epic surface publishes that from
  // its own top-level visibility (`epic-surface.tsx`,
  // `hosted-chat-surface-context-bridge.tsx`), and the sample workspace is a
  // plain top-level tab that is `splitEligibility: "ineligible"`, so while a
  // session is live the sample tab is the only visible surface and a real tile
  // registers nothing. That is the gate's job, not this file's: a per-site
  // opt-out here would be a second answer to the same question, and the six
  // other composer regions on this very tile (`mic`, `agent`, `access`,
  // `model`, `attachImage`, `contextUsage`) have never had one.
  const filesChangedHotspot = useLayoutRegion({
    regionId: "changedFiles",
    instanceId: input.chatId,
  });
  const activeAgentsHotspot = useLayoutRegion({
    regionId: "runningAgents",
    instanceId: input.chatId,
  });
  const backgroundHotspot = useLayoutRegion({
    regionId: "background",
    instanceId: input.chatId,
  });
  const todoHotspot = useLayoutRegion({
    regionId: "todo",
    instanceId: input.chatId,
  });
  // The root agent counts as running too when it is itself active, exactly as
  // `ActiveAgentsPanel`'s own header counts it.
  const agentsRunningCount =
    input.selfAgent === null
      ? 0
      : input.activeAgents.length +
        (input.selfAgent.activity === false ? 0 : 1);
  // Gated on `selfAgent` exactly as the count is, so the two never disagree.
  //
  // Mid-turn is the only tier that lights the chip. An agent kept alive by
  // background work alone is counted, but nothing is being written on its
  // behalf right now, and the sidebar's own row draws that tier at rest too.
  const agentsWorking =
    input.selfAgent !== null &&
    (input.selfAgent.activity === "turn" ||
      input.activeAgents.some((agent) => agent.activity === "turn"));
  const selfAgent = input.selfAgent;
  const agentsRoster = useMemo(
    () =>
      selfAgent === null
        ? null
        : agentRoster([selfAgent, ...input.activeAgents]),
    [selfAgent, input.activeAgents],
  );
  const backgroundItems = input.backgroundItems ?? NO_BACKGROUND_ITEMS;
  // Counted on the deduped list, exactly as `BackgroundItemsPanel` counts its
  // own header: a transient duplicate `taskId` renders one row there, so
  // counting the raw list here would make the chip say "2 waiting" against the
  // panel's "1 waiting".
  const dedupedBackgroundItems = useMemo(
    () => dedupeByTaskId(backgroundItems),
    [backgroundItems],
  );
  // The panel's own tree additionally carries forward parents it has seen
  // before. That history only ever MERGES roots, so a count over the delivered
  // items alone can come out one group HIGHER than the panel's, never lower -
  // rare, transient, and it converges on the panel's next render.
  const backgroundCounts = useMemo(
    () =>
      backgroundSectionCounts({
        tree: buildBackgroundTree(
          dedupedBackgroundItems,
          buildRememberedBackgroundNodes(dedupedBackgroundItems, new Map()),
        ),
        runningManagedCommandIds: input.runningManagedCommands.map(
          (command) => command.id,
        ),
        heldManagedCommandIds: input.heldManagedCommands.map(
          (held) => held.commandId,
        ),
        portForwardCount: input.portForwardCount,
      }),
    [
      dedupedBackgroundItems,
      input.runningManagedCommands,
      input.heldManagedCommands,
      input.portForwardCount,
    ],
  );
  const backgroundRunning = backgroundCounts.runningCount;
  const backgroundTotal = backgroundCounts.total;
  const backgroundSummary = useMemo(
    () => backgroundHeaderSummary(backgroundCounts),
    [backgroundCounts],
  );
  const changeTotals = useMemo(
    () => accumulatedDiffTotals(input.restore.accumulatedFileChanges),
    [input.restore.accumulatedFileChanges],
  );
  const changedFileCount =
    input.restore.accumulatedFileChanges.length +
    input.restore.undeliveredChangeCount;

  // A pill exists for every compact section that HAS something to show,
  // whether or not its panel is open - the pill is the way back, so it cannot
  // be the thing that disappears when the panel appears.
  const filesChip = dockMemberFolded({
    values: changedFilesValues,
    ghost: filesChangedHotspot.ghost,
    hasContent: changesPresent,
  });
  // Agents only. Replies other agents sent are queued messages, and the queue
  // is never a pill (G1-G2, staging round 4): the dock is handed the whole
  // queue, so counting them here too would be a second surface for one row.
  const agentsChip = dockMemberFolded({
    values: runningAgentsValues,
    ghost: activeAgentsHotspot.ghost,
    hasContent: input.activeAgentsVisible,
  });
  const backgroundChip = dockMemberFolded({
    values: backgroundValues,
    ghost: backgroundHotspot.ghost,
    hasContent: input.backgroundVisible,
  });

  // Todo is a dock member too (L-139): same Full row / Chip / Hidden
  // semantics, same reordering, same pill treatment.
  const todo = input.todo;
  const todoCounts = useMemo(() => {
    if (todo === null) return null;
    return {
      done: todo.items.filter((item) => item.status === "completed").length,
      total: todo.items.length,
    };
  }, [todo]);
  const todoHasContent = input.snapshotLoaded && todo !== null;
  const todoChip = dockMemberFolded({
    values: todoValues,
    ghost: todoHotspot.ghost,
    hasContent: todoHasContent,
  });

  const chipPresent: Readonly<Record<ChatDockSection, boolean>> = {
    filesChanged: filesChip,
    activeAgents: agentsChip,
    background: backgroundChip,
    todo: todoChip,
  };
  // The remembered pill only counts while its pill is actually there. Derived
  // rather than written, so a chat whose snapshot has not landed yet keeps
  // what it had open instead of having it erased by a loading frame.
  const openSectionPillPresent =
    storedOpenSection !== null && chipPresent[storedOpenSection];
  const openSection = openSectionPillPresent ? storedOpenSection : null;
  // A section that EMPTIES while the chat is loaded is a real close, and the
  // memory goes with it: the user reverts every change, the pill goes away,
  // and the next turn's changes must not re-open a panel nobody asked for.
  useEffect(() => {
    if (storedOpenSection === null) return;
    if (!input.snapshotLoaded) return;
    if (openSectionPillPresent) return;
    closeOpenSection(chatId);
  }, [
    storedOpenSection,
    input.snapshotLoaded,
    openSectionPillPresent,
    closeOpenSection,
    chatId,
  ]);

  // Every pill-sized member is folded, open or not: an open pill's panel is
  // the frame's topmost attached one, never a row in dock order (L-142).
  const folded = useMemo(() => {
    const sections = new Set<ChatDockSection>();
    if (filesChip) sections.add("filesChanged");
    if (agentsChip) sections.add("activeAgents");
    if (backgroundChip) sections.add("background");
    if (todoChip) sections.add("todo");
    return sections;
  }, [filesChip, agentsChip, backgroundChip, todoChip]);

  const chips = useMemo<ReadonlyArray<ChatDockCompactChipModel>>(() => {
    const models: ChatDockCompactChipModel[] = [];
    if (filesChip) {
      models.push({
        section: "filesChanged",
        glyph: "filesChanged",
        // The pill is the member's ONE anchor, open or closed (L-142). It is
        // drawn whenever the member is pill-sized, and the panel it opens is
        // content rather than a second registration - two elements registering
        // the same region and instance share one key, so the later would
        // silently displace the earlier (`ghost-region.tsx`).
        hotspotRef: filesChangedHotspot.ref,
        working: false,
        // The file count leads and the line counts follow, the same order and
        // the same tones the panel's own header uses - the chip stands in for
        // that header, so reading one after the other should feel like reading
        // the same row twice, not like two different measurements.
        text: `${changedFileCount}`,
        lineDeltas: changeTotals,
        label: filesChangedLabel(changedFileCount, changeTotals),
        detail: filesChangedDetail(changedFileCount, changeTotals),
        // Constant, so this fires on the chip's arrival and never again -
        // which is the first change of the chat, since the chip exists only
        // once there is one. Keying it on the line counts instead reads well
        // in the abstract and is unbearable in practice: they are summed per
        // edit while a turn is still writing, so a turn touching twelve files
        // rang the chip beside the input twelve times.
        pulseToken: "changed",
      });
    }
    if (agentsChip) {
      models.push({
        section: "activeAgents",
        glyph: "activeAgents",
        hotspotRef: activeAgentsHotspot.ref,
        // Mid-turn is the live state here, exactly as the roster in `label`
        // words it - the chip draws it, the sentence says it.
        working: agentsWorking,
        lineDeltas: null,
        text: `${agentsRunningCount}`,
        // The roster is the panel's row list folded into the sentence: the
        // chip is the only door to that list while the row is away, so its
        // tooltip has to say WHO is running, not just how many.
        label: `Active agents. ${agentsRunningCount} running.${agentsRoster === null ? "" : ` ${agentsRoster}.`}`,
        // Counts, not the roster: the sentence above names who is running for
        // a screen reader, and a tooltip that listed three agents and "and 2
        // more" under a heading would stop being the small block L-153 asks
        // for. The panel one click away is where the roster belongs.
        detail: `${agentsRunningCount} running`,
        // Only the first agent starting is worth an eye-flick - which is the
        // moment this chip appears; a count moving between two non-zero values
        // is the same fact, updated.
        pulseToken: agentsRunningCount > 0 ? "running" : null,
      });
    }
    if (backgroundChip) {
      models.push({
        section: "background",
        // The section's own mark whatever the rows are - activity lights it
        // rather than replacing it, and the kinds are the panel's to draw.
        glyph: "background",
        hotspotRef: backgroundHotspot.ref,
        // Only running work lights the chip, so a pending wake or a held
        // shell rests it - and a shell whose process is alive is running
        // whether or not it is monitoring, since the host reports it as
        // `running` either way (`managedCommandStatusSchema`).
        working: backgroundRunning > 0,
        lineDeltas: null,
        // Everything the panel lists, not just the running part: a chip that
        // said `0` over a pending wake read as an empty section.
        text: `${backgroundTotal}`,
        // The header's own summary names which parts make up that number.
        label: `Background. ${backgroundSummary}.`,
        detail: backgroundSummary,
        // A failure outranks the plain arrival: it is the one thing this
        // section can report that is not simply news, and the ring is the
        // only channel it has while the row is folded into a pill.
        pulseToken:
          input.backgroundFailureToken ??
          (backgroundRunning > 0 ? "running" : null),
      });
    }
    if (todoChip && todoCounts !== null) {
      models.push({
        section: "todo",
        glyph: "todo",
        hotspotRef: todoHotspot.ref,
        working: false,
        lineDeltas: null,
        // `done/total`, the same measurement the full row prints at its right
        // edge, in the same order.
        text: `${todoCounts.done}/${todoCounts.total}`,
        label: `Todo. ${todoCounts.done} of ${todoCounts.total} done.`,
        detail: `${todoCounts.done} of ${todoCounts.total} done`,
        // Constant: the list arriving is the news, and a pill that flicked on
        // every completed item would ring through a whole plan.
        pulseToken: "todo",
      });
    }
    return dockOrder.flatMap((section) =>
      models.filter((model) => model.section === section),
    );
  }, [
    dockOrder,
    filesChip,
    agentsChip,
    backgroundChip,
    todoChip,
    todoCounts,
    backgroundSummary,
    changeTotals,
    changedFileCount,
    agentsRunningCount,
    agentsWorking,
    agentsRoster,
    backgroundRunning,
    backgroundTotal,
    input.backgroundFailureToken,
    filesChangedHotspot.ref,
    activeAgentsHotspot.ref,
    backgroundHotspot.ref,
    todoHotspot.ref,
  ]);

  const strip = useMemo<ChatDockCompactStripValue>(
    () => ({ chips, openSection, panelId, onToggle }),
    [chips, openSection, panelId, onToggle],
  );

  const hotspots: Readonly<Record<ChatDockSection, DockRowHotspot>> = {
    filesChanged: {
      hotspotRef: filesChangedHotspot.ref,
      editing: filesChangedHotspot.editing,
      ghost: filesChangedHotspot.ghost,
      shown: changedFilesValues.shown === "shown",
      hasContent: changesPresent,
    },
    activeAgents: {
      hotspotRef: activeAgentsHotspot.ref,
      editing: activeAgentsHotspot.editing,
      ghost: activeAgentsHotspot.ghost,
      shown: runningAgentsValues.shown === "shown",
      hasContent: input.activeAgentsVisible,
    },
    background: {
      hotspotRef: backgroundHotspot.ref,
      editing: backgroundHotspot.editing,
      ghost: backgroundHotspot.ghost,
      shown: backgroundValues.shown === "shown",
      hasContent: input.backgroundVisible,
    },
    todo: {
      hotspotRef: todoHotspot.ref,
      editing: todoHotspot.editing,
      ghost: todoHotspot.ghost,
      shown: todoValues.shown === "shown",
      hasContent: todoHasContent,
    },
  };

  return { folded, openSection, strip, dockOrder, hotspots };
}

/** How many agents the chip's sentence names before it starts counting. */
const ROSTER_NAME_LIMIT = 3;

/**
 * The agents by name and state, as one clause: `Planner working, Reviewer in
 * background`. Null when there is no one to name, so the sentence it joins
 * ends cleanly instead of trailing an empty clause.
 *
 * Capped, because the roster is bounded by fleet size and nothing else - a
 * workflow fanning out to a dozen agents with free-form titles would put a
 * paragraph on the chip's accessible name, read out in full before the count
 * the listener actually asked for. The names past the cap become a number; the
 * panel one click away is still the whole list.
 */
function agentRoster(agents: ReadonlyArray<AgentRow>): string | null {
  if (agents.length === 0) return null;
  const named = agents
    .slice(0, ROSTER_NAME_LIMIT)
    .map((agent) => `${agent.title} ${agentStateWord(agent.activity)}`);
  const remaining = agents.length - named.length;
  if (remaining > 0) named.push(`and ${remaining} more`);
  return named.join(", ");
}

function agentStateWord(activity: AgentRow["activity"]): string {
  switch (activity) {
    case "turn":
      return "working";
    case "background":
      return "in background";
    case false:
      return "idle";
  }
  const unreachable: never = activity;
  return unreachable;
}

function fileCountPhrase(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/**
 * The chip's accessible name, spelling out what it draws: the `+` and `−` on
 * screen are two colours and a pair of signs, and neither reads aloud.
 *
 * A zero side is dropped here exactly as it is dropped on screen, so the name
 * and the chip say the same thing - and with both zero the sentence stops
 * after the file count rather than claiming "0 lines added".
 */
function filesChangedLabel(fileCount: number, totals: DiffLineCounts): string {
  const parts = [fileCountPhrase(fileCount)];
  if (totals.additions > 0) {
    parts.push(`${totals.additions} ${lineWord(totals.additions)} added`);
  }
  // The noun rides on whichever clause comes first: "12 lines added, 4
  // removed" says what it means, and repeating "lines" in the second clause
  // only makes the sentence longer.
  if (totals.deletions > 0) {
    parts.push(
      totals.additions > 0
        ? `${totals.deletions} removed`
        : `${totals.deletions} ${lineWord(totals.deletions)} removed`,
    );
  }
  return `Files changed. ${parts.join(", ")}.`;
}

/**
 * The Files changed pill's tooltip detail: the same two measurements the pill
 * itself draws, in the same order and with the same signs - "3 files, +47 −9".
 *
 * The signs rather than the words, deliberately: this line is read beside the
 * pill that prints them, so a reader is matching it against what is on screen.
 * `filesChangedLabel` above is the same fact for a screen reader, which is why
 * it spells "lines added" instead. A zero side is dropped in both.
 *
 * The `−` is U+2212 MINUS SIGN, matching `diff-line-deltas.tsx` - a hyphen
 * here would read as a different glyph two centimetres from the real one.
 */
function filesChangedDetail(fileCount: number, totals: DiffLineCounts): string {
  const deltas: string[] = [];
  if (totals.additions > 0) deltas.push(`+${totals.additions}`);
  if (totals.deletions > 0) deltas.push(`−${totals.deletions}`);
  const files = fileCountPhrase(fileCount);
  return deltas.length === 0 ? files : `${files}, ${deltas.join(" ")}`;
}

function lineWord(count: number): string {
  return count === 1 ? "line" : "lines";
}
