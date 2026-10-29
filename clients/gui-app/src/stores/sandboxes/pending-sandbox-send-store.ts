import { collectAnnotationImageHashes } from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  decodePendingSandboxObservation,
  pendingSandboxOperationResultCurrent,
  type PendingSandboxObservation,
  type PendingSandboxPresence,
} from "@/lib/sandboxes/pending-sandbox-observation";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatQueueDeliveryPolicy } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  CreateChatRequestV14,
  CreateChatForkSourceV11,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import type { ReturnedSandbox } from "@/lib/sandboxes/returned-sandbox";
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
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { recordMapStorageKey } from "@/lib/persist/keys";
import {
  createPendingSendStorage,
  requestPendingDispatchRetry,
  type PendingDispatchRetryRequest,
} from "@/lib/sandboxes/pending-stage-storage";
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
  | {
      readonly kind: "message";
      readonly chatId: string;
      readonly hostId?: string;
      readonly worktreeIntent?: WorktreeIntent | null;
      readonly browserAnnotations?: readonly BrowserAnnotationRecord[];
      readonly deliveryPolicy?: ChatQueueDeliveryPolicy;
    }
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
  readonly input: CreateChatRequestV14 & { readonly settings: ChatRunSettings };
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
  /**
   * A durable withdrawal: its copy and roots remain until recovery settles.
   * `destination` is the sandbox a draft it lands in keeps, decided when the
   * withdrawal began: whoever finishes it keeps that decision. Absent on
   * legacy records, which keep no sandbox.
   */
  readonly returnRequested?: {
    readonly saveInDrafts: boolean;
    readonly destination?: ReturnedSandbox | null;
  };
  /** Absent on legacy records; once claimed, only the original request may retry. */
  readonly dispatch?: PendingSandboxSendDispatch | null;
  /** An authoritative sandbox or task loss permits recovery of its pending message. */
  readonly ended?: boolean;
  /** Only the lifecycle's hold-stop effect writes this durable intent. */
  readonly stopRequested?: boolean;
  readonly stopRequestedAt?: number;
  readonly observationRequestedAt?: number;
  /** A create response names a row; only a successful read proves it was listed. */
  readonly createdSandbox?: PendingSandboxPresence;
  /** Original-account observation survives auth clearing the transient stage. */
  readonly stopStage?: StagedSandbox;
  readonly retryRequest?: PendingDispatchRetryRequest;
  readonly retryHandledId?: string;
}

/** Delivered sends kept for their ready line; the oldest are dropped first. */
const DELIVERED_KEPT = 50;

interface PendingSandboxSendStoreState {
  readonly sends: Readonly<Record<string, PendingSandboxSend>>;
  readonly add: (send: PendingSandboxSend) => void;
  readonly holdStop: (id: string) => boolean;
  /**
   * Records a withdrawal. Its `destination` is decided once: a later begin,
   * even one that saves to Drafts, keeps the recorded one.
   */
  readonly beginReturn: (
    id: string,
    saveInDrafts: boolean,
    destination: ReturnedSandbox | null,
  ) => boolean;
  readonly holdObservation: (
    id: string,
    plan: PendingSendTransition,
  ) => number | null;
  readonly ensureObservationBoundary: (id: string) => void;
  readonly recordCreatedSandbox: (id: string, sandboxId: string) => boolean;
  readonly markSandboxRowSeen: (
    id: string,
    sandboxId: string,
    observation: PendingSandboxObservation,
  ) => boolean;
  readonly confirmEpic: (id: string) => void;
  readonly beginDispatch: (
    id: string,
    dispatch: PendingSandboxSendDispatch,
  ) => boolean;
  readonly markDispatchUncertain: (
    id: string,
    dispatch: PendingSandboxSendDispatch,
  ) => void;
  readonly requestDispatchRetry: (id: string) => string | null;
  readonly refuseDispatch: (
    id: string,
    dispatch: PendingSandboxSendDispatch,
  ) => void;
  readonly endDispatch: (
    id: string,
    dispatch: PendingSandboxSendDispatch | null,
    event: "terminal-row" | "task-deleted",
    environment: PendingSendFacts,
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
  const authoritativeSend = {
    ...send,
    createdSandbox:
      storedSandboxPresence(stored) ?? unobservedCreatedSandbox(id),
    observationRequestedAt:
      typeof stored?.observationRequestedAt === "number"
        ? stored.observationRequestedAt
        : undefined,
    stopRequestedAt:
      typeof stored?.stopRequestedAt === "number"
        ? stored.stopRequestedAt
        : undefined,
  };
  const observedHost = decodePendingSandboxObservation(
    authoritativeSend,
    environment.host,
    environment.observation,
  );
  return {
    ...environment,
    host: observedHost,
    current:
      durableSendMatches(send, stored, dispatch) &&
      pendingSandboxOperationResultCurrent(
        authoritativeSend,
        environment.observation,
      ),
    terminalDisposition: stored?.ended === true,
    stopRequested: stored?.stopRequested === true,
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

function storedSandboxPresence(
  stored: Record<string, unknown> | null,
): PendingSandboxPresence | undefined {
  const presence = stored?.createdSandbox;
  if (
    typeof presence !== "object" ||
    presence === null ||
    !("sandboxId" in presence) ||
    typeof presence.sandboxId !== "string" ||
    !("rowSeen" in presence) ||
    typeof presence.rowSeen !== "boolean"
  )
    return undefined;
  return { sandboxId: presence.sandboxId, rowSeen: presence.rowSeen };
}

/** A resumed creating stage may know its id only from the old create response. */
function unobservedCreatedSandbox(
  id: string,
): PendingSandboxPresence | undefined {
  const stage = readStagedSandbox(pendingSendSurfaceKey(id));
  return stage?.phase === "creating" &&
    stage.target.kind === "new" &&
    stage.createdSandboxId !== null
    ? { sandboxId: stage.createdSandboxId, rowSeen: false }
    : undefined;
}

/** A stale progress writer cannot erase a read already proved for this identity. */
function sandboxPresenceForWrite(
  send: PendingSandboxSend,
): PendingSandboxPresence | undefined {
  const stored = storedSandboxPresence(storedSend(send.id));
  if (send.createdSandbox === undefined) return stored;
  return stored?.sandboxId === send.createdSandbox.sandboxId && stored.rowSeen
    ? stored
    : send.createdSandbox;
}

/** Presence is owner metadata; failed persistence never authorizes absence. */
function persistSandboxPresence(
  id: string,
  presence: PendingSandboxPresence,
): boolean {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return false;
  const send = sends[id];
  const facts = pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS);
  if (!facts.current || !facts.accountActive || !facts.owns) return false;
  try {
    usePendingSandboxSendStore.setState({
      sends: {
        ...sends,
        [id]: { ...send, createdSandbox: presence },
      },
    });
  } catch {
    /* A partial header write may still have persisted the record. */
  }
  const stored = storedSandboxPresence(storedSend(id));
  if (
    stored?.sandboxId === presence.sandboxId &&
    stored.rowSeen === presence.rowSeen
  )
    return true;
  try {
    usePendingSandboxSendStore.setState({ sends });
  } catch {
    /* The prior record retains the send and its last proven presence. */
  }
  return false;
}

/** Progress may be stale, but no changed claim, receipt or Stop identity can be acted on. */
function durableSendMatches(
  send: PendingSandboxSend,
  stored: Record<string, unknown> | null,
  dispatch: PendingSandboxSendDispatch | null,
): boolean {
  if (
    stored === null ||
    (stored.ended === true) !== (send.ended === true) ||
    (stored.stopRequested === true) !== (send.stopRequested === true) ||
    JSON.stringify(stored.returnRequested ?? null) !==
      JSON.stringify(send.returnRequested ?? null)
  )
    return false;
  return stored.delivery === null
    ? send.delivery === null &&
        (dispatch === null || pendingSandboxDispatchCurrent(send.id, dispatch))
    : send.delivery !== null &&
        JSON.stringify(stored.delivery) === JSON.stringify(send.delivery);
}

/** Legacy held requests acquire provenance before any observation can settle them. */
function legacyObservationBoundary(
  send: PendingSandboxSend,
  boundary: number,
): PendingSandboxSend {
  if (send.stopRequested !== true)
    return { ...send, observationRequestedAt: boundary };
  return {
    ...send,
    observationRequestedAt: boundary,
    stopRequestedAt: send.stopRequestedAt ?? boundary,
  };
}

/** A pending stage's run and each async continuation need the owner's current authority. */
export function pendingSandboxStageRunAllowed(
  surfaceKey: string,
  host: PendingSendFacts["host"],
): boolean {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return true;
  const id = surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length);
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id) || sends[id].returnRequested !== undefined)
    return false;
  const stage = readStagedSandbox(surfaceKey);
  const plan = transitionPendingSend(
    pendingSendState(sends[id], "none"),
    "observe",
    pendingSandboxSendFacts(id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      host,
      observation: { kind: "intent" },
      clientReady: true,
      stageStatus: stage?.phase ?? "missing",
    }),
  );
  return plan.effects.includes("run-stage") || plan.effects.includes("wake");
}

/** Core runner rows/results use the same provenance decoder as visible observers. */
export function pendingSandboxStageObservation(
  surfaceKey: string,
  host: PendingSendFacts["host"],
  observation: PendingSandboxObservation,
): PendingSendFacts["host"] {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX))
    return decodePendingSandboxObservation(
      observation.kind === "list"
        ? null
        : { createdAt: 0, observationRequestedAt: 0 },
      host,
      observation,
    );
  return pendingSandboxSendFacts(
    surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length),
    { ...UNKNOWN_PENDING_SEND_FACTS, host, observation },
  ).host;
}

/** The low-level create/wake runner shares the pending record's verified boundary. */
export function holdPendingSandboxStageObservation(
  surfaceKey: string,
): number | null {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return 0;
  const id = surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length);
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id) || sends[id].returnRequested !== undefined)
    return null;
  const stage = readStagedSandbox(surfaceKey);
  const plan = transitionPendingSend(
    pendingSendState(sends[id], "none"),
    "observe",
    pendingSandboxSendFacts(id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      host: stage?.phase === "handoff" ? "resting" : "unknown",
      observation: { kind: "intent" },
      stageStatus: stage?.phase ?? "missing",
    }),
  );
  return usePendingSandboxSendStore.getState().holdObservation(id, plan);
}

/** A newly accepted create is persisted before the runner publishes its id. */
export function recordPendingSandboxStageCreated(
  surfaceKey: string,
  sandboxId: string,
): boolean {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return true;
  return usePendingSandboxSendStore
    .getState()
    .recordCreatedSandbox(
      surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length),
      sandboxId,
    );
}

/** Core runner reads share the same durable presence evidence as visible watchers. */
export function markPendingSandboxStageRowSeen(
  surfaceKey: string,
  sandboxId: string,
  observation: PendingSandboxObservation,
): boolean {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return true;
  const id = surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length);
  const presence =
    storedSandboxPresence(storedSend(id)) ?? unobservedCreatedSandbox(id);
  if (presence === undefined) return true;
  return usePendingSandboxSendStore
    .getState()
    .markSandboxRowSeen(id, sandboxId, observation);
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
    stored.returnRequested !== undefined ||
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

/** A projection changes status/blocker, never the immutable replay request. */
function projectDispatchTransition(
  dispatch: PendingSandboxSendDispatch | null,
  plan: PendingSendTransition,
): PendingSandboxSendDispatch | null {
  if (
    dispatch === null ||
    (plan.state.phase !== "sending" && plan.state.phase !== "uncertain")
  )
    return dispatch;
  if (
    dispatch.status === plan.state.phase &&
    (dispatch.blocker ?? "none") === plan.state.blocker
  )
    return dispatch;
  return { ...dispatch, status: plan.state.phase, blocker: plan.state.blocker };
}

export const usePendingSandboxSendStore =
  create<PendingSandboxSendStoreState>()(
    persist(
      (set, get) => ({
        sends: {},
        add: (send) =>
          set((state) => ({ sends: { ...state.sends, [send.id]: send } })),
        holdStop: (id) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          const stage =
            readStagedSandbox(pendingSendSurfaceKey(id)) ?? send.stopStage;
          if (
            stage === undefined ||
            !pendingDecision(send, "stop", {
              ...UNKNOWN_PENDING_SEND_FACTS,
              sandboxKnown: stage.createdSandboxId !== null,
            }).effects.includes("hold-stop")
          )
            return false;
          const boundary = Date.now();
          try {
            set({
              sends: {
                ...sends,
                [id]: {
                  ...send,
                  stopRequested: true,
                  stopRequestedAt: boundary,
                  observationRequestedAt: boundary,
                  stopStage: stage,
                },
              },
            });
          } catch {
            if (storedSend(id)?.stopRequestedAt === boundary) return true;
            try {
              set({ sends });
            } catch {
              /* Retain the unsent copy. */
            }
            return false;
          }
          return storedSend(id)?.stopRequestedAt === boundary;
        },
        ensureObservationBoundary: (id) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return;
          const send = sends[id];
          const facts = pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS);
          if (!facts.current || !facts.owns || !facts.accountActive) return;
          if ((send.dispatch ?? null) === null && send.stopRequested !== true)
            return;
          if (
            send.observationRequestedAt !== undefined &&
            (send.stopRequested !== true || send.stopRequestedAt !== undefined)
          )
            return;
          const boundary = Date.now();
          try {
            set({
              sends: {
                ...sends,
                [id]: legacyObservationBoundary(send, boundary),
              },
            });
          } catch {
            /* Readback, rather than memory, grants observation authority. */
          }
          if (storedSend(id)?.observationRequestedAt !== boundary) {
            try {
              set({ sends });
            } catch {
              /* Keep missing provenance unknown. */
            }
          }
        },
        holdObservation: (id, plan) => {
          const { sends } = get();
          if (
            !Object.hasOwn(sends, id) ||
            sends[id].returnRequested !== undefined
          )
            return null;
          const facts = pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS);
          if (!facts.current || !facts.accountActive || !facts.owns)
            return null;
          if (
            !plan.effects.some(
              (effect) =>
                effect === "wake" ||
                effect === "run-stage" ||
                effect === "dispatch" ||
                effect === "retry",
            )
          )
            return null;
          const boundary = Date.now();
          try {
            set({
              sends: {
                ...sends,
                [id]: { ...sends[id], observationRequestedAt: boundary },
              },
            });
          } catch {
            /* Readback decides whether the request may leave this window. */
          }
          if (storedSend(id)?.observationRequestedAt === boundary)
            return boundary;
          try {
            set({ sends });
          } catch {
            /* Keep the prior accountable request. */
          }
          return null;
        },
        recordCreatedSandbox: (id, sandboxId) => {
          const prior = storedSandboxPresence(storedSend(id));
          if (prior?.sandboxId === sandboxId) return true;
          return persistSandboxPresence(id, { sandboxId, rowSeen: false });
        },
        markSandboxRowSeen: (id, sandboxId, observation) => {
          const prior =
            storedSandboxPresence(storedSend(id)) ??
            unobservedCreatedSandbox(id);
          if (prior?.sandboxId !== sandboxId) return false;
          if (prior.rowSeen) return true;
          if (
            observation.kind !== "list" ||
            observation.missingSandboxId !== undefined ||
            pendingSandboxSendFacts(id, {
              ...UNKNOWN_PENDING_SEND_FACTS,
              host: "awake",
              observation,
            }).host === "unknown"
          )
            return false;
          return persistSandboxPresence(id, { sandboxId, rowSeen: true });
        },
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
        beginReturn: (id, saveInDrafts, destination) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          if (
            !pendingDecision(
              send,
              "return",
              UNKNOWN_PENDING_SEND_FACTS,
            ).effects.includes("remove")
          )
            return false;
          if (
            send.returnRequested !== undefined &&
            (send.returnRequested.saveInDrafts || !saveInDrafts)
          )
            return true;
          const requested = {
            saveInDrafts,
            destination:
              send.returnRequested === undefined
                ? destination
                : (send.returnRequested.destination ?? null),
          };
          try {
            set({
              sends: {
                ...sends,
                [id]: { ...send, returnRequested: requested },
              },
            });
          } catch {
            /* The record write may precede a failed header write. */
          }
          if (
            JSON.stringify(storedSend(id)?.returnRequested) ===
            JSON.stringify(requested)
          )
            return true;
          try {
            set({ sends });
          } catch {
            /* Keep the pending source. */
          }
          return false;
        },
        beginDispatch: (id, dispatch) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          if (send.returnRequested !== undefined) return false;
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
          const boundary = Date.now();
          try {
            const captured = structuredClone(dispatch);
            set({
              sends: {
                ...sends,
                [id]: {
                  ...send,
                  dispatch: captured,
                  observationRequestedAt: boundary,
                },
              },
            });
          } catch {
            // A record can be durable even if updating the map header failed.
            if (
              pendingSandboxDispatchCurrent(id, dispatch) &&
              storedSend(id)?.observationRequestedAt === boundary
            )
              return true;
            // set updates memory before persistence; undo the unpersisted claim.
            try {
              set({ sends });
            } catch {
              // The restored memory still retains the unsent message.
            }
            return false;
          }
          return (
            pendingSandboxDispatchCurrent(id, dispatch) &&
            storedSend(id)?.observationRequestedAt === boundary
          );
        },
        markDispatchUncertain: (id, captured) => {
          try {
            set((state) => ({
              sends: withDispatch(state.sends, id, (dispatch) =>
                pendingDecision(state.sends[id], "transport-fail", {
                  ...UNKNOWN_PENDING_SEND_FACTS,
                  observation: {
                    kind: "dispatch-result",
                    chatId: captured.input.chatId,
                    hostId: captured.input.hostId,
                  },
                }).effects.includes("uncertain")
                  ? { ...dispatch, status: "uncertain" }
                  : dispatch,
              ),
            }));
          } catch {
            // Memory is uncertain; the durable claim still holds the exact
            // request. A storage outage never authorizes another identity.
          }
        },
        requestDispatchRetry: (id) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return null;
          const send = sends[id];
          const dispatch = send.dispatch ?? null;
          if (
            dispatch === null ||
            !pendingDecision(
              send,
              "request-dispatch-retry",
              UNKNOWN_PENDING_SEND_FACTS,
            ).effects.includes("request-dispatch-retry")
          )
            return null;
          const request = requestPendingDispatchRetry({
            id,
            userId: send.userId,
            chatId: dispatch.input.chatId,
            hostId: dispatch.input.hostId,
          });
          if (request !== null)
            void usePendingSandboxSendStore.persist.rehydrate();
          return request;
        },
        refuseDispatch: (id, captured) =>
          set((state) => ({
            sends: withDispatch(state.sends, id, (dispatch) =>
              pendingDecision(state.sends[id], "known-refusal", {
                ...UNKNOWN_PENDING_SEND_FACTS,
                observation: {
                  kind: "dispatch-result",
                  chatId: captured.input.chatId,
                  hostId: captured.input.hostId,
                },
              }).effects.includes("known-refusal")
                ? null
                : dispatch,
            ),
          })),
        endDispatch: (id, dispatch, event, environment) => {
          const { sends } = get();
          if (!Object.hasOwn(sends, id)) return false;
          const send = sends[id];
          if (dispatch !== null && !pendingSandboxDispatchCurrent(id, dispatch))
            return false;
          if (
            !pendingDecision(send, event, {
              ...environment,
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
            !pendingDecision(send, "host-accept", {
              ...UNKNOWN_PENDING_SEND_FACTS,
              host: "awake",
              observation: {
                kind: "dispatch-result",
                chatId: delivery.chatId,
                hostId: delivery.hostId,
              },
            }).effects.includes("record-receipt")
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
          const dispatch = projectDispatchTransition(
            send.dispatch ?? null,
            plan,
          );
          const ack = plan.effects.includes("acknowledge-retry")
            ? send.retryRequest?.id
            : undefined;
          if (
            dispatch === send.dispatch &&
            (ack === undefined || ack === send.retryHandledId)
          )
            return plan;
          try {
            set({
              sends: {
                ...sends,
                [id]: {
                  ...send,
                  dispatch,
                  retryHandledId: ack ?? send.retryHandledId,
                  observationRequestedAt: plan.effects.includes("retry")
                    ? Date.now()
                    : send.observationRequestedAt,
                },
              },
            });
          } catch {
            // A partial write is usable only if its acknowledgement is durable.
            if (ack === undefined) return plan;
          }
          if (ack !== undefined && storedSend(id)?.retryHandledId !== ack) {
            try {
              set({ sends });
            } catch {
              /* Restore the original claim in memory too. */
            }
            return null;
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
        storage: createJSONStorage(createPendingSendStorage),
        // Source content roots images by hash. A claimed request keeps its
        // prepared content, including inline bytes required by older hosts.
        partialize: (state) => ({
          sends: Object.fromEntries(
            Object.entries(state.sends).map(([id, send]) => [
              id,
              {
                ...send,
                createdSandbox: sandboxPresenceForWrite(send),
                content: stripBase64ImageNodes(send.content),
              },
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
        send.delivery === null
          ? [
              ...blobHashesFromContent(send.content),
              ...(send.request.kind === "message"
                ? collectAnnotationImageHashes(
                    send.request.browserAnnotations ?? [],
                  )
                : []),
            ]
          : [],
    ),
});

/** The stage key a pending send's create runs under. */
export function pendingSendSurfaceKey(id: string): string {
  return `${PENDING_SEND_SURFACE_PREFIX}${id}`;
}
