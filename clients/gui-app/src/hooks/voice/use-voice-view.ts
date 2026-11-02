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
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import {
  approvalSummary,
  composeVoiceView,
  NO_PALETTE_ITEMS,
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
import { useTileFindStore } from "@/stores/tile-find";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/** The view the router is shown, read when a route is made. */
export interface VoiceViewHandle {
  /** The snapshot from what the app holds now. */
  readonly current: () => VoiceView;
  /** What {@link VoiceViewPaletteItems} hands over; the view reads the latest. */
  readonly setPaletteItems: (items: VoicePaletteItems) => void;
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
  readonly approvals: ReadonlyArray<VoiceViewApproval>;
}

const NO_AGENT: AgentRead = {
  agent: null,
  turnRunning: false,
  approvals: [],
};

/** The chat in the task's active tile and what it is doing, peeked, never opened. */
function readAgent(
  tabId: string | null,
  owner: ActiveTileOwner | null,
): AgentRead {
  if (tabId === null || owner === null || owner.viewTabId !== tabId) {
    return NO_AGENT;
  }
  const ref =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
      owner.tileInstanceId
    ];
  if (ref?.type !== "chat") return NO_AGENT;
  const handle = getChatSessionRegistry().peek(
    owner.epicId,
    ref.id,
    ref.hostId,
  );
  if (handle === null) return NO_AGENT;
  const chat = handle.store.getState();
  const approvals = humanActionableApprovals(chat.pendingApprovals).map(
    (approval) => ({
      id: approval.approvalId,
      summary: approvalSummary(approval.description, approval.toolName),
    }),
  );
  const waiting = approvals.length > 0;
  const state: VoiceViewAgent["state"] =
    chat.runStatus === "idle" ? "idle" : "working";
  return {
    agent: {
      chatId: ref.id,
      title: ref.name,
      state: waiting ? "waiting" : state,
      waitingOn: waiting ? "approval" : null,
    },
    turnRunning: chat.runStatus === "running",
    approvals,
  };
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
    approvals: read.approvals,
    palette,
    generation: useVoiceSessionStore.getState().viewGeneration,
  });
}

/** Which page is in front, to tell a move of the view from every other store change. */
function viewKeyOf(pathname: string): string {
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const section =
    focused?.kind === "settings" ? settingsSectionIdOf(pathname) : null;
  return JSON.stringify([
    focused?.kind ?? null,
    focused?.id ?? null,
    getActiveTileOwner()?.tileInstanceId ?? null,
    section,
  ]);
}

/**
 * The page the voice router sees (Tracy Bots voice, VT9), beside its
 * directory (`useVoiceDirectory`). Composed on demand, never on render, from
 * the tabs store, the route, the active tile owner and its chat session, with
 * the palette's rows from {@link VoiceViewPaletteItems}. While a session runs
 * it also moves the store's `viewGeneration` with the page in front.
 */
export function useVoiceView(enabled: boolean): VoiceViewHandle {
  const router = useRouter();
  const paletteRef = useRef<VoicePaletteItems>(NO_PALETTE_ITEMS);

  useEffect(() => {
    if (!enabled) return undefined;
    let last = viewKeyOf(router.history.location.pathname);
    const check = (): void => {
      const next = viewKeyOf(router.history.location.pathname);
      if (next === last) return;
      last = next;
      useVoiceSessionStore.getState().viewChanged();
    };
    const unsubscribers = [
      useTabsStore.subscribe(check),
      useTileFindStore.subscribe(check),
      router.history.subscribe(check),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [enabled, router]);

  const current = useCallback(
    (): VoiceView =>
      readVoiceView(router.history.location.pathname, paletteRef.current),
    [router],
  );
  const setPaletteItems = useCallback((items: VoicePaletteItems): void => {
    paletteRef.current = items;
  }, []);
  return useMemo(
    () => ({ current, setPaletteItems }),
    [current, setPaletteItems],
  );
}

/**
 * The `CommandContext` for the active tab, as the palette builds it for its
 * own surface: the task only while a task is in front (the canvas keeps its
 * active tab behind Home and Settings), and its focused pane as the group
 * the opener's rows open into.
 */
function useVoiceCommandContext(): CommandContext {
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
  return useMemo(() => {
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
}

/**
 * Mirrors `useCommandItems` for the sources the view offers, so a row exists
 * exactly when the palette would show it. A component rather than a hook of
 * {@link useVoiceView}: like the palette's own list, these subscriptions (the
 * history read among them) run only while a session runs, never behind an
 * idle voice.
 */
export function VoiceViewPaletteItems(props: {
  readonly onItems: (items: VoicePaletteItems) => void;
}): null {
  const { onItems } = props;
  const ctx = useVoiceCommandContext();
  const actionItems = actionsSource.useItems(ctx);
  const navItems = navigationSource.useItems(ctx);
  const sectionItems = SETTINGS_SUBPAGE.useItems(ctx);
  const taskItems = epicsSource.useItems(ctx);
  const agentItems = useAgentsOpenerItems(ctx);
  const artifactItems = useArtifactsOpenerItems(ctx);

  useEffect(() => {
    onItems({
      // The opener's creation leaves are not tiles of the task.
      tiles: [
        ...agentItems.filter((item) => item.agentTreeRow !== undefined),
        ...artifactItems,
      ],
      sections: sectionItems,
      tasks: taskItems,
      themes: THEME_SUBPAGE_ITEMS,
      commands: [...navItems, ...actionItems],
    });
  }, [
    actionItems,
    agentItems,
    artifactItems,
    navItems,
    onItems,
    sectionItems,
    taskItems,
  ]);
  useEffect(() => () => onItems(NO_PALETTE_ITEMS), [onItems]);
  return null;
}
