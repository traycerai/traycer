/**
 * The transcript's copy for a turn a SANDBOX refused or paused, keyed by the
 * error block's typed code. One table, code to copy: a sandbox code added
 * later (the secrets track's three) is one more row here and nothing else.
 *
 * These are the host's `RPC_ERROR_CODES` spellings (`SANDBOX_FROZEN`, ...),
 * which the host stamps on the error event's `code` and also leads its
 * message with (`SANDBOX_FROZEN: sandbox host '...': ...`). The row matches
 * the code first and the message prefix only when the block carries no code,
 * so an error raised from a typed host error renders the same either way.
 */
export interface SandboxRefusalCopy {
  /** The row's headline, in the interrupted (warning) presentation. */
  readonly headline: string;
  /** The sentence under it, in place of the host's raw message. */
  readonly description: string;
}

const SANDBOX_REFUSAL_COPY: Readonly<Record<string, SandboxRefusalCopy>> = {
  SANDBOX_FROZEN: {
    headline: "Paused: account out of credits",
    description:
      "This sandbox froze when your credits ran out, which ended the turn. Add credits, then send a message to pick up where it stopped.",
  },
};

export function sandboxRefusalCopyFor(
  code: string | null,
  message: string,
): SandboxRefusalCopy | null {
  if (code !== null && code.length > 0) {
    return Object.hasOwn(SANDBOX_REFUSAL_COPY, code)
      ? SANDBOX_REFUSAL_COPY[code]
      : null;
  }
  for (const [prefix, copy] of Object.entries(SANDBOX_REFUSAL_COPY)) {
    if (message.startsWith(`${prefix}:`)) return copy;
  }
  return null;
}
