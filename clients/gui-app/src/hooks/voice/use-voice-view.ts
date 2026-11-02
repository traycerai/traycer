import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import { humanActionableApprovals } from "@/components/epic-canvas/renderers/chat-approval-visibility";
import { useRouterPathname } from "@/hooks/routing/use-router-pathname";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import { epicsSource } from "@/lib/commands/sources/epics.source";
import {
  navigationSource,
  SETTINGS_SUBPAGE,
} from "@/lib/commands/sources/navigation.source";
import { useAgentsOpenerItems } from "@/lib/commands/sources/open/agents-subpage";
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { THEME_SUBPAGE_ITEMS } from "@/lib/commands/sources/theme.source";
import type { CommandContext } from "@/lib/commands/types";
import { hostEntryNeedsWake } from "@/hooks/sandboxes/use-sandbox-wake-on-tile-open";
import { composerSendStateFor } from "@/lib/chats/composer-send-gates";
import { useHostDirectory } from "@/lib/host";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import type {
  PageActReads,
  VoiceAgentSession,
  VoicePaletteRow,
} from "@/lib/voice/page-acts";
import {
  approvalSummary,
  itemHostWake,
  composeVoiceView,
  NO_PALETTE_ITEMS,
  type HostWake,
  type VoicePage,
  type VoicePaletteItems,
  type VoiceView,
  type VoiceViewAgent,
  type VoiceViewApproval,
} from "@/lib/voice/view";
import {
  getActiveTileOwner,
  type ActiveTileOwner,
} from "@/stores/active-tile-owner";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import type { TabRef } from "@/stores/tabs/types";
import {
  chatActivityIndicator,
  composerTurnStatus,
  resolvedTurnStatus,
  type ChatActivityIndicator,
  type ComposerTurnStatus,
} from "@/stores/chats/chat-run-activity";
import { useTileFindStore } from "@/stores/tile-find";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/** The view the router is shown, read when a route is made and when it runs. */
export interface VoiceViewHandle extends PageActReads {
  /** The snapshot from what the app holds now. */
  readonly current: () => VoiceView;
  /** What {@link VoiceViewPaletteItems} hands over, and the context it composed them for. */
  readonly setPaletteItems: (
    items: VoicePaletteItems,
    composedFor: string | null,
    ctx: CommandContext | null,
  ) => void;
}

/** The focused ref's task tab, unless a phase migration holds it: no task is shown then. */
function focusedTaskTabId(focused: TabRef | null): string | null {
  if (focused?.kind !== "epic") return null;
  const tab = useEpicCanvasStore.getState().tabsById[focused.id];
  return tab === undefined || tab.surfaceMode?.kind === "phase-migration"
    ? null
    : tab.tabId;
}

function settingsSectionIdOf(pathname: string): string | null {
  const parts = pathname.split("/");
  return parts.length > 2 && parts[1] === "settings" ? parts[2] : null;
}

function readTaskPage(focused: TabRef): VoicePage {
  const tabId = focusedTaskTabId(focused);
  if (tabId === null) return { kind: "home" };
  const canvas = useEpicCanvasStore.getState();
  const owner = getActiveTileOwner();
  const tile =
    owner !== null && owner.viewTabId === tabId
      ? canvas.canvasByTabId[tabId]?.tilesByInstanceId[owner.tileInstanceId]
      : undefined;
  return {
    kind: "task",
    title: canvas.tabsById[tabId]?.name ?? "",
    tile: tile?.name ?? null,
  };
}

/** The same tuple as the focus while the focus is on the surface's bot. */
function readTracyPage(): VoicePage {
  const botId = useTracySurfaceStore.getState().botId;
  const focus = useVoiceSessionStore.getState().focus;
  return {
    kind: "tracy",
    botId,
    threadId: focus !== null && focus.botId === botId ? focus.threadId : null,
  };
}

function readSettingsPage(pathname: string): VoicePage {
  const sectionId = settingsSectionIdOf(pathname);
  const section = SETTINGS_SECTIONS.find(
    (candidate) => candidate.id === sectionId,
  );
  return { kind: "settings", section: section?.label ?? null };
}

function readPage(pathname: string, focused: TabRef | null): VoicePage {
  const blocker = useTileFindStore.getState().ownerBlocker;
  if (blocker?.reason === "notification-popover") {
    return { kind: "notifications" };
  }
  switch (focused?.kind) {
    case "epic":
      return readTaskPage(focused);
    case "tracy":
      return readTracyPage();
    case "history":
      return { kind: "history" };
    case "settings":
      return readSettingsPage(pathname);
    // A draft and the sample workspace show the landing composer, which has
    // no page of its own to speak of; with nothing focused, Home is in front.
    case "home":
    case "draft":
    case "sample-workspace":
    case undefined:
      return { kind: "home" };
  }
}

interface AgentRead {
  readonly agent: VoiceViewAgent | null;
  readonly turnRunning: boolean;
  readonly asleep: boolean;
  readonly approvals: ReadonlyArray<VoiceViewApproval>;
}

const NO_AGENT: AgentRead = {
  agent: null,
  turnRunning: false,
  asleep: false,
  approvals: [],
};

/** The chat session in the task's active tile, peeked, never opened. */
function readAgentSession(
  tabId: string | null,
  owner: ActiveTileOwner | null,
): VoiceAgentSession | null {
  if (tabId === null || owner === null || owner.viewTabId !== tabId) {
    return null;
  }
  const ref =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
      owner.tileInstanceId
    ];
  if (ref?.type !== "chat") return null;
  const handle = getChatSessionRegistry().peek(
    owner.epicId,
    ref.id,
    ref.hostId,
  );
  if (handle === null) return null;
  return {
    handle,
    chatId: ref.id,
    epicId: owner.epicId,
    hostId: ref.hostId,
    tileInstanceId: owner.tileInstanceId,
    title: ref.name,
  };
}

/** A frozen sandbox can't be woken, so there is no question to put about it. */
function composerAsksToWake(session: VoiceAgentSession): boolean {
  const composer = composerSendStateFor(
    session.hostId,
    session.chatId,
    session.tileInstanceId,
  );
  return composer?.restingSandbox === true && !composer.sandboxFrozen;
}

function hostWakeOf(entry: HostDirectoryEntry | null): HostWake {
  if (!hostEntryNeedsWake(entry)) return "none";
  return entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox?.frozen === true
    ? "frozen"
    : "wakes";
}

/** What the chat in the task's active tile is doing. */
function readAgent(
  tabId: string | null,
  owner: ActiveTileOwner | null,
): AgentRead {
  const session = readAgentSession(tabId, owner);
  if (session === null) return NO_AGENT;
  const chat = session.handle.store.getState();
  const approvals = humanActionableApprovals(chat.pendingApprovals).map(
    (approval) => ({
      id: approval.approvalId,
      summary: approvalSummary(approval.description, approval.toolName),
    }),
  );
  const waiting = approvals.length > 0;
  // Not the raw `runStatus`: work left running after a turn ended keeps it
  // `running` with no turn to stop.
  const turnStatus = resolvedTurnStatus(
    chat,
    composerTurnStatus(chat.runStatus),
  );
  return {
    agent: {
      chatId: session.chatId,
      title: session.title,
      state: waiting
        ? "waiting"
        : activityStateOf(turnStatus, chatActivityIndicator(chat)),
      waitingOn: waiting ? "approval" : null,
      turnId: chat.activeTurn?.turnId ?? null,
    },
    // A send that has not started its turn reads as running too, and there is
    // no turn yet for a stop to be asked of.
    turnRunning: turnStatus === "running" && chat.activeTurn !== null,
    asleep: composerAsksToWake(session),
    approvals,
  };
}

function activityStateOf(
  turnStatus: ComposerTurnStatus,
  indicator: ChatActivityIndicator,
): VoiceViewAgent["state"] {
  if (turnStatus !== null) return "working";
  return indicator === null ? "idle" : "background";
}

function readVoiceView(
  pathname: string,
  palette: VoicePaletteItems,
): VoiceView {
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const page = readPage(pathname, focused);
  const read = readAgent(focusedTaskTabId(focused), getActiveTileOwner());
  return composeVoiceView({
    page,
    agent: read.agent,
    agentTurnRunning: read.turnRunning,
    agentAsleep: read.asleep,
    approvals: read.approvals,
    palette,
    generation: useVoiceSessionStore.getState().viewGeneration,
  });
}

/** Which page is in front, to tell a move of the page from every other store change. */
function pageKeyOf(pathname: string): string {
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const section =
    focused?.kind === "settings" ? settingsSectionIdOf(pathname) : null;
  return JSON.stringify([focused?.kind ?? null, focused?.id ?? null, section]);
}

function ownerKeyOf(): string | null {
  return getActiveTileOwner()?.tileInstanceId ?? null;
}

/**
 * What a palette composition depends on, so rows are never paired with a page
 * they were not composed for. Reads the same facts as
 * {@link useVoiceCommandContext}, there through subscriptions.
 */
function paletteContextKey(
  pathname: string,
  focused: TabRef | null,
  paneId: string | null,
): string {
  return JSON.stringify([
    pathname,
    focused?.kind ?? null,
    focused?.id ?? null,
    paneId,
  ]);
}

function livePaletteContextKey(pathname: string): string {
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const tabId = focused?.kind === "epic" ? focused.id : null;
  const canvas = useEpicCanvasStore.getState();
  const paneId =
    tabId === null ? null : (canvas.canvasByTabId[tabId]?.activePaneId ?? null);
  return paletteContextKey(pathname, focused, paneId);
}

interface PublishedPalette {
  readonly items: VoicePaletteItems;
  readonly composedFor: string | null;
  readonly ctx: CommandContext | null;
}

const NO_PALETTE: PublishedPalette = {
  items: NO_PALETTE_ITEMS,
  composedFor: null,
  ctx: null,
};

/** The item behind a row, while the palette still offers it as something to run. */
function offeredItem(
  items: VoicePaletteItems,
  action: string,
): VoicePaletteRow["item"] | null {
  const item = [
    ...items.tiles,
    ...items.sections,
    ...items.tasks,
    ...items.themes,
    ...items.commands,
  ].find((candidate) => candidate.id === action);
  return item === undefined || item.subpage !== null || item.disabled === true
    ? null
    : item;
}

/**
 * The page the voice router sees (Tracy Bots voice, VT9), beside its
 * directory (`useVoiceDirectory`). Composed on demand, never on render, from
 * the tabs store, the route, the active tile owner and its chat session, with
 * the palette's rows from {@link VoiceViewPaletteItems}. While the palette has
 * not yet composed for the page in front, the view offers no registry rows.
 *
 * While a session runs it also moves the store's `viewGeneration` with the
 * page in front. The owner is compared once its store has settled: a tile
 * replacing its find adapter gives up its target and registers again within
 * one tick, and is the same owner before and after.
 */
export function useVoiceView(enabled: boolean): VoiceViewHandle {
  const router = useRouter();
  const paletteRef = useRef<PublishedPalette>(NO_PALETTE);
  const settleOwnerRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    const viewChanged = (): void => {
      useVoiceSessionStore.getState().viewChanged();
    };
    let page = pageKeyOf(router.history.location.pathname);
    const checkPage = (): void => {
      const next = pageKeyOf(router.history.location.pathname);
      if (next === page) return;
      page = next;
      viewChanged();
    };
    let owner = ownerKeyOf();
    const settleOwner = (): void => {
      const next = ownerKeyOf();
      if (next === owner) return;
      owner = next;
      viewChanged();
    };
    let ownerCheckQueued = false;
    let disposed = false;
    const queueOwnerCheck = (): void => {
      if (ownerCheckQueued) return;
      ownerCheckQueued = true;
      queueMicrotask(() => {
        ownerCheckQueued = false;
        if (!disposed) settleOwner();
      });
    };
    settleOwnerRef.current = settleOwner;
    const unsubscribers = [
      useTabsStore.subscribe(checkPage),
      useTileFindStore.subscribe(queueOwnerCheck),
      router.history.subscribe(checkPage),
    ];
    return () => {
      disposed = true;
      settleOwnerRef.current = () => undefined;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [enabled, router]);

  const current = useCallback((): VoiceView => {
    settleOwnerRef.current();
    const pathname = router.history.location.pathname;
    const palette = paletteRef.current;
    return readVoiceView(
      pathname,
      palette.composedFor === livePaletteContextKey(pathname)
        ? palette.items
        : NO_PALETTE_ITEMS,
    );
  }, [router]);
  const setPaletteItems = useCallback(
    (
      items: VoicePaletteItems,
      composedFor: string | null,
      ctx: CommandContext | null,
    ): void => {
      paletteRef.current = { items, composedFor, ctx };
    },
    [],
  );
  const paletteRow = useCallback(
    (action: string): VoicePaletteRow | null => {
      const { items, composedFor, ctx } = paletteRef.current;
      if (
        ctx === null ||
        composedFor !== livePaletteContextKey(router.history.location.pathname)
      ) {
        return null;
      }
      const item = offeredItem(items, action);
      return item === null
        ? null
        : { item, ctx, hostWake: itemHostWake(item, items) };
    },
    [router],
  );
  return useMemo(
    () => ({ current, setPaletteItems, agentSession, paletteRow }),
    [current, setPaletteItems, paletteRow],
  );
}

/** The chat on the page in front; with an id, only while it is that chat. */
function agentSession(chatId: string | null): VoiceAgentSession | null {
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const session = readAgentSession(
    focusedTaskTabId(focused),
    getActiveTileOwner(),
  );
  return session === null || (chatId !== null && session.chatId !== chatId)
    ? null
    : session;
}

/**
 * The `CommandContext` for the active tab, as the palette builds it for its
 * own surface: the task only while a task is in front (the canvas keeps its
 * active tab behind Home and Settings), and its focused pane as the group
 * the opener's rows open into.
 */
function useVoiceCommandContext(): {
  readonly ctx: CommandContext;
  readonly composedFor: string;
} {
  const router = useCommandPaletteRouter();
  const pathname = useRouterPathname(useRouter());
  const focused = useTabsStore(selectHostFocusedRef);
  const focusedTabId = focused?.kind === "epic" ? focused.id : null;
  const tab = useEpicCanvasStore((state) =>
    focusedTabId === null ? null : (state.tabsById[focusedTabId] ?? null),
  );
  const paneId = useEpicCanvasStore((state) =>
    focusedTabId === null
      ? null
      : (state.canvasByTabId[focusedTabId]?.activePaneId ?? null),
  );
  const ctx = useMemo(() => {
    const inTask = tab !== null && tab.surfaceMode?.kind !== "phase-migration";
    return {
      pathname,
      router,
      activeTabId: inTask ? tab.tabId : null,
      activeEpicId: inTask ? tab.epicId : null,
      focusedComposerKind: null,
      targetGroupId: inTask ? paneId : null,
    };
  }, [paneId, pathname, router, tab]);
  return { ctx, composedFor: paletteContextKey(pathname, focused, paneId) };
}

/**
 * Mirrors `useCommandItems` for the sources the view offers, so a row exists
 * exactly when the palette would show it. A component rather than a hook of
 * {@link useVoiceView}: like the palette's own list, these subscriptions (the
 * history read among them) run only while a session runs, never behind an
 * idle voice.
 */
export function VoiceViewPaletteItems(props: {
  readonly onItems: VoiceViewHandle["setPaletteItems"];
}): null {
  const { onItems } = props;
  const { ctx, composedFor } = useVoiceCommandContext();
  const actionItems = actionsSource.useItems(ctx);
  const navItems = navigationSource.useItems(ctx);
  const sectionItems = SETTINGS_SUBPAGE.useItems(ctx);
  const taskItems = epicsSource.useItems(ctx);
  const agentItems = useAgentsOpenerItems(ctx);
  const artifactItems = useArtifactsOpenerItems(ctx);
  const directory = useHostDirectory();

  useEffect(() => {
    onItems(
      {
        // The opener's creation leaves are not tiles of the task.
        tiles: [
          ...agentItems.filter((item) => item.agentTreeRow !== undefined),
          ...artifactItems,
        ],
        sections: sectionItems,
        tasks: taskItems,
        themes: THEME_SUBPAGE_ITEMS,
        commands: [...navItems, ...actionItems],
        // Read when asked: a sandbox sleeps without moving anything above.
        hostWake: (hostId) => hostWakeOf(directory.findById(hostId)),
      },
      composedFor,
      ctx,
    );
  }, [
    actionItems,
    agentItems,
    artifactItems,
    composedFor,
    ctx,
    directory,
    navItems,
    onItems,
    sectionItems,
    taskItems,
  ]);
  useEffect(() => () => onItems(NO_PALETTE_ITEMS, null, null), [onItems]);
  return null;
}
