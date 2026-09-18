import { create, type StoreApi } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import type { EdgeDropPosition } from "@/stores/epics/canvas/tile-tree";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { stripBase64ImageNodes } from "@/lib/composer/strip-base64-image-nodes";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";

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
   * Explicit placement for the eager-opened chat tile, or `null` to let the
   * conversation tile-placement setting decide (C3, C8). Only the in-pane
   * PaneOpener names a pane; the sidebar `+`, the landing composer and the
   * palette pass `null`.
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
   * Client-generated chat id. Lets the renderer pre-populate the canvas tab
   * and dispatch chat-stream subscribes optimistically before the host's
   * `epic.createChat` round-trip completes.
   */
  readonly chatId: string;
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly placement: ExplicitTilePlacement | null;
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
 * `content`, `settings` and `worktreeIntent` are deliberately not
 * re-validated: every version wrote them from this same interface at these
 * same types. `placement` is the exception and is re-read by
 * {@link readPersistedPlacement}. Checking the discriminators is what keeps a
 * truncated or hand-edited blob from rehydrating into a record whose `status`
 * no transition matches, which would strand it as unconsumable.
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
 * v2 -> v3: the tile-opening refactor replaced the persisted
 * `ConversationTilePlacement` (`{ kind: "active-tile" | "target-group" |
 * "split" }`, no pane id) with {@link ExplicitTilePlacement}. A blob written
 * by the previous release would otherwise rehydrate into a field the resolver
 * reads as an explicit placement and cannot honour, so an unrecognized shape
 * falls back to `null` - the conversation placement setting then decides,
 * which is what every caller but the PaneOpener passes anyway.
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
  if (value.kind === "beside" && value.category === "side-chat") {
    return { kind: "beside", paneId: value.paneId, category: "side-chat" };
  }
  return null;
}

// A total record rather than a literal list: adding an `EdgeDropPosition`
// fails the build here instead of silently reading a persisted placement
// carrying it back as `null`.
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
      // v2 dropped the `hostId` segment from every persisted map key (see
      // `initialChatHandoffKey` for why); v3 re-reads `placement`, whose shape
      // the tile-opening refactor changed; v4 is the base64 strip below.
      // `migrateInitialChatHandoffState` handles all three, and is idempotent
      // for a blob already at any of them.
      version: 4,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => migrateInitialChatHandoffState(persisted),
      // Serialization boundary: a persisted handoff NEVER carries base64. A
      // handoff registered by this build is hash-only already — the composers
      // register the hash-only document and the resend resolves bytes through
      // `prepareDraftImageInlining` — so this strip normally changes nothing.
      //
      // What it is FOR is the v3 blob: every handoff written before this change
      // carried the fully-inlined message, which is what put a multi-megabyte
      // image in `localStorage` under this key. Such an entry keeps its base64
      // IN MEMORY across the migration and still re-sends (the resend passes a
      // b64 node through untouched); only its next persisted copy loses the
      // image, and by then the entry has almost always been consumed. That
      // one-relaunch window is the accepted cost of not running an async byte
      // conversion inside a synchronous localStorage hydration.
      partialize: (state) => ({
        handoffs: Object.fromEntries(
          Object.entries(state.handoffs).map(([key, handoff]) => [
            key,
            { ...handoff, content: stripBase64ImageNodes(handoff.content) },
          ]),
        ),
      }),
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

/**
 * A registered handoff's prompt is a GC root for its images.
 *
 * The new-chat create hands its document to this store and clears the composer
 * draft SYNCHRONOUSLY, well before `epic.createChat` answers. Between those two
 * moments the prompt exists only here, so a `landing-image-gc` reconcile in
 * that window would reap the bytes of an image the initial message is still
 * carrying - and the retry/fallback `send` the driver may run afterwards reads
 * the same document. The root stands until the handoff is consumed or fails,
 * which is strictly longer than "until `epic.createChat` returns" and is the
 * span that actually matters.
 *
 * Registered here rather than in the draft mirror's root source so the walk
 * lives beside the state it walks, mirroring `composer-draft-store.ts`.
 *
 * A `failed` handoff is NOT a root, and the exclusion is load-bearing rather
 * than tidy. `markFailed` keeps the record - nothing deletes it, and this store
 * is PERSISTED - while `useInitialChatHandoff` never consumes a terminal one.
 * So walking every record unconditionally pinned an image-bearing failed
 * handoff's bytes for the life of the install, across reloads, and repeated
 * failures would accumulate until the shared landing-image budget refused the
 * next attachment. "Until the handoff is consumed or fails" is what the
 * paragraph above promises; this is the half that makes "or fails" true.
 */
registerExtraImageRootSource({
  hashes: () => {
    const hashes: string[] = [];
    for (const handoff of Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )) {
      if (handoff.status === "failed") continue;
      hashes.push(...blobHashesFromContent(handoff.content));
    }
    return hashes;
  },
});
