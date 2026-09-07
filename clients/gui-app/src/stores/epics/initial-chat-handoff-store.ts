import { create, type StoreApi } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import type { EdgeDropPosition } from "@/stores/epics/canvas/tile-tree";

export type InitialChatHandoffStatus =
  | "pending"
  | "waitingProjection"
  | "waitingChat"
  | "sending"
  | "failed";

export interface InitialChatHandoffScope {
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly epicId: string;
}

export interface InitialChatHandoff {
  readonly key: string;
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly epicId: string;
  readonly chatId: string | null;
  readonly status: InitialChatHandoffStatus;
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
  /**
   * Resolved worktree intent captured at landing-composer Send time. The host orchestrator turns
   * this into a local `WorktreeBinding` row when `epic.createChat` lands.
   */
  readonly worktreeIntent: WorktreeIntent | null;
  /**
   * Explicit placement for the eager-opened chat tile, or `null` to let the conversation
   * tile-placement setting decide (C3, C8).
   */
  readonly placement: ExplicitTilePlacement | null;
  readonly clientActionId: string | null;
  readonly messageId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RegisterInitialChatHandoffInput extends InitialChatHandoffScope {
  /**
   * Client-generated chat id. Lets the renderer pre-populate the canvas tab and dispatch chat-stream
   * subscribes optimistically before the host's `epic.createChat` round-trip completes.
   */
  readonly chatId: string;
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly placement: ExplicitTilePlacement | null;
  // Pre-minted at submit so the same ids ride on `epic.createChat`'s `initialMessage` (turn-overlap)
  // and on any fallback `send`, letting the host's idempotency gate dedupe.
  readonly messageId: string;
  readonly clientActionId: string;
  readonly createdAt: number;
}

interface InitialChatHandoffStore {
  readonly handoffs: Readonly<Record<string, InitialChatHandoff>>;
  register: (input: RegisterInitialChatHandoffInput) => void;
  markChatCreated: (scope: InitialChatHandoffScope, chatId: string) => boolean;
  markWaitingChat: (scope: InitialChatHandoffScope) => boolean;
  markSending: (
    scope: InitialChatHandoffScope,
    chatId: string,
    clientActionId: string,
    messageId: string,
  ) => boolean;
  /**
   * Turn-overlap: the host already started the provider turn from the folded chat's
   * `initialMessage`, so jump straight to `sending` using the pre-minted ids (no driver `send`).
   */
  markInitialTurnStarted: (
    scope: InitialChatHandoffScope,
    chatId: string,
  ) => boolean;
  markFailed: (scope: InitialChatHandoffScope, reason: string) => boolean;
  markFailedByAction: (
    scope: InitialChatHandoffScope,
    chatId: string,
    clientActionId: string,
    reason: string,
  ) => boolean;
  consume: (scope: InitialChatHandoffScope) => void;
  resetForTests: () => void;
}

const KEY_SEPARATOR = "\x1f";

interface InitialChatHandoffPersistedState {
  readonly handoffs: Readonly<Record<string, InitialChatHandoff>>;
}

// Everything the v1 -> v2 migration below touches is declared BEFORE the `create()` call, not
// after it beside the other selectors.
const HANDOFF_STATUSES: ReadonlySet<string> = new Set<InitialChatHandoffStatus>(
  ["pending", "waitingProjection", "waitingChat", "sending", "failed"],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * A persisted handoff, identified by the fields this store's own logic BRANCHES on - the scope
 * triple, `chatId`, and the status union.
 */
function isPersistedHandoff(value: unknown): value is InitialChatHandoff {
  if (!isRecord(value)) return false;
  if (typeof value.epicId !== "string") return false;
  if (!isStringOrNull(value.userId)) return false;
  if (!isStringOrNull(value.hostId)) return false;
  if (!isStringOrNull(value.chatId)) return false;
  return typeof value.status === "string" && HANDOFF_STATUSES.has(value.status);
}

/**
 * v2 -> v3: the tile-opening refactor replaced the persisted `ConversationTilePlacement` (`{ kind:
 * "active-tile" | "target-group" | "split" }`, no pane id) with {@link ExplicitTilePlacement}.
 */
function readPersistedPlacement(value: unknown): ExplicitTilePlacement | null {
  if (!isRecord(value)) return null;
  if (typeof value.paneId !== "string") return null;
  if (value.kind === "tab") {
    return {
      kind: "tab",
      paneId: value.paneId,
      index: typeof value.index === "number" ? value.index : null,
    };
  }
  if (value.kind === "split" && isEdgeDropPosition(value.edge)) {
    return { kind: "split", paneId: value.paneId, edge: value.edge };
  }
  return null;
}

// A total record rather than a literal list: adding an `EdgeDropPosition` fails the build here
// instead of silently reading a persisted placement carrying it back as `null`.
const PERSISTED_EDGES: Record<EdgeDropPosition, true> = {
  left: true,
  right: true,
  top: true,
  bottom: true,
};

function isEdgeDropPosition(value: unknown): value is EdgeDropPosition {
  return typeof value === "string" && Object.hasOwn(PERSISTED_EDGES, value);
}

/**
 * v1 -> v2: `initialChatHandoffKey` dropped its `hostId` segment, so every persisted key names a
 * bucket the new lookup can no longer address.
 */
export function migrateInitialChatHandoffState(
  persisted: unknown,
): InitialChatHandoffPersistedState {
  if (!isRecord(persisted) || !isRecord(persisted.handoffs)) {
    return { handoffs: {} };
  }
  const handoffs: Record<string, InitialChatHandoff> = {};
  for (const value of Object.values(persisted.handoffs)) {
    if (!isPersistedHandoff(value)) continue;
    const key = initialChatHandoffKey(value);
    handoffs[key] = {
      ...value,
      key,
      placement: readPersistedPlacement(value.placement),
    };
  }
  return { handoffs };
}

export const useInitialChatHandoffStore = create<InitialChatHandoffStore>()(
  persist(
    (set) => ({
      handoffs: {},
      register: (input) => {
        const key = initialChatHandoffKey(input);
        set((state) => ({
          handoffs: {
            ...state.handoffs,
            [key]: {
              key,
              hostId: input.hostId,
              userId: input.userId,
              epicId: input.epicId,
              chatId: input.chatId,
              status: "pending",
              content: input.content,
              settings: input.settings,
              worktreeIntent: input.worktreeIntent,
              placement: input.placement,
              clientActionId: input.clientActionId,
              messageId: input.messageId,
              failureReason: null,
              createdAt: input.createdAt,
              updatedAt: input.createdAt,
            },
          },
        }));
      },
      markChatCreated: (scope, chatId) =>
        updateHandoff(set, scope, (handoff) => {
          if (handoff.status === "failed") return null;
          if (handoff.chatId !== null && handoff.chatId !== chatId) return null;
          return {
            ...handoff,
            chatId,
            status: "waitingProjection",
            failureReason: null,
            updatedAt: Date.now(),
          };
        }),
      markWaitingChat: (scope) =>
        updateHandoff(set, scope, (handoff) => {
          if (handoff.status !== "waitingProjection") return null;
          return {
            ...handoff,
            status: "waitingChat",
            updatedAt: Date.now(),
          };
        }),
      markSending: (scope, chatId, clientActionId, messageId) =>
        updateHandoff(set, scope, (handoff) => {
          if (handoff.status !== "waitingChat") return null;
          if (handoff.chatId !== chatId) return null;
          return {
            ...handoff,
            status: "sending",
            clientActionId,
            messageId,
            failureReason: null,
            updatedAt: Date.now(),
          };
        }),
      markInitialTurnStarted: (scope, chatId) =>
        updateHandoff(set, scope, (handoff) => {
          // Allow from any pre-send, non-terminal status: `epic.create` resolves (and calls this) while the
          // handoff may still be `pending`, or the projection-driven adoption may have already advanced it.
          if (handoff.status === "sending" || handoff.status === "failed") {
            return null;
          }
          if (handoff.chatId !== chatId) return null;
          if (handoff.clientActionId === null || handoff.messageId === null) {
            return null;
          }
          return {
            ...handoff,
            status: "sending",
            failureReason: null,
            updatedAt: Date.now(),
          };
        }),
      markFailed: (scope, reason) =>
        updateHandoff(set, scope, (handoff) => ({
          ...handoff,
          status: "failed",
          failureReason: reason,
          updatedAt: Date.now(),
        })),
      markFailedByAction: (scope, chatId, clientActionId, reason) =>
        updateHandoff(set, scope, (handoff) => {
          if (handoff.chatId !== chatId) return null;
          if (handoff.clientActionId !== clientActionId) return null;
          return {
            ...handoff,
            status: "failed",
            failureReason: reason,
            updatedAt: Date.now(),
          };
        }),
      consume: (scope) => {
        set((state) => {
          const key = initialChatHandoffKey(scope);
          if (!Object.hasOwn(state.handoffs, key)) return state;
          const next = { ...state.handoffs };
          delete next[key];
          return { handoffs: next };
        });
      },
      resetForTests: () => {
        set({ handoffs: {} });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.initialChatHandoff)),
      // v2 dropped the `hostId` segment from every persisted map key (see `initialChatHandoffKey` for
      // why); v3 re-reads `placement`, whose shape the tile-opening refactor changed.
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => migrateInitialChatHandoffState(persisted),
    },
  ),
);

/** The handoff's IDENTITY: the user and the epic it seeds - deliberately NOT the host. */
export function initialChatHandoffKey(scope: InitialChatHandoffScope): string {
  return [scope.userId ?? "user:none", scope.epicId].join(KEY_SEPARATOR);
}

export function selectInitialChatHandoff(
  state: Pick<InitialChatHandoffStore, "handoffs">,
  scope: InitialChatHandoffScope,
): InitialChatHandoff | null {
  const key = initialChatHandoffKey(scope);
  return Object.hasOwn(state.handoffs, key) ? state.handoffs[key] : null;
}

/** True while a freshly-created epic still has a live (non-terminal) initial-chat handoff. */
export function selectHasActiveInitialChatHandoffForEpic(
  state: Pick<InitialChatHandoffStore, "handoffs">,
  epicId: string,
): boolean {
  return Object.values(state.handoffs).some(
    (handoff) => handoff.epicId === epicId && handoff.status !== "failed",
  );
}

function updateHandoff(
  set: StoreApi<InitialChatHandoffStore>["setState"],
  scope: InitialChatHandoffScope,
  updater: (handoff: InitialChatHandoff) => InitialChatHandoff | null,
): boolean {
  let updated = false;
  set((state) => {
    const key = initialChatHandoffKey(scope);
    const handoff = Object.hasOwn(state.handoffs, key)
      ? state.handoffs[key]
      : null;
    if (handoff === null) return state;
    const next = updater(handoff);
    if (next === null) return state;
    updated = true;
    return {
      handoffs: {
        ...state.handoffs,
        [key]: next,
      },
    };
  });
  return updated;
}
