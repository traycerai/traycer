import { create } from "zustand";
import { isEpicCanvasTileInstanceLive } from "@/stores/epics/canvas/tile-instance-liveness";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import type {
  TileFindActiveOwner,
  TileFindAdapter,
  TileFindInput,
  TileFindOwnerBlocker,
  TileFindStateSnapshot,
  TileFindTargetRecord,
  TileFindTargetRegistration,
  TileFindUiState,
  TileReplaceInput,
} from "@/stores/tile-find/types";

export interface TileFindState {
  readonly targetsByTileInstanceId: Readonly<
    Record<string, TileFindTargetRecord | undefined>
  >;
  readonly uiByTileInstanceId: Readonly<
    Record<string, TileFindUiState | undefined>
  >;
  readonly activeOwner: TileFindActiveOwner | null;
  readonly ownerBlocker: TileFindOwnerBlocker | null;
  readonly nextRegistrationId: number;
  readonly registerTarget: (
    registration: TileFindTargetRegistration,
  ) => () => void;
  readonly unregisterTarget: (
    tileInstanceId: string,
    registeredAt: number | null,
  ) => void;
  readonly setOwnerBlocker: (blocker: TileFindOwnerBlocker | null) => void;
  readonly openForTile: (tileInstanceId: string) => boolean;
  readonly openActiveOwner: () => boolean;
  readonly advanceActiveOwner: (direction: 1 | -1) => boolean;
  readonly close: (tileInstanceId: string) => void;
  readonly setQuery: (tileInstanceId: string, query: string) => void;
  readonly setMatchCase: (tileInstanceId: string, matchCase: boolean) => void;
  readonly setReplaceText: (
    tileInstanceId: string,
    replaceText: string,
  ) => void;
  readonly setReplaceExpanded: (
    tileInstanceId: string,
    replaceExpanded: boolean,
  ) => void;
  readonly search: (tileInstanceId: string) => void;
  readonly next: (tileInstanceId: string) => void;
  readonly previous: (tileInstanceId: string) => void;
  readonly registerPendingSearchFlush: (
    tileInstanceId: string,
    flush: (() => boolean) | null,
  ) => void;
  readonly replaceCurrent: (tileInstanceId: string) => void;
  readonly replaceAll: (tileInstanceId: string) => void;
  readonly applyAdapterSnapshot: (
    tileInstanceId: string,
    snapshot: TileFindStateSnapshot,
  ) => void;
  readonly resetForTests: () => void;
}

interface TileFindAdapterSubscription {
  readonly registeredAt: number;
  readonly unsubscribe: () => void;
}

const adapterSubscriptions = new Map<string, TileFindAdapterSubscription>();

// Per-tile callback that runs the bar's pending (debounced) chat search now, returning true when
// one was flushed.
const pendingSearchFlushes = new Map<string, () => boolean>();

// durable chat-key mirror of a tile's find session (query + bar state
// only), keyed by `(epicId, contentId)` - the same generic identity `resolveActiveOwner` already
interface DurableTileFindUiSnapshot {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly replaceExpanded: boolean;
  readonly currentRequestId: number;
}

const durableTileFindUiCache =
  createChatDurableCache<DurableTileFindUiSnapshot>(200);

/** Drops the durable chat-key entry - called when the CHAT (or, generically,
 *  the tile's content) is deleted, not on an ordinary tab close. */
export function evictTileFindUiForChat(identity: {
  readonly epicId: string;
  readonly chatId: string;
}): void {
  durableTileFindUiCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictTileFindUiForEpic(epicId: string): void {
  durableTileFindUiCache.deleteEpic(epicId);
}

/** promotes one tile's CURRENT ui state to durable */
export function promoteTileFindUiToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const ui =
    useTileFindStore.getState().uiByTileInstanceId[identity.tileInstanceId];
  if (ui === undefined) return;
  durableTileFindUiCache.set(identity, {
    isOpen: ui.isOpen,
    query: ui.query,
    matchCase: ui.matchCase,
    replaceText: ui.replaceText,
    replaceExpanded: ui.replaceExpanded,
    currentRequestId: ui.currentRequestId,
  });
}

const INITIAL_TILE_FIND_STATE = {
  targetsByTileInstanceId: {},
  uiByTileInstanceId: {},
  activeOwner: null,
  ownerBlocker: null,
  nextRegistrationId: 1,
};

export const useTileFindStore = create<TileFindState>((set, get) => ({
  ...INITIAL_TILE_FIND_STATE,

  registerTarget: (registration) => {
    const registeredAt = get().nextRegistrationId;
    const adapterSnapshot = registration.adapter.getSnapshot();
    const priorSubscription = adapterSubscriptions.get(
      registration.tileInstanceId,
    );
    if (priorSubscription !== undefined) priorSubscription.unsubscribe();

    const unsubscribe = registration.adapter.subscribe(() => {
      useTileFindStore
        .getState()
        .applyAdapterSnapshot(
          registration.tileInstanceId,
          registration.adapter.getSnapshot(),
        );
    });
    adapterSubscriptions.set(registration.tileInstanceId, {
      registeredAt,
      unsubscribe,
    });

    const isFreshUi =
      get().uiByTileInstanceId[registration.tileInstanceId] === undefined;
    const durable = isFreshUi
      ? durableTileFindUiCache.get({
          epicId: registration.epicId,
          chatId: registration.contentId,
        })
      : undefined;
    set((state) => {
      const target: TileFindTargetRecord = {
        ...registration,
        registeredAt,
      };
      const targetsByTileInstanceId = {
        ...state.targetsByTileInstanceId,
        [registration.tileInstanceId]: target,
      };
      const existingUi = state.uiByTileInstanceId[registration.tileInstanceId];
      const uiByTileInstanceId =
        existingUi === undefined
          ? {
              ...state.uiByTileInstanceId,
              [registration.tileInstanceId]: createInitialUiState(
                adapterSnapshot,
                durable,
              ),
            }
          : state.uiByTileInstanceId;
      return {
        targetsByTileInstanceId,
        uiByTileInstanceId,
        activeOwner: resolveActiveOwner(
          targetsByTileInstanceId,
          state.ownerBlocker,
        ),
        nextRegistrationId: registeredAt + 1,
      };
    });
    get().applyAdapterSnapshot(registration.tileInstanceId, adapterSnapshot);
    replayRegisteredAdapterSearch(
      registration.tileInstanceId,
      registration.adapter,
      adapterSnapshot,
    );

    return () => {
      get().unregisterTarget(registration.tileInstanceId, registeredAt);
    };
  },

  unregisterTarget: (tileInstanceId, registeredAt) => {
    const existing = get().targetsByTileInstanceId[tileInstanceId];
    if (existing === undefined) return;
    if (registeredAt !== null && existing.registeredAt !== registeredAt) return;
    const subscription = adapterSubscriptions.get(tileInstanceId);
    if (
      subscription !== undefined &&
      (registeredAt === null || subscription.registeredAt === registeredAt)
    ) {
      subscription.unsubscribe();
      adapterSubscriptions.delete(tileInstanceId);
    }
    set((state) => {
      const targetsByTileInstanceId = {
        ...state.targetsByTileInstanceId,
      };
      delete targetsByTileInstanceId[tileInstanceId];
      return {
        targetsByTileInstanceId,
        activeOwner: resolveActiveOwner(
          targetsByTileInstanceId,
          state.ownerBlocker,
        ),
      };
    });
    scheduleUiReclaim(tileInstanceId);
  },

  setOwnerBlocker: (blocker) => {
    set((state) => {
      if (sameOwnerBlocker(state.ownerBlocker, blocker)) return state;
      return {
        ownerBlocker: blocker,
        activeOwner: resolveActiveOwner(state.targetsByTileInstanceId, blocker),
      };
    });
  },

  openForTile: (tileInstanceId) => {
    const target = get().targetsByTileInstanceId[tileInstanceId];
    if (target === undefined) return false;
    set((state) => {
      const ui = getUiState(state, target);
      return {
        uiByTileInstanceId: {
          ...state.uiByTileInstanceId,
          [tileInstanceId]: {
            ...ui,
            isOpen: true,
            focusRequestNonce: ui.focusRequestNonce + 1,
          },
        },
      };
    });
    return true;
  },

  openActiveOwner: () => {
    const activeOwner = get().activeOwner;
    if (activeOwner === null) return false;
    return get().openForTile(activeOwner.tileInstanceId);
  },

  advanceActiveOwner: (direction) => {
    const activeOwner = get().activeOwner;
    if (activeOwner === null) return false;
    const target = get().targetsByTileInstanceId[activeOwner.tileInstanceId];
    if (target === undefined) return false;
    if (direction === 1) get().next(activeOwner.tileInstanceId);
    else get().previous(activeOwner.tileInstanceId);
    return true;
  },

  close: (tileInstanceId) => {
    const target = get().targetsByTileInstanceId[tileInstanceId];
    set((state) => {
      const existing = state.uiByTileInstanceId[tileInstanceId];
      if (existing === undefined) return state;
      return {
        uiByTileInstanceId: {
          ...state.uiByTileInstanceId,
          [tileInstanceId]: {
            ...existing,
            isOpen: false,
          },
        },
      };
    });
    if (target !== undefined)
      runAdapterCommand(
        tileInstanceId,
        () => {
          target.adapter.clear();
        },
        null,
      );
  },

  setQuery: (tileInstanceId, query) => {
    updateUi(get, set, tileInstanceId, (ui) => ({
      ...ui,
      query,
    }));
  },

  setMatchCase: (tileInstanceId, matchCase) => {
    updateUi(get, set, tileInstanceId, (ui) => ({
      ...ui,
      matchCase,
    }));
  },

  setReplaceText: (tileInstanceId, replaceText) => {
    updateUi(get, set, tileInstanceId, (ui) => ({
      ...ui,
      replaceText,
    }));
  },

  setReplaceExpanded: (tileInstanceId, replaceExpanded) => {
    updateUi(get, set, tileInstanceId, (ui) => ({
      ...ui,
      replaceExpanded,
    }));
  },

  search: (tileInstanceId) => {
    const command = prepareRequest(get, set, tileInstanceId);
    if (command === null) return;
    const input: TileFindInput = {
      requestId: command.requestId,
      query: command.ui.query,
      matchCase: command.ui.matchCase,
    };
    runAdapterCommand(
      tileInstanceId,
      () => command.target.adapter.search(input),
      command.requestId,
    );
  },

  next: (tileInstanceId) => {
    const target = get().targetsByTileInstanceId[tileInstanceId];
    if (target === undefined) return;
    // A pending debounced search means the adapter still holds the previous query's matches; flush it
    // first (which reveals the first match) and skip the advance, mirroring the bar's own "flush
    if (flushPendingSearch(tileInstanceId)) return;
    runAdapterCommand(tileInstanceId, () => target.adapter.next(), null);
  },

  previous: (tileInstanceId) => {
    const target = get().targetsByTileInstanceId[tileInstanceId];
    if (target === undefined) return;
    if (flushPendingSearch(tileInstanceId)) return;
    runAdapterCommand(tileInstanceId, () => target.adapter.previous(), null);
  },

  registerPendingSearchFlush: (tileInstanceId, flush) => {
    if (flush === null) {
      pendingSearchFlushes.delete(tileInstanceId);
      return;
    }
    pendingSearchFlushes.set(tileInstanceId, flush);
  },

  replaceCurrent: (tileInstanceId) => {
    // Refuse before prepareRequest so an adapter without a replace boundary
    // never has its request/replace state bumped for an unsupported command.
    const replace =
      get().targetsByTileInstanceId[tileInstanceId]?.adapter.replace;
    if (replace === undefined || replace === null) return;
    const command = prepareRequest(get, set, tileInstanceId);
    if (command === null) return;
    const input: TileReplaceInput = {
      requestId: command.requestId,
      query: command.ui.query,
      matchCase: command.ui.matchCase,
      replaceText: command.ui.replaceText,
    };
    runAdapterCommand(
      tileInstanceId,
      () => replace.replaceCurrent(input),
      command.requestId,
    );
  },

  replaceAll: (tileInstanceId) => {
    const replace =
      get().targetsByTileInstanceId[tileInstanceId]?.adapter.replace;
    if (replace === undefined || replace === null) return;
    const command = prepareRequest(get, set, tileInstanceId);
    if (command === null) return;
    const input: TileReplaceInput = {
      requestId: command.requestId,
      query: command.ui.query,
      matchCase: command.ui.matchCase,
      replaceText: command.ui.replaceText,
    };
    runAdapterCommand(
      tileInstanceId,
      () => replace.replaceAll(input),
      command.requestId,
    );
  },

  applyAdapterSnapshot: (tileInstanceId, snapshot) => {
    set((state) => {
      const target = state.targetsByTileInstanceId[tileInstanceId];
      if (target === undefined) return state;
      const currentUi = getUiState(state, target);
      if (snapshot.requestId < currentUi.currentRequestId) return state;
      return {
        uiByTileInstanceId: {
          ...state.uiByTileInstanceId,
          [tileInstanceId]: {
            ...currentUi,
            currentRequestId: snapshot.requestId,
            lastSnapshot: snapshot,
          },
        },
      };
    });
  },

  resetForTests: () => {
    adapterSubscriptions.forEach((subscription) => subscription.unsubscribe());
    adapterSubscriptions.clear();
    pendingSearchFlushes.clear();
    durableTileFindUiCache.clearForTests();
    set(INITIAL_TILE_FIND_STATE);
  },
}));

// Run a tile's registered pending-search flush, if any. Returns true when a
// debounced search was flushed (so the caller skips the advance).
function flushPendingSearch(tileInstanceId: string): boolean {
  const flush = pendingSearchFlushes.get(tileInstanceId);
  return flush !== undefined && flush();
}

// Reclaim a tile's per-tile `ui` entry once its target is gone, so closed tiles don't leak
// `lastSnapshot` for the session lifetime.
function scheduleUiReclaim(tileInstanceId: string): void {
  queueMicrotask(() => {
    const state = useTileFindStore.getState();
    if (state.targetsByTileInstanceId[tileInstanceId] !== undefined) return;
    if (state.uiByTileInstanceId[tileInstanceId] === undefined) return;
    if (isEpicCanvasTileInstanceLive(tileInstanceId)) return;
    useTileFindStore.setState((current) => {
      if (current.targetsByTileInstanceId[tileInstanceId] !== undefined) {
        return current;
      }
      const uiByTileInstanceId = { ...current.uiByTileInstanceId };
      delete uiByTileInstanceId[tileInstanceId];
      return { uiByTileInstanceId };
    });
  });
}

/**
 * F4 (ticket 5 review): drops `ui` entries outright for tiles removed from the canvas for good -
 * called from the canvas store's tile-removal subscriber, the same sweep that evicts the other
 */
export function evictTileFindUi(tileInstanceIds: ReadonlyArray<string>): void {
  useTileFindStore.setState((state) => {
    const idsToRemove = tileInstanceIds.filter(
      (id) => state.uiByTileInstanceId[id] !== undefined,
    );
    if (idsToRemove.length === 0) return state;
    const uiByTileInstanceId = { ...state.uiByTileInstanceId };
    idsToRemove.forEach((id) => delete uiByTileInstanceId[id]);
    return { uiByTileInstanceId };
  });
}

function createInitialUiState(
  snapshot: TileFindStateSnapshot,
  durable: DurableTileFindUiSnapshot | undefined,
): TileFindUiState {
  if (durable !== undefined) {
    return {
      isOpen: durable.isOpen,
      query: durable.query,
      matchCase: durable.matchCase,
      replaceText: durable.replaceText,
      replaceExpanded: durable.replaceExpanded,
      currentRequestId: durable.currentRequestId,
      focusRequestNonce: 0,
      lastSnapshot: snapshot,
    };
  }
  return {
    isOpen: false,
    query: snapshot.query,
    matchCase: snapshot.matchCase,
    replaceText: snapshot.replaceText,
    replaceExpanded: false,
    currentRequestId: snapshot.requestId,
    focusRequestNonce: 0,
    lastSnapshot: snapshot,
  };
}

function getUiState(
  state: TileFindState,
  target: TileFindTargetRecord,
): TileFindUiState {
  return (
    state.uiByTileInstanceId[target.tileInstanceId] ??
    createInitialUiState(
      target.adapter.getSnapshot(),
      durableTileFindUiCache.get({
        epicId: target.epicId,
        chatId: target.contentId,
      }),
    )
  );
}

// restores query + bar state only, everywhere (tab switch AND reopen-after-close) - the replayed
// search always lands on the adapter's own default match, by design, not a chased occurrence.
function replayRegisteredAdapterSearch(
  tileInstanceId: string,
  adapter: TileFindAdapter,
  adapterSnapshot: TileFindStateSnapshot,
): void {
  const state = useTileFindStore.getState();
  const target = state.targetsByTileInstanceId[tileInstanceId];
  const ui = state.uiByTileInstanceId[tileInstanceId];
  if (target === undefined || target.adapter !== adapter) return;
  if (ui === undefined) return;
  // Replay exists to restore an OPEN search when a tile's adapter is swapped (e.g. a diff tile going
  // loading -> loaded).
  if (!ui.isOpen) return;
  if (ui.currentRequestId <= adapterSnapshot.requestId) return;

  runAdapterCommand(
    tileInstanceId,
    () =>
      adapter.search({
        requestId: ui.currentRequestId,
        query: ui.query,
        matchCase: ui.matchCase,
      }),
    ui.currentRequestId,
  );
}

function resolveActiveOwner(
  targetsByTileInstanceId: Readonly<
    Record<string, TileFindTargetRecord | undefined>
  >,
  ownerBlocker: TileFindOwnerBlocker | null,
): TileFindActiveOwner | null {
  if (ownerBlocker !== null) return null;
  const target = Object.values(
    targetsByTileInstanceId,
  ).reduce<TileFindTargetRecord | null>((current, candidate) => {
    if (candidate === undefined || !candidate.isEligible) return current;
    if (current === null) return candidate;
    return candidate.registeredAt > current.registeredAt ? candidate : current;
  }, null);
  if (target === null) return null;
  return {
    tileInstanceId: target.tileInstanceId,
    contentId: target.contentId,
    viewTabId: target.viewTabId,
    tileId: target.tileId,
    epicId: target.epicId,
    tileKind: target.tileKind,
  };
}

function sameOwnerBlocker(
  left: TileFindOwnerBlocker | null,
  right: TileFindOwnerBlocker | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.reason === right.reason && left.ownerId === right.ownerId;
}

function updateUi(
  get: () => TileFindState,
  set: (
    partial:
      | Partial<TileFindState>
      | ((state: TileFindState) => Partial<TileFindState> | TileFindState),
  ) => void,
  tileInstanceId: string,
  update: (ui: TileFindUiState) => TileFindUiState,
): void {
  const target = get().targetsByTileInstanceId[tileInstanceId];
  if (target === undefined) return;
  set((state) => ({
    uiByTileInstanceId: {
      ...state.uiByTileInstanceId,
      [tileInstanceId]: update(getUiState(state, target)),
    },
  }));
}

interface PreparedTileFindRequest {
  readonly target: TileFindTargetRecord;
  readonly ui: TileFindUiState;
  readonly requestId: number;
}

function prepareRequest(
  get: () => TileFindState,
  set: (
    partial:
      | Partial<TileFindState>
      | ((state: TileFindState) => Partial<TileFindState> | TileFindState),
  ) => void,
  tileInstanceId: string,
): PreparedTileFindRequest | null {
  const target = get().targetsByTileInstanceId[tileInstanceId];
  if (target === undefined) return null;
  const existingUi = getUiState(get(), target);
  const requestId = existingUi.currentRequestId + 1;
  set((state) => {
    const ui = getUiState(state, target);
    return {
      uiByTileInstanceId: {
        ...state.uiByTileInstanceId,
        [tileInstanceId]: {
          ...ui,
          currentRequestId: requestId,
          lastSnapshot: {
            ...ui.lastSnapshot,
            requestId,
            status: "searching",
            query: ui.query,
            matchCase: ui.matchCase,
            replaceText: ui.replaceText,
            errorMessage: null,
          },
        },
      },
    };
  });
  return { target, ui: getUiState(get(), target), requestId };
}

function runAdapterCommand(
  tileInstanceId: string,
  command: () => void | Promise<void>,
  requestId: number | null,
): void {
  try {
    const result = command();
    if (result !== undefined) {
      void result.catch((error: unknown) => {
        markAdapterCommandError(tileInstanceId, error, requestId);
      });
    }
  } catch (error) {
    markAdapterCommandError(tileInstanceId, error, requestId);
  }
}

function markAdapterCommandError(
  tileInstanceId: string,
  error: unknown,
  requestId: number | null,
): void {
  const state = useTileFindStore.getState();
  const target = state.targetsByTileInstanceId[tileInstanceId];
  const ui = state.uiByTileInstanceId[tileInstanceId];
  if (target === undefined || ui === undefined) return;
  if (requestId !== null && ui.currentRequestId !== requestId) return;
  const errorRequestId = requestId ?? ui.currentRequestId;
  state.applyAdapterSnapshot(tileInstanceId, {
    ...ui.lastSnapshot,
    requestId: errorRequestId,
    status: "error",
    capabilities: ui.lastSnapshot.capabilities,
    query: ui.query,
    matchCase: ui.matchCase,
    replaceText: ui.replaceText,
    current: 0,
    total: 0,
    coverageMessage: null,
    errorMessage: errorMessageFromUnknown(error),
    activeUnitId: null,
    exactHighlight: "none",
  });
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Find command failed.";
}

export function selectTileFindUi(
  tileInstanceId: string,
): (state: TileFindState) => TileFindUiState | null {
  return (state) => state.uiByTileInstanceId[tileInstanceId] ?? null;
}
