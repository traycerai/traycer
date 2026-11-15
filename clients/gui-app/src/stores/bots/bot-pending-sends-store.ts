import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";

/**
 * Where a member's own send that carries a nonce is (Tracy Bots T249):
 * - `sending`: an attempt is out, and none before it was uncertain;
 * - `accepted`: the host answered, and its stored row has not been seen;
 * - `uncertain`: an attempt ended without saying whether the host wrote it.
 *   Retry sends the same request again, nonce included.
 */
export type BotPendingSendState = "sending" | "accepted" | "uncertain";

/**
 * A send drawn in its chat from the press of Send until the host's stored row
 * is seen there. The stored row has the same id, derived from the send's
 * nonce, so it takes the pending row's place: never a second row.
 */
export interface BotPendingSend {
  readonly botId: string;
  /** The chat the stored row lands in: the channel's conversation, or the thread's. */
  readonly chatId: string;
  /** The host serving the tab, whose session of `chatId` delivers the stored row. */
  readonly hostId: string;
  /** What is drawn, shaped as the stored row will be, under its id. */
  readonly row: Message;
  /** The request as it was sent, nonce included; Retry sends it again unchanged. */
  readonly request: BotConversationSendRequest;
  readonly state: BotPendingSendState;
  /**
   * Set on the send's first uncertain outcome and never cleared. A later
   * attempt that wrote nothing says nothing of an earlier one that may have:
   * once set, every failure keeps the send uncertain.
   */
  readonly everUncertain: boolean;
  /** `true` while an attempt is out. */
  readonly inFlight: boolean;
  /** Lets go of what the box's draft held for this send, once the host has it; `null` once done. */
  readonly release: (() => void) | null;
}

/** What a send's settled attempt left it as, for the caller that awaited it. */
export type BotPendingSendFate =
  /** Its stored row was seen first: it is done, whatever the attempt said. */
  | "stored"
  /** It is no longer held: its account signed out or another signed in. */
  | "gone"
  /** Still drawn: accepted, or uncertain. */
  | "kept"
  /** The host wrote nothing on its only attempt: the row is gone, and the content is the caller's to give back. */
  | "refused";

interface BotPendingSendsState {
  /** By the row's id. */
  readonly entries: Readonly<Partial<Record<string, BotPendingSend>>>;
  /**
   * The rows whose stored row was seen. A late answer to one of them changes
   * nothing, and nothing brings it back.
   */
  readonly stored: ReadonlySet<string>;
}

/**
 * The member's own sends still on their way, for this window only: nothing
 * is persisted, so a reload holds none of them (the stated limit of T249).
 * Every account change retires them all
 * (`BotDraftsPersistLifecycleBridge`).
 */
export const useBotPendingSendsStore = create<BotPendingSendsState>()(() => ({
  entries: {},
  stored: new Set<string>(),
}));

/**
 * The sends held for `chatId` of `botId`, as the session `hostId` serves it,
 * oldest first.
 */
export function useHeldPendingSends(
  botId: string,
  chatId: string,
  hostId: string,
): ReadonlyArray<BotPendingSend> {
  return useBotPendingSendsStore(
    useShallow((state) =>
      Object.values(state.entries)
        .filter(
          (entry): entry is BotPendingSend =>
            entry !== undefined &&
            entry.botId === botId &&
            entry.chatId === chatId &&
            entry.hostId === hostId,
        )
        .sort((a, b) => a.row.timestamp - b.row.timestamp),
    ),
  );
}

/** Holds `send`, drawn at once as its chat's last row. */
export function holdPendingSend(
  send: Omit<BotPendingSend, "state" | "everUncertain" | "inFlight">,
): void {
  const messageId = send.row.messageId;
  useBotPendingSendsStore.setState((state) =>
    state.stored.has(messageId)
      ? state
      : {
          entries: {
            ...state.entries,
            [messageId]: {
              ...send,
              state: "sending",
              everUncertain: false,
              inFlight: true,
            },
          },
        },
  );
}

/**
 * Marks another attempt of the send drawn as `messageId` out, and returns its
 * request; `null` when the send is not held or an attempt is already out.
 */
export function attemptPendingSend(
  messageId: string,
): BotConversationSendRequest | null {
  const entry = useBotPendingSendsStore.getState().entries[messageId];
  if (entry === undefined || entry.inFlight) return null;
  replaceEntry(messageId, { ...entry, inFlight: true });
  return entry.request;
}

/**
 * Settles an attempt of the send drawn as `messageId`: `accepted` when the
 * host answered, `refused` when it attested this attempt wrote nothing, else
 * `uncertain`. A refusal ends the send only when no attempt of it was ever
 * uncertain.
 */
export function settlePendingSend(
  messageId: string,
  outcome: "accepted" | "refused" | "uncertain",
): BotPendingSendFate {
  const state = useBotPendingSendsStore.getState();
  if (state.stored.has(messageId)) return "stored";
  const entry = state.entries[messageId];
  if (entry === undefined) return "gone";
  if (outcome === "accepted") {
    entry.release?.();
    replaceEntry(messageId, {
      ...entry,
      state: "accepted",
      inFlight: false,
      release: null,
    });
    return "kept";
  }
  if (outcome === "refused" && !entry.everUncertain) {
    useBotPendingSendsStore.setState({
      entries: withoutEntries(state.entries, new Set([messageId])),
    });
    return "refused";
  }
  replaceEntry(messageId, {
    ...entry,
    state: "uncertain",
    everUncertain: true,
    inFlight: false,
  });
  return "kept";
}

/**
 * The stored rows of these ids were seen in their chat: each held send among
 * them is done for good.
 */
export function storedPendingSends(messageIds: ReadonlyArray<string>): void {
  const state = useBotPendingSendsStore.getState();
  const done = new Set(
    messageIds.filter((id) => state.entries[id] !== undefined),
  );
  if (done.size === 0) return;
  for (const id of done) state.entries[id]?.release?.();
  useBotPendingSendsStore.setState({
    entries: withoutEntries(state.entries, done),
    stored: new Set([...state.stored, ...done]),
  });
}

/** Retires every held send: the account they were sent under is no longer the one signed in. */
export function retirePendingSends(): void {
  useBotPendingSendsStore.setState(
    useBotPendingSendsStore.getInitialState(),
    true,
  );
}

function withoutEntries(
  entries: Readonly<Partial<Record<string, BotPendingSend>>>,
  ids: ReadonlySet<string>,
): Readonly<Partial<Record<string, BotPendingSend>>> {
  return Object.fromEntries(
    Object.entries(entries).filter(([id]) => !ids.has(id)),
  );
}

function replaceEntry(messageId: string, entry: BotPendingSend): void {
  useBotPendingSendsStore.setState((state) => ({
    entries: { ...state.entries, [messageId]: entry },
  }));
}
