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
