/**
 * The transcript's copy for a turn a SANDBOX refused or paused, keyed by the
 * error block's typed code. One table, code to copy. The brokered-egress
 * refusals (a missing grant, a stale authorization, an offline connector, ...)
 * are not repeated here: their rows live in the egress table the sandbox card
 * also reads (`sandbox-egress-refusal-copy.ts`) and are looked up there.
 *
 * These are the host's `RPC_ERROR_CODES` spellings (`SANDBOX_FROZEN`, ...),
 * which the host stamps on the error event's `code` and also leads its
 * message with (`SANDBOX_FROZEN: sandbox host '...': ...`). The row matches
 * the code first and the message prefix only when the block carries no code,
 * so an error raised from a typed host error renders the same either way.
 */
import { SANDBOX_EGRESS_REFUSAL_CODES } from "@traycer/protocol/host/sandbox-egress";
import {
  NO_EGRESS_REFUSAL_SUBJECT,
  sandboxEgressRefusalCopyFor,
} from "@/lib/sandboxes/sandbox-egress-refusal-copy";

export interface SandboxRefusalCopy {
  /** The row's headline, in the interrupted (warning) presentation. */
  readonly headline: string;
  /** The sentence under it, in place of the host's raw message. */
  readonly description: string;
  /**
   * What the host said went wrong, for a row whose host message carries
   * something the user can act on (the guest setup's last status); `null`
   * otherwise, and when the host sent nothing past the code.
   */
  readonly hostDetail: string | null;
}

interface SandboxRefusalRow {
  readonly headline: string;
  readonly description: string;
  /** Whether the host's message, past its code, is shown as the detail. */
  readonly showsHostDetail: boolean;
}

/**
 * One row per sandbox code in `RPC_ERROR_CODES`, so none of them falls through
 * to the generic red failure with the host's raw message.
 */
const SANDBOX_REFUSAL_COPY: Readonly<Record<string, SandboxRefusalRow>> = {
  SANDBOX_FROZEN: {
    headline: "Paused: account out of credits",
    description:
      "This sandbox froze when your credits ran out, which ended the turn. Add credits, then send a message to pick up where it stopped.",
    showsHostDetail: false,
  },
  SANDBOX_GUEST_NOT_CONFIGURED: {
    headline: "Waiting for this sandbox's setup to finish",
    description:
      "The agent could not start because this sandbox is still being set up. Retry in a minute, or once the setup notice on its card clears.",
    showsHostDetail: true,
  },
  SANDBOX_HOST_REFUSES_CREDENTIALS: {
    headline: "Sandboxes don't take sign-ins",
    description:
      "This needed a sign-in or a key on the sandbox, and a sandbox never holds your credentials. Run it on one of your own hosts instead.",
    showsHostDetail: false,
  },
  PROFILE_REFUSES_AGENTS: {
    headline: "Automations doesn't run agents",
    description:
      "The Automations host runs shells, terminals and file copies only. Start the agent on one of your own hosts or on a sandbox.",
    showsHostDetail: false,
  },
};

export function sandboxRefusalCopyFor(
  code: string | null,
  message: string,
): SandboxRefusalCopy | null {
  if (code !== null && code.length > 0) {
    return Object.hasOwn(SANDBOX_REFUSAL_COPY, code)
      ? copyOf(SANDBOX_REFUSAL_COPY[code], code, message)
      : egressRefusalCopyOf(code, message);
  }
  for (const [prefix, row] of Object.entries(SANDBOX_REFUSAL_COPY)) {
    if (message.startsWith(`${prefix}:`)) return copyOf(row, prefix, message);
  }
  for (const prefix of SANDBOX_EGRESS_REFUSAL_CODES) {
    if (message.startsWith(`${prefix}:`)) {
      return egressRefusalCopyOf(prefix, message);
    }
  }
  return null;
}

/**
 * A brokered-egress refusal that ended a turn. The copy is the egress table's
 * own row, so the transcript and the sandbox card say the same thing about one
 * code. An error block names no secret, host or protocol of its own; the
 * host's message does, and is shown as the detail.
 */
function egressRefusalCopyOf(
  code: string,
  message: string,
): SandboxRefusalCopy | null {
  const copy = sandboxEgressRefusalCopyFor(code, NO_EGRESS_REFUSAL_SUBJECT);
  if (copy === null) return null;
  return {
    headline: copy.headline,
    description: copy.description,
    hostDetail: hostDetailOf(code, message),
  };
}

function copyOf(
  row: SandboxRefusalRow,
  code: string,
  message: string,
): SandboxRefusalCopy {
  return {
    headline: row.headline,
    description: row.description,
    hostDetail: row.showsHostDetail ? hostDetailOf(code, message) : null,
  };
}

/** The host's message without its leading `CODE:`, or `null` when empty. */
function hostDetailOf(code: string, message: string): string | null {
  const prefix = `${code}:`;
  const detail = (
    message.startsWith(prefix) ? message.slice(prefix.length) : message
  ).trim();
  return detail.length > 0 ? detail : null;
}
