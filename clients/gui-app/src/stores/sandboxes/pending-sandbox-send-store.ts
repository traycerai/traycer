import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  CreateChatRequestV13,
  CreateChatForkSourceV11,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
import { stripBase64ImageNodes } from "@/lib/composer/strip-base64-image-nodes";
import {
  PENDING_SEND_SURFACE_PREFIX,
  readStagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { recordMapStorageKey } from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  ownsPendingSandboxSend,
  ownsPendingSandboxSendExclusively,
  pendingSandboxSendHandedHere,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  pendingSendState,
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
  type PendingSendFacts,
  type PendingSendEvent,
  type PendingSendTransition,
  type PendingSendBlocker,
} from "@/lib/sandboxes/pending-sandbox-send-transition";

/** What a pending send makes on its sandbox once the requested agent is ready. */
export type PendingSandboxSendRequest =
  /**
   * A new agent with the message as its first turn. `placement` is the pane
   * the surface named for its tile (the in-pane New agent), or `null` for the
   * conversation placement setting, as the ordinary create takes it.
   */
  | {
      readonly kind: "chat";
      readonly parentId: string | null;
      readonly placement: ExplicitTilePlacement | null;
    }
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

/** The exact request remains replayable even after the account's stage is cleared. */
export interface PendingSandboxSendDispatch {
  readonly input: CreateChatRequestV13 & { readonly settings: ChatRunSettings };
  readonly delivery: PendingSandboxSendDelivery;
  /** A transport failure cannot say whether the host accepted the request. */
  readonly status: "sending" | "uncertain";
  readonly blocker?: PendingSendBlocker;
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
   * Send until its task's create answers. An exclusive successor can return
   * an interrupted task's message; fallback windows leave it with its owner.
   */
  readonly epicConfirmed: boolean;
  /** `null` until acceptance is confirmed, including an uncertain host response. */
  readonly delivery: PendingSandboxSendDelivery | null;
  /** Absent on legacy records; once claimed, only the original request may retry. */
  readonly dispatch?: PendingSandboxSendDispatch | null;
  /** An authoritative sandbox or task loss permits recovery of its pending message. */
  readonly ended?: boolean;
}

/** Delivered sends kept for their ready line; the oldest are dropped first. */
const DELIVERED_KEPT = 50;

interface PendingSandboxSendStoreState {
  readonly sends: Readonly<Record<string, PendingSandboxSend>>;
  readonly add: (send: PendingSandboxSend) => void;
  readonly confirmEpic: (id: string) => void;
  readonly beginDispatch: (
    id: string,
    dispatch: PendingSandboxSendDispatch,
  ) => boolean;
  readonly markDispatchUncertain: (id: string) => void;
  readonly retryDispatch: (id: string, facts: PendingSendFacts) => void;
  readonly refuseDispatch: (id: string) => void;
  readonly endDispatch: (
    id: string,
    dispatch: PendingSandboxSendDispatch | null,
    event: "terminal-row" | "task-deleted",
  ) => boolean;
  readonly dispatchEvent: (
    id: string,
    event: PendingSendEvent,
    facts: PendingSendFacts,
  ) => PendingSendTransition | null;
  readonly completeTerminal: (id: string) => void;
  readonly markDelivered: (
    id: string,
    delivery: PendingSandboxSendDelivery,
  ) => boolean;
  /** Ends an undispatched send; a durable dispatch claim cannot be withdrawn. */
  readonly remove: (id: string) => void;
  /** Drops the delivered sends, whose ready lines are the account's: it changed. */
  readonly clearDelivered: () => void;
}

/** All adapters read the same durable identity and original-owner authority. */
export function pendingSandboxSendFacts(
  id: string,
  environment: PendingSendFacts,
): PendingSendFacts {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return UNKNOWN_PENDING_SEND_FACTS;
  const send = sends[id];
  const stored = storedSend(id);
  const dispatch = send.dispatch ?? null;
  return {
    ...environment,
    current:
      stored !== null &&
      (stored.ended === true) === (send.ended === true) &&
      (stored.delivery === null
        ? send.delivery === null &&
          (dispatch === null || pendingSandboxDispatchCurrent(id, dispatch))
        : send.delivery !== null &&
          JSON.stringify(stored.delivery) === JSON.stringify(send.delivery)),
    terminalDisposition: stored?.ended === true,
    accountActive:
      (useAuthStore.getState().profile?.userId ?? null) === send.userId,
    owns: ownsPendingSandboxSend(id),
    exclusive: ownsPendingSandboxSendExclusively(id),
    origin: pendingSandboxSendHandedHere(id),
    durableClaim:
      dispatch !== null
        ? pendingSandboxDispatchCurrent(id, dispatch)
        : pendingSandboxSendWithdrawalState(id) === "claimed",
  };
}

function pendingDecision(
  send: PendingSandboxSend,
  event: PendingSendEvent,
  environment: PendingSendFacts,
): PendingSendTransition {
  return transitionPendingSend(
    pendingSendState(send, "none"),
    event,
    pendingSandboxSendFacts(send.id, environment),
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the record itself: a delayed storage event must not permit withdrawal. */
function storedSend(id: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(
      recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), id),
    );
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // An unavailable durable store cannot authorize a create or withdrawal.
    return null;
  }
}

/** An accepted or withdrawn record can never be replaced by a late RPC outcome. */
export function pendingSandboxDispatchCurrent(
  id: string,
  dispatch: PendingSandboxSendDispatch,
): boolean {
  const stored = storedSend(id);
  if (
    stored === null ||
    stored.delivery !== null ||
    !isRecord(stored.dispatch)
  ) {
    return false;
  }
  return (
    JSON.stringify(stored.dispatch.input) === JSON.stringify(dispatch.input)
  );
}

/** The durable record, rather than this window's possibly stale snapshot, decides. */
export function pendingSandboxSendWithdrawalState(
  id: string,
): "gone" | "claimed" | "ended" | "confirmed" | "unconfirmed" {
  const stored = storedSend(id);
  if (stored === null || stored.delivery !== null) return "gone";
  if (stored.dispatch !== undefined && stored.dispatch !== null)
    return "claimed";
  if (stored.ended === true) return "ended";
  return stored.epicConfirmed === true ? "confirmed" : "unconfirmed";
}

function withDispatch(
  sends: Readonly<Record<string, PendingSandboxSend>>,
  id: string,
  update: (
    dispatch: PendingSandboxSendDispatch,
  ) => PendingSandboxSendDispatch | null,
): Readonly<Record<string, PendingSandboxSend>> {
  if (!Object.hasOwn(sends, id)) return sends;
  const send = sends[id];
  const dispatch = send.dispatch ?? null;
  if (dispatch === null || !pendingSandboxDispatchCurrent(id, dispatch))
    return sends;
  return { ...sends, [id]: { ...send, dispatch: update(dispatch) } };
}

export const usePendingSandboxSendStore =
  create<PendingSandboxSendStoreState>()(
    persist(
      (set, get) => ({
        sends: {},
        add: (send) =>
          set((state) => ({ sends: { ...state.sends, [send.id]: send } })),
        confirmEpic: (id) =>
          set((state) => {
            if (!Object.hasOwn(state.sends, id)) return state;
            const send = state.sends[id];
            if (
              !pendingDecision(
                send,
                "confirm",
                UNKNOWN_PENDING_SEND_FACTS,
              ).effects.includes("confirm-epic")
            )
              return state;
            return {
              sends: { ...state.sends, [id]: { ...send, epicConfirmed: true } },
            };
          }),
        beginDispatch: (id, dispatch) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          const stage = readStagedSandbox(pendingSendSurfaceKey(id));
          if (
            !pendingDecision(send, "prepared", {
              ...UNKNOWN_PENDING_SEND_FACTS,
              modelReady: true,
              stageCurrent:
                stage?.phase === "handoff" &&
                stage.createdHostId === dispatch.input.hostId &&
                stage.failure === null,
            }).effects.includes("persist-claim")
          )
            return false;
          try {
            const captured = structuredClone(dispatch);
            set({ sends: { ...sends, [id]: { ...send, dispatch: captured } } });
          } catch {
            // A record can be durable even if updating the map header failed.
            if (pendingSandboxDispatchCurrent(id, dispatch)) return true;
            // set updates memory before persistence; undo the unpersisted claim.
            try {
              set({ sends });
            } catch {
              // The restored memory still retains the unsent message.
            }
            return false;
          }
          return pendingSandboxDispatchCurrent(id, dispatch);
        },
        markDispatchUncertain: (id) => {
          try {
            set((state) => ({
              sends: withDispatch(state.sends, id, (dispatch) =>
                pendingDecision(
                  state.sends[id],
                  "transport-fail",
                  UNKNOWN_PENDING_SEND_FACTS,
                ).effects.includes("uncertain")
                  ? { ...dispatch, status: "uncertain" }
                  : dispatch,
              ),
            }));
          } catch {
            // Memory is uncertain; the durable claim still holds the exact
            // request. A storage outage never authorizes another identity.
          }
        },
        retryDispatch: (id, facts) =>
          set((state) => ({
            sends: withDispatch(state.sends, id, (dispatch) => {
              const plan = pendingDecision(state.sends[id], "retry", facts);
              return plan.effects.includes("retry")
                ? {
                    ...dispatch,
                    status: "sending",
                    blocker: plan.state.blocker,
                  }
                : dispatch;
            }),
          })),
        refuseDispatch: (id) =>
          set((state) => ({
            sends: withDispatch(state.sends, id, (dispatch) =>
              pendingDecision(
                state.sends[id],
                "known-refusal",
                UNKNOWN_PENDING_SEND_FACTS,
              ).effects.includes("known-refusal")
                ? null
                : dispatch,
            ),
          })),
        endDispatch: (id, dispatch, event) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          if (dispatch !== null && !pendingSandboxDispatchCurrent(id, dispatch))
            return false;
          if (
            !pendingDecision(send, event, {
              ...UNKNOWN_PENDING_SEND_FACTS,
              host: event === "terminal-row" ? "ended" : "unknown",
            }).effects.includes("end-host")
          )
            return false;
          try {
            set({
              sends: {
                ...sends,
                [id]: {
                  ...send,
                  content:
                    dispatch?.input.initialMessage?.content ?? send.content,
                  settings: dispatch?.input.settings ?? send.settings,
                  dispatch: null,
                  ended: true,
                },
              },
            });
          } catch {
            if (pendingSandboxSendWithdrawalState(id) === "ended") return true;
            try {
              set({ sends });
            } catch {
              /* Keep the original claim accountable. */
            }
            return false;
          }
          return pendingSandboxSendWithdrawalState(id) === "ended";
        },
        markDelivered: (id, delivery) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          if (
            !pendingDecision(
              send,
              "host-accept",
              UNKNOWN_PENDING_SEND_FACTS,
            ).effects.includes("record-receipt")
          )
            return false;
          try {
            set({
              sends: withoutOldDeliveries({
                ...sends,
                [id]: { ...send, dispatch: null, delivery },
              }),
            });
            const stored = storedSend(id);
            if (
              stored !== null &&
              JSON.stringify(stored.delivery) === JSON.stringify(delivery)
            )
              return true;
          } catch {
            const stored = storedSend(id);
            if (
              stored !== null &&
              JSON.stringify(stored.delivery) === JSON.stringify(delivery)
            )
              return true;
          }
          const failed = transitionPendingSend(
            { ...pendingSendState(send, "none"), phase: "accepted" },
            "receipt-write-failed",
            { ...UNKNOWN_PENDING_SEND_FACTS, current: true },
          );
          const dispatch = send.dispatch ?? null;
          try {
            set({
              sends: {
                ...sends,
                [id]: {
                  ...send,
                  dispatch:
                    dispatch === null
                      ? null
                      : {
                          ...dispatch,
                          status:
                            failed.state.phase === "uncertain"
                              ? "uncertain"
                              : dispatch.status,
                        },
                },
              },
            });
          } catch {
            /* The original durable identity remains replayable. */
          }
          return false;
        },
        remove: (id) =>
          set((state) => {
            if (!Object.hasOwn(state.sends, id)) return state;
            if (
              !pendingDecision(
                state.sends[id],
                "remove",
                UNKNOWN_PENDING_SEND_FACTS,
              ).effects.includes("remove")
            )
              return state;
            const next = { ...state.sends };
            delete next[id];
            return { sends: next };
          }),
        completeTerminal: (id) =>
          set((state) => {
            if (
              !Object.hasOwn(state.sends, id) ||
              !pendingDecision(
                state.sends[id],
                "terminal-opened",
                UNKNOWN_PENDING_SEND_FACTS,
              ).effects.includes("remove")
            )
              return state;
            const sends = { ...state.sends };
            delete sends[id];
            return { sends };
          }),
        dispatchEvent: (id, event, environment) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return null;
          const send = sends[id];
          const plan = pendingDecision(send, event, environment);
          const dispatch = send.dispatch ?? null;
          if (
            dispatch !== null &&
            (plan.state.phase === "sending" ||
              plan.state.phase === "uncertain") &&
            (dispatch.status !== plan.state.phase ||
              (dispatch.blocker ?? "none") !== plan.state.blocker)
          ) {
            try {
              set({
                sends: {
                  ...sends,
                  [id]: {
                    ...send,
                    dispatch: {
                      ...dispatch,
                      status: plan.state.phase,
                      blocker: plan.state.blocker,
                    },
                  },
                },
              });
            } catch {
              /* Storage failure retains the original immutable dispatch identity. */
            }
          }
          return plan;
        },
        clearDelivered: () =>
          set((state) => {
            const sends = { ...state.sends };
            for (const send of Object.values(state.sends)) {
              const plan = pendingDecision(
                send,
                "account-away",
                UNKNOWN_PENDING_SEND_FACTS,
              );
              for (const effect of plan.effects) {
                if (effect === "remove") delete sends[send.id];
              }
            }
            return { sends };
          }),
      }),
      {
        ...basePersistOptions(persistKey(STORE_KEYS.pendingSandboxSend)),
        storage: createJSONStorage(() => createRecordMapStorage("sends")),
        // Source content roots images by hash. A claimed request keeps its
        // prepared content, including inline bytes required by older hosts.
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

installCrossWindowRehydrate(
  usePendingSandboxSendStore,
  persistKey(STORE_KEYS.pendingSandboxSend),
);

// A send's message is the only copy of it once its draft is gone: its images
// stay rooted against the landing GC until it is delivered, when its agent's
// first-turn handoff roots them, or ends.
registerExtraImageRootSource({
  hashes: () =>
    Object.values(usePendingSandboxSendStore.getState().sends).flatMap(
      (send) =>
        send.delivery === null ? blobHashesFromContent(send.content) : [],
    ),
});

/** The stage key a pending send's create runs under. */
export function pendingSendSurfaceKey(id: string): string {
  return `${PENDING_SEND_SURFACE_PREFIX}${id}`;
}
