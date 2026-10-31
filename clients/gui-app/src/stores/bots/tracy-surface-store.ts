import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

/**
 * The source store behind the one Tracy surface of a window (decision 150):
 * the `tracy` tab kind's single ref exists while `open` holds, and its header
 * tab and route are derived from what is here.
 *
 * - `hostId` is the surface's binding: set when the surface first opens (the
 *   window's host), moved only when this client can no longer dial it
 *   (`rebindUnreachableTracySurface`). A channel switch never moves it: the
 *   surface's host serves every bot's channel, threads and sessions (T65).
 *   Non-null while `open`.
 * - `botId` is the selected channel, `null` for none. It is committed when a
 *   navigation to the channel's path is acknowledged, never before, so a
 *   refused switch leaves the previous channel selected.
 * - `visitedBotIds` are the channels shown since the surface opened, whose
 *   rail, drafts, surface actions and landing are kept across switches and
 *   forgotten when the bot goes away or the surface closes. Session-only.
 *
 * Persisted in localStorage (except `visitedBotIds`), so a restart restores
 * the surface on its host and its last channel.
 */
interface TracySurfaceState {
  readonly open: boolean;
  readonly hostId: string | null;
  readonly botId: string | null;
  readonly visitedBotIds: ReadonlyArray<string>;
  /** Opens the surface bound to `hostId`; an open surface keeps its host. */
  readonly openSurface: (hostId: string) => void;
  /** Commits the selected channel. */
  readonly selectChannel: (botId: string | null) => void;
  /** Moves an open surface to `hostId`. */
  readonly rebind: (hostId: string) => void;
  readonly markVisited: (botId: string) => void;
  /** Forgets a visited bot's per-channel state; it is no longer visited. */
  readonly forgetBot: (botId: string) => void;
  /** Closes the surface, forgetting every visited bot's state. */
  readonly closeSurface: () => void;
}

interface PersistedTracySurface {
  readonly open: boolean;
  readonly hostId: string | null;
  readonly botId: string | null;
}

const TRACY_SURFACE_PERSIST_KEY = persistKey(STORE_KEYS.botTabs);

/**
 * The bot tab records a version-1 payload held, by bot id, with each one's
 * host: kept for the session that migrated them, so the tabs layout's own
 * migration can carry the bot tab that was active onto the surface
 * (`adoptLegacyActiveBotTab`). `null` when no version-1 payload was read.
 */
let legacyBotTabHosts: ReadonlyMap<string, string> | null = null;

export const useTracySurfaceStore = create<TracySurfaceState>()(
  persist(
    (set, get) => ({
      open: false,
      hostId: null,
      botId: null,
      visitedBotIds: [],
      openSurface: (hostId) => {
        if (get().open) return;
        set({ open: true, hostId });
      },
      selectChannel: (botId) => {
        if (get().botId === botId) return;
        set({ botId });
      },
      rebind: (hostId) => {
        const state = get();
        if (!state.open || state.hostId === hostId) return;
        set({ hostId });
      },
      markVisited: (botId) => {
        const visited = get().visitedBotIds;
        if (visited.includes(botId)) return;
        set({ visitedBotIds: [...visited, botId] });
      },
      forgetBot: (botId) => {
        forgetBotState(botId);
        const visited = get().visitedBotIds;
        if (!visited.includes(botId)) return;
        set({ visitedBotIds: visited.filter((id) => id !== botId) });
      },
      closeSurface: () => {
        const state = get();
        for (const botId of state.visitedBotIds) forgetBotState(botId);
        if (!state.open && state.visitedBotIds.length === 0) return;
        set({ open: false, hostId: null, visitedBotIds: [] });
      },
    }),
    {
      ...basePersistOptions(TRACY_SURFACE_PERSIST_KEY),
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedTracySurface => ({
        open: state.open,
        hostId: state.hostId,
        botId: state.botId,
      }),
      migrate: (persisted, version) =>
        version < 2
          ? migrateBotTabsToTracySurface(persisted)
          : parseTracySurface(persisted),
    },
  ),
);

/**
 * A bot's rail, unsent drafts, surface actions and unspent landing: the state
 * kept per channel while the surface shows it.
 */
function forgetBotState(botId: string): void {
  useBotOpenThreadStore.getState().setRail(botId, null);
  useBotDraftsStore.getState().forgetBot(botId);
  useBotSurfaceActionsStore.getState().forgetBot(botId);
  useBotTabLandingStore.getState().clear(botId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTracySurface(value: unknown): PersistedTracySurface {
  if (!isRecord(value)) return { open: false, hostId: null, botId: null };
  const hostId =
    typeof value.hostId === "string" && value.hostId.length > 0
      ? value.hostId
      : null;
  const botId =
    typeof value.botId === "string" && value.botId.length > 0
      ? value.botId
      : null;
  // An open surface has a host; one restored without is not open.
  const open = value.open === true && hostId !== null;
  return { open, hostId: open ? hostId : null, botId };
}

interface LegacyBotTabRecord {
  readonly botId: string;
  readonly hostId: string;
  readonly openedAt: number;
}

function parseLegacyBotTabRecords(
  value: unknown,
): ReadonlyArray<LegacyBotTabRecord> {
  if (!isRecord(value)) return [];
  return Object.values(value)
    .flatMap((record): ReadonlyArray<LegacyBotTabRecord> => {
      if (!isRecord(record)) return [];
      const { botId, hostId, openedAt } = record;
      if (typeof botId !== "string" || botId.length === 0) return [];
      if (typeof hostId !== "string" || hostId.length === 0) return [];
      return [
        {
          botId,
          hostId,
          openedAt: typeof openedAt === "number" ? openedAt : 0,
        },
      ];
    })
    .sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Version 1 held one record per open bot tab and the fixed entry's bot. They
 * become one surface: open if any tab was, on the fixed entry's bot and host,
 * else the oldest tab's. The tab that was active, which only the tabs layout
 * knows, is preferred over both when that layout is migrated
 * (`adoptLegacyActiveBotTab`).
 */
function migrateBotTabsToTracySurface(
  persisted: unknown,
): PersistedTracySurface {
  const value = isRecord(persisted) ? persisted : {};
  const records = parseLegacyBotTabRecords(value.tabs);
  legacyBotTabHosts = new Map(
    records.map((record) => [record.botId, record.hostId]),
  );
  const fixedBotId =
    typeof value.fixedBotId === "string" ? value.fixedBotId : null;
  const preferred =
    records.find((record) => record.botId === fixedBotId) ??
    records.at(0) ??
    null;
  if (preferred === null) return { open: false, hostId: null, botId: null };
  return { open: true, hostId: preferred.hostId, botId: preferred.botId };
}

/**
 * Carries the bot tab a pre-surface tabs layout had active onto the surface:
 * its channel and the host its tab was bound to. Called by the tabs layout's
 * migration, synchronously, before the layout is restored; a bot with no
 * version-1 record this session changes nothing.
 */
export function adoptLegacyActiveBotTab(botId: string): void {
  const hostId = legacyBotTabHosts?.get(botId);
  if (hostId === undefined) return;
  useTracySurfaceStore.setState({ open: true, hostId, botId });
}

/** The surface's host while it is open: the host every channel reads through. */
export function tracySurfaceHostId(): string | null {
  const state = useTracySurfaceStore.getState();
  return state.open ? state.hostId : null;
}

/**
 * Before the surface is opened from a list or the fixed entry: an open
 * surface keeps its host unless this client can no longer dial it (a restored
 * surface, a host gone since), and then it moves to `hostId`, this window's
 * host. `isConnectable` is `null` while the directory has not answered, which
 * says nothing about the surface's host, so it keeps it.
 */
export function rebindUnreachableTracySurface(
  hostId: string,
  isConnectable: ((hostId: string) => boolean) | null,
): void {
  const current = tracySurfaceHostId();
  if (current === null || isConnectable === null) return;
  if (!isConnectable(current)) useTracySurfaceStore.getState().rebind(hostId);
}
