import type { QueueItem, VoiceFocus } from "@/stores/voice/voice-session-store";

/**
 * What a session opens knowing, sent with the mint because the vendor
 * accepts startup input only at creation. The briefing a later ticket
 * composes (unread answers by bot and thread, open questions) goes here; until
 * then one line, so the contract is exercised end to end.
 */
export const FIRST_SESSION_INPUT = "Listening.";

/**
 * The replacement session's seed: one paragraph of what the person was doing
 * and what is waiting, so the new engine carries on where the old one left
 * off. Nothing is replayed: posts already landed are rows.
 */
export function remintInput(input: {
  readonly focus: VoiceFocus | null;
  readonly botTitle: (botId: string) => string;
  readonly queue: ReadonlyArray<QueueItem>;
}): string {
  const parts: string[] = ["Continuing a conversation already under way."];
  if (input.focus !== null) {
    const bot = input.botTitle(input.focus.botId);
    parts.push(
      input.focus.threadId === null
        ? `The person is talking to ${bot} in its channel.`
        : `The person is in a thread with ${bot}.`,
    );
  }
  if (input.queue.length > 0) {
    parts.push(
      `Waiting to be read: ${input.queue.map((item) => item.line).join("; ")}.`,
    );
  }
  return parts.join(" ");
}

/**
 * The re-mint threshold on the vendor's context usage ratio. The probe
 * (2026-10-30, P3) measured the window filling at about 0.0094 a minute on
 * near-silence, reaching the vendor's own 0.9 engine replacement near
 * minute 95; re-minting at 0.8 (about minute 85) keeps the replacement the
 * app's, seeded with what it chooses to carry.
 */
export const REMINT_CONTEXT_USAGE_RATIO = 0.8;

/** The latest a re-mint happens before the session's expiry, whatever the usage says. */
export const REMINT_BEFORE_EXPIRY_MS = 60_000;

/**
 * A started session that ends within this is short-lived: it did not outlive
 * the ceiling the engine gives its own handshake (`SESSION_STARTED_TIMEOUT_MS`,
 * 10 s), so nobody got a word in or out of it. The window is measured from
 * the session's start, so a vendor close, a connection drop and an expiry
 * the server set inside the re-mint lead all count the same way.
 */
export const SHORT_SESSION_MS = 10_000;

/**
 * Consecutive short-lived sessions before the re-mint stops and the session
 * ends with "connection": the same budget the scheduler gives a spoken item
 * (`MAX_DELIVERY_ATTEMPTS`), the layer's one retry budget. Each re-mint is
 * a billed server row and a vendor connect, so a vendor or server that keeps
 * handing back sessions that die at once is not retried without bound; the
 * person presses Talk again when it is back.
 */
export const MAX_SHORT_SESSIONS = 3;
