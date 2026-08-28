import { create, type StoreApi } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { ConversationTilePlacement } from "@/lib/canvas/conversation-tile-placement";

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
   * Resolved worktree intent captured at landing-composer Send time. The
   * host orchestrator turns this into a local `WorktreeBinding` row when
   * `epic.createChat` lands. `null` when no worktree intent was captured -
   * the chat then opens in the unbound state and must be re-bound from the
   * chat tile chip.
   */
  readonly worktreeIntent: WorktreeIntent | null;
  /**
   * Where the eager-opened chat tile lands. The creation trigger picks this:
   * sidebar `+` / landing → `active-tile` (new tab); in-pane PaneOpener →
   * `target-group`; ⌘K split commands → `split`.
   */
  readonly placement: ConversationTilePlacement;
  readonly clientActionId: string | null;
  readonly messageId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RegisterInitialChatHandoffInput extends InitialChatHandoffScope {
  /**
   * Client-generated chat id. Lets the renderer pre-populate the canvas tab
   * and dispatch chat-stream subscribes optimistically before the host's
   * `epic.createChat` round-trip completes.
   */
  readonly chatId: string;
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly placement: ConversationTilePlacement;
  // Pre-minted at submit so the same ids ride on `epic.createChat`'s
  // `initialMessage` (turn-overlap) and on any fallback `send`, letting the
  // host's idempotency gate dedupe.
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
   * Turn-overlap: the host already started the provider turn from the folded
   * chat's `initialMessage`, so jump straight to `sending` using the pre-minted
   * ids (no driver `send`). The existing `sending` policy then consumes the
   * handoff once the user message lands in the chat snapshot.
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

// Everything the v1 -> v2 migration below touches is declared BEFORE the
// `create()` call, not after it beside the other selectors. `persist` runs
// `hydrate()` during store creation and `toThenable` keeps that synchronous
// for a sync storage, so `migrate` executes at MODULE EVALUATION - a `const`
// declared further down the file would still be in its temporal dead zone.
//
// The failure that causes is quiet, which is what makes it worth pinning:
// zustand catches whatever `migrate` throws, so there is no crash and no
// import error. Hydration just yields nothing, and the handoff is dropped on
// exactly the installs holding a v1 blob - the only ones this migration
// exists for. Measured, not assumed: moving this declaration below `create()`
// turns the rehydration test into `expected null not to be null`, never a
// ReferenceError.
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
 * A persisted handoff, identified by the fields this store's own logic
 * BRANCHES on - the scope triple, `chatId`, and the status union.
 *
 * The payload fields (`content`, `settings`, `worktreeIntent`, `placement`)
 * are deliberately not re-validated: v1 wrote them from this same interface at
 * these same types, and the only thing v2 changed is the map key. Checking the
 * discriminators is what keeps a truncated or hand-edited blob from
 * rehydrating into a record whose `status` no transition matches, which would
 * strand it as unconsumable.
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
 * v1 -> v2: `initialChatHandoffKey` dropped its `hostId` segment, so every
 * persisted key names a bucket the new lookup can no longer address.
 *
 * RE-KEYED rather than dropped - contrast `worktree-intent-staging-store`,
 * whose v1 keys carried no host at all and so could not be attributed. Here
 * each record carries its own `userId`/`epicId`, so the v2 key is recoverable
 * exactly, and it is worth recovering: a handoff is a message the user already
 * SENT and whose chat the host already created, so dropping one strands a
 * seeded chat with nothing left to open it or clear its pending mark.
 *
 * Two v1 records for the same (user, epic) on different hosts would collapse
 * to one, last-writer-wins. That pair cannot arise from this store's own
 * writes - one epic is created on one host - and if it somehow did, the epic
 * only has one canvas to hand off to.
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
    handoffs[key] = { ...value, key };
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
          // Allow from any pre-send, non-terminal status: `epic.create` resolves
          // (and calls this) while the handoff may still be `pending`, or the
          // projection-driven adoption may have already advanced it.
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
      // v2 dropped the `hostId` segment from every persisted map key; see
      // `initialChatHandoffKey` for why, and `migrateInitialChatHandoffState`
      // for what happens to a v1 blob.
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => migrateInitialChatHandoffState(persisted),
    },
  ),
);

/**
 * The handoff's IDENTITY: the user and the epic it seeds - deliberately NOT
 * the host.
 *
 * `hostId` stays on the record as data (which host created this), but keying
 * on it made the handoff unfindable the moment the two sides disagreed, and
 * per-surface pins made them disagree routinely: `useLandingComposerActions`
 * registers under the composer's PLACEMENT host (the pin - selection model
 * §54, "the composer is placement"), while the canvas that consumes it reads
 * the app-wide pointer. Pin the landing composer to host B while host A is
 * effective and the seeded chat was never eager-opened, its pending mark never
 * cleared, and its projection lifecycle never advanced.
 *
 * Sound because `epicId` is a host-minted UUID: one epic is one epic, and no
 * two hosts can mint the same id, so the user pair is already unique. The
 * epic's own id is what says which host it belongs to - repeating that in the
 * key only created a way for the two to disagree.
 */
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

/**
 * True while a freshly-created epic still has a live (non-terminal) initial-chat
 * handoff. The canvas uses this to render the eager-opened chat optimistically
 * during the epic-snapshot load instead of the skeleton, so the user's first
 * message appears immediately. Scoped by `epicId` only (host/user agnostic)
 * since the canvas renders per-epic.
 */
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
