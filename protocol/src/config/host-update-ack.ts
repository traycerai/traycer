import { join } from "node:path";

/**
 * The dispatch ACK: "the child this dispatch spawned made a durable claim, and
 * here is what it claimed."
 *
 * Written by the CLI child immediately AFTER its claim is durable, and read by
 * the host resolver that spawned it, to answer `host.update.install` with a
 * real `attemptId` instead of a null one (Ticket 07 §5.2.8).
 *
 * ## Why a SIBLING FILE and not a field on the attempt record
 *
 * The obvious home for a nonce is the attempt record itself, and it is closed
 * — but not for the reason one would guess. Nothing in the attempt-record path
 * is strict (readers pick named fields, so an unknown one would survive a
 * read). The closure is the WRITE: every record write is a closed validated
 * round-trip that serializes the DERIVED record against a fixed field
 * whitelist, so a nonce smuggled into `update-attempt.json` would be silently
 * ERASED by the next legitimate transition write. Silently, and at a moment
 * nobody is looking.
 *
 * Making it first-class instead would mean touching the certified record type,
 * its field parser, its equality check and the transition algebra — for a value
 * that is pure ACK correlation and has no place in the attempt's own semantics.
 * A sibling file keeps the correlation out of the record entirely.
 *
 * ## Why it lives in `@traycer/protocol/config`
 *
 * Same reason as `./host-stop-intent` and `./host-update-attempt-paths`: two
 * processes in TWO repositories must resolve the exact same file and agree on
 * the exact same bytes, and `traycer-host` cannot import the CLI package.
 * ONE definition, imported by both — deliberately not the mirrored-by-contract
 * arrangement the legacy `update-progress.json` marker uses, whose two
 * independent derivations of one path is a divergence this ticket had to pin.
 *
 * ## The nonce is what makes a stale file harmless
 *
 * The filename is FIXED, so a previous dispatch's ACK can still be sitting
 * there. That is safe by construction rather than by cleanup: the resolver
 * accepts an ACK only when its nonce equals the one THIS dispatch generated,
 * and a nonce is minted per dispatch. A leftover file therefore reads as "not
 * mine" and the wait runs to its deadline, which is the correct answer — the
 * child this call spawned has not claimed anything.
 */

const UPDATE_DISPATCH_ACK_FILENAME = "update-dispatch-ack.json";

/**
 * The ACK's path, given the host runtime home that contains it.
 *
 * Parameterized by the directory for the same reason as its siblings: the CLI
 * resolves the host home through `hostHomeDir(environment)` (dev-run slot
 * nesting included) while the host resolves its own `--host-data-dir`. Those
 * always name the same directory for the same host, so taking it as input
 * makes the agreement structural instead of a slot rule copied into a third
 * place that can drift.
 */
export function updateDispatchAckPath(hostHomeDir: string): string {
  return join(hostHomeDir, UPDATE_DISPATCH_ACK_FILENAME);
}

export const UPDATE_DISPATCH_ACK_VERSION = 1;

/**
 * What the child attests.
 *
 * Only facts the durable claim established. There is deliberately no phase, no
 * progress and no outcome: this record answers "did the child I spawned claim,
 * and which attempt is it", and nothing else. Anything further would be a
 * second, unsynchronised copy of state the attempt record already owns.
 */
export interface UpdateDispatchAck {
  readonly v: typeof UPDATE_DISPATCH_ACK_VERSION;
  /** Correlates this ACK with ONE dispatch. See the staleness note above. */
  readonly nonce: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  /** ISO instant of the claim, for diagnostics only — never for ordering. */
  readonly claimedAt: string;
}

export type DecodedUpdateDispatchAck =
  | { readonly kind: "valid"; readonly ack: UpdateDispatchAck }
  /**
   * Present but unusable. Deliberately distinct from absent: a corrupt ACK
   * means a child wrote something we cannot read, which is a different fact
   * from a child that has not written yet, and the resolver reports it with
   * its own reason rather than waiting out the deadline on it.
   */
  | { readonly kind: "invalid"; readonly reason: UpdateDispatchAckDefect };

export type UpdateDispatchAckDefect =
  | "unparseable-json"
  | "unsupported-version"
  | "malformed-fields";

/**
 * Nonces this contract will accept, on argv and in the file.
 *
 * A closed character class rather than a length check, because this value is
 * passed on a command line: restricting it to hex-ish token characters means
 * no quoting rule, shell metacharacter, or path separator can ever be part of
 * a legal nonce. It is NOT used to build the path (the filename is fixed), so
 * this is defence in depth rather than traversal protection — but the cheapest
 * moment to refuse a hostile value is before it is written anywhere.
 */
const ACK_NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidUpdateDispatchAckNonce(value: string): boolean {
  return ACK_NONCE_PATTERN.test(value);
}

/**
 * Decode ACK bytes. Total: every malformed input maps to a named defect rather
 * than throwing, because the caller is a bounded wait that must keep its own
 * deadline rather than unwind.
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
  // Version first: a future version is not malformed, it is a shape this build
  // has no business interpreting, and saying so is more useful than reporting
  // whichever field happens to differ.
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
