import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { CreateChatForkSourceV11 } from "@traycer/protocol/host/epic/unary-schemas";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { stripBase64ImageNodes } from "@/lib/composer/strip-base64-image-nodes";
import { PENDING_SEND_SURFACE_PREFIX } from "@/stores/composer/staged-sandbox-store";

/** What a pending send makes on its sandbox once the requested agent is ready. */
export type PendingSandboxSendRequest =
  /** A new agent with the message as its first turn. */
  | { readonly kind: "chat"; readonly parentId: string | null }
  /**
   * A terminal on the sandbox, in place of an agent (`Open terminal
   * instead`): no message, and no agent sign-in.
   */
  | { readonly kind: "terminal" }
  /**
   * A fork of a chat onto the sandbox (the fork dialog's New sandbox row): no
   * message, the source's history through `forkSource`. `tabId` is the tab
   * the fork dialog was open in, where the fork opens.
   */
  | {
      readonly kind: "fork";
      readonly parentId: string | null;
      readonly title: string;
      readonly forkSource: CreateChatForkSourceV11;
      readonly tabId: string;
    };

/** The ready line's facts, kept once the message was handed to the agent. */
export interface PendingSandboxSendDelivery {
  readonly chatId: string;
  readonly hostId: string;
  readonly sandboxId: string;
  /** From Send to the agent being ready, in whole seconds. */
  readonly readySeconds: number;
}

/**
 * A message sent to a staged sandbox (sandboxes redesign, Flow 1 step 2): the
 * task opened at once and the message waits in it, behind the setup line,
 * until the agent the person asked for is ready on the sandbox. The create's
 * state is the stage under {@link pendingSendSurfaceKey}; this is the message
 * and what it asked for, captured at Send and never re-resolved: the model
 * the person picked is the one it runs on.
 *
 * Persisted with the stage, so a reload observes the same create and delivers
 * the message once. It holds the message and its run settings as a draft
 * does, never a credential.
 */
export interface PendingSandboxSend {
  readonly id: string;
  readonly userId: string | null;
  readonly epicId: string;
  readonly request: PendingSandboxSendRequest;
  readonly content: JsonContent;
  /** The message as plain text, for the pending bubble and the fallback name. */
  readonly text: string;
  readonly settings: ChatRunSettings;
  readonly createdAt: number;
  /**
   * The task exists: the create or wake may start. `false` from a landing
   * Send until its task's create answers; a record still `false` after a
   * reload lost that create, and is dropped before anything is created.
   */
  readonly epicConfirmed: boolean;
  /** `null` until the message was handed to the agent on the sandbox. */
  readonly delivery: PendingSandboxSendDelivery | null;
}

/** Delivered sends kept for their ready line; the oldest are dropped first. */
const DELIVERED_KEPT = 50;

interface PendingSandboxSendStoreState {
  readonly sends: Readonly<Record<string, PendingSandboxSend>>;
  readonly add: (send: PendingSandboxSend) => void;
  readonly confirmEpic: (id: string) => void;
  readonly markDelivered: (
    id: string,
    delivery: PendingSandboxSendDelivery,
  ) => void;
  /** Ends a send: it was withdrawn, or handed to another host. */
  readonly remove: (id: string) => void;
  /** Drops every send: the account changed. */
  readonly clearAll: () => void;
}

function withoutOldDeliveries(
  sends: Readonly<Record<string, PendingSandboxSend>>,
): Readonly<Record<string, PendingSandboxSend>> {
  const delivered = Object.values(sends)
    .filter((send) => send.delivery !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (delivered.length <= DELIVERED_KEPT) return sends;
  const next = { ...sends };
  for (const send of delivered.slice(DELIVERED_KEPT)) delete next[send.id];
  return next;
}

export const usePendingSandboxSendStore =
  create<PendingSandboxSendStoreState>()(
    persist(
      (set) => ({
        sends: {},
        add: (send) =>
          set((state) => ({ sends: { ...state.sends, [send.id]: send } })),
        confirmEpic: (id) =>
          set((state) => {
            if (!Object.hasOwn(state.sends, id)) return state;
            const send = state.sends[id];
            if (send.epicConfirmed) return state;
            return {
              sends: { ...state.sends, [id]: { ...send, epicConfirmed: true } },
            };
          }),
        markDelivered: (id, delivery) =>
          set((state) => {
            if (!Object.hasOwn(state.sends, id)) return state;
            const send = state.sends[id];
            return {
              sends: withoutOldDeliveries({
                ...state.sends,
                [id]: { ...send, delivery },
              }),
            };
          }),
        remove: (id) =>
          set((state) => {
            if (!Object.hasOwn(state.sends, id)) return state;
            const next = { ...state.sends };
            delete next[id];
            return { sends: next };
          }),
        clearAll: () => set({ sends: {} }),
      }),
      {
        ...basePersistOptions(persistKey(STORE_KEYS.pendingSandboxSend)),
        storage: createJSONStorage(() => localStorage),
        // Pasted images are kept by hash, as a sent draft's are.
        partialize: (state) => ({
          sends: Object.fromEntries(
            Object.entries(state.sends).map(([id, send]) => [
              id,
              { ...send, content: stripBase64ImageNodes(send.content) },
            ]),
          ),
        }),
      },
    ),
  );

/** The stage key a pending send's create runs under. */
export function pendingSendSurfaceKey(id: string): string {
  return `${PENDING_SEND_SURFACE_PREFIX}${id}`;
}
