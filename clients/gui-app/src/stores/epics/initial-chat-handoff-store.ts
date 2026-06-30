import { create, type StoreApi } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { ConversationTilePlacement } from "@/lib/canvas/conversation-tile-placement";

export type InitialChatHandoffStatus =
  "pending" | "waitingProjection" | "waitingChat" | "sending" | "failed";

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
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function initialChatHandoffKey(scope: InitialChatHandoffScope): string {
  return [
    scope.hostId ?? "host:none",
    scope.userId ?? "user:none",
    scope.epicId,
  ].join(KEY_SEPARATOR);
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
