import { join } from "node:path";

/**
 * The dispatch ACK: "the child this dispatch spawned made a durable claim, and here is what it claimed."
 * Same reason as `./host-stop-intent` and `./host-update-attempt-paths`: two processes in TWO repositories must resolve the exact same file and agree on the exact same bytes, and `traycer-host` cannot import the CLI.
 */

const UPDATE_DISPATCH_ACK_FILENAME = "update-dispatch-ack.json";

/** The ACK's path, given the host runtime home that contains it. */
export function updateDispatchAckPath(hostHomeDir: string): string {
  return join(hostHomeDir, UPDATE_DISPATCH_ACK_FILENAME);
}

export const UPDATE_DISPATCH_ACK_VERSION = 1;

/** What the child attests. */
export interface UpdateDispatchAck {
  readonly v: typeof UPDATE_DISPATCH_ACK_VERSION;
  /** Correlates this ACK with ONE dispatch. See the staleness note above. */
  readonly nonce: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  /** ISO instant of the claim, for diagnostics only - never for ordering. */
  readonly claimedAt: string;
}

export type DecodedUpdateDispatchAck =
  | { readonly kind: "valid"; readonly ack: UpdateDispatchAck }
  /** Present but unusable. */
  | { readonly kind: "invalid"; readonly reason: UpdateDispatchAckDefect };

export type UpdateDispatchAckDefect =
  | "unparseable-json"
  | "unsupported-version"
  | "malformed-fields";

/** Nonces this contract will accept, on argv and in the file. */
const ACK_NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidUpdateDispatchAckNonce(value: string): boolean {
  return ACK_NONCE_PATTERN.test(value);
}

/**
 * Decode ACK bytes.
 * Total: every malformed input maps to a named defect rather than throwing, because the caller is a bounded wait that must keep its own deadline rather than unwind.
 */
export function decodeUpdateDispatchAck(
  text: string,
): DecodedUpdateDispatchAck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "unparseable-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "malformed-fields" };
  }
  const raw: Record<string, unknown> = { ...parsed };
  if (raw.v !== UPDATE_DISPATCH_ACK_VERSION) {
    return { kind: "invalid", reason: "unsupported-version" };
  }
  const { nonce, attemptId, generation, sequence, claimedAt } = raw;
  if (
    typeof nonce !== "string" ||
    !isValidUpdateDispatchAckNonce(nonce) ||
    typeof attemptId !== "string" ||
    attemptId.length === 0 ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    typeof claimedAt !== "string" ||
    claimedAt.length === 0
  ) {
    return { kind: "invalid", reason: "malformed-fields" };
  }
  return {
    kind: "valid",
    ack: {
      v: UPDATE_DISPATCH_ACK_VERSION,
      nonce,
      attemptId,
      generation,
      sequence,
      claimedAt,
    },
  };
}
