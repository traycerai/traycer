import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { UpdateMutationCapabilityAdoption } from "./index";

// Parent-to-child transport for an update-attempt adoption proof (Ticket 05,
// Ruling 1).
//
// ## Why this is shared rather than CLI-local
//
// The two halves have different owners. Desktop MINTS - it is the packaged-macOS
// executor that holds the attempt lock and spawns bundled-CLI children inside its
// segment. The CLI CONSUMES - those children validate the parent's proof instead
// of contending for a lock the parent already holds.
//
// Desktop cannot import from the CLI package (Desktop bundles the CLI *binary*,
// not its source), so a CLI-local transport leaves the minting half unreachable
// by the only actor that mints. Duplicating it into Desktop would put two
// implementations of one security-relevant on-disk protocol in a repo whose rule
// is not to duplicate - and this is exactly the protocol where the two copies
// drifting apart would be silent.
//
// Modelled on `host-start-adoption.ts`, and for the same reasons: the proof is
// nonce-named rather than fixed-path so two concurrent segments cannot read
// each other's, user-private so no other account can consume one, and
// age-bounded so a proof left behind by a crashed parent stops being usable
// long before the pid it names could be recycled.
//
// ## Why the nonce travels on argv and the proof does not
//
// The proof carries the parent's lock token. Argv is world-readable through
// `ps`, so putting the token there would publish the exact value that
// `validateUpdateMutationCapabilityAdoption` compares against. The child gets
// an opaque nonce and reads the proof from a 0600 file in the host home it is
// already privileged to read.
//
// The token is not itself an authority - possessing it grants nothing, because
// the shared verifier also requires the named holder to be a LIVE process, and
// the lock file already exists so it cannot be acquired by presenting one. It
// is still not something to broadcast.

const ADOPTION_FILE_PREFIX = ".update-attempt-adoption";
/**
 * Deliberately the same bound as `HOST_START_ADOPTION_MAX_AGE_MS`. A proof
 * only has to survive a spawn, and a short window is what stops a crashed
 * parent's leftover file from being consumable against a recycled pid later.
 */
export const UPDATE_ADOPTION_MAX_AGE_MS = 60_000;

// ## What an adoption proof DOES and DOES NOT waive
//
// **It waives the ATTEMPT lock only. The cli-lock is always the child's own.**
//
// This is worth stating at the transport rather than leaving to the reader,
// because the name `withUpdateContenderAdoption` invites the broader reading -
// and acting on that reading produces a deadlock, not a type error.
// `withCliUpdateContender` wraps its adoption-aware segment in
// `withCliAttemptMutation`, which takes `withCliLock` whether or not a proof
// was presented.
//
// That asymmetry is correct: the cli-lock serializes install-tree mutation
// against a mixed-version CLI that knows nothing about attempts, so inheriting
// it from a parent would defeat the thing it exists to do. The consequence for
// callers is concrete: **a parent holding the cli-lock across a child spawn
// blocks its own child**, even a fully adopted one. A minting parent must
// release the inner lock before it spawns.

export interface PublishedUpdateAdoption {
  readonly nonce: string;
  /** Removes the proof. Safe to call twice; a consumed proof is already gone. */
  cancel(): Promise<void>;
}

interface AdoptionFile {
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly adoption: UpdateMutationCapabilityAdoption;
}

/**
 * A nonce is an OPAQUE NAME, never a path fragment.
 *
 * It arrives from `--attempt-adoption`, which accepts any nonempty string, and
 * it used to be interpolated straight into a filename. `join` then normalized
 * the `..` segments away, so `../../../victim` addressed a real file outside
 * the host home - which consume opened AND removed before validating anything.
 * The damage landed before the proof was ever rejected.
 *
 * Restricting the alphabet is what makes the path safe, and it is checked
 * BEFORE any filesystem call rather than after. `randomUUID()` - the only
 * thing that legitimately produces these - matches trivially.
 */
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function adoptionPath(hostHomeDir: string, nonce: string): string | null {
  if (!NONCE_PATTERN.test(nonce)) return null;
  const home = resolve(hostHomeDir);
  const path = join(home, `${ADOPTION_FILE_PREFIX}.${nonce}.json`);
  // Belt and braces: even a pattern-passing nonce must resolve to a direct
  // child of the host home. A future edit to the alphabet cannot widen the
  // blast radius past this check.
  return dirname(path) === home ? path : null;
}

/**
 * Write an already-minted proof to disk under a fresh nonce.
 *
 * It takes the adoption as DATA rather than minting it here, and that split is
 * deliberate on two counts:
 *
 *  - **Gate shape.** Minting means calling
 *    `createUpdateMutationCapabilityAdoption`, which lives in `contender.ts` -
 *    a module whose importers are deliberately pinned to two. Keeping the call
 *    at the caller means this transport never references that module, so it
 *    needs no third trusted-importer entry. The alternative was widening a gate
 *    to accommodate a file that only wanted a filesystem.
 *  - **No import cycle.** This module is re-exported by the barrel, so a
 *    runtime import back from it would be circular. Only the TYPE is imported
 *    here, which erases at compile time.
 *
 * The safety property is unchanged and still enforced where it belongs:
 * `createUpdateMutationCapabilityAdoption` throws unless the capability is live
 * and still owns the lock on disk, so the caller cannot hand this function a
 * proof minted from a released or forged capability.
 */
export async function writeAdoptionProof(
  adoption: UpdateMutationCapabilityAdoption,
  hostHomeDir: string,
  nowMs: number,
): Promise<PublishedUpdateAdoption> {
  const nonce = randomUUID();
  const path = adoptionPath(hostHomeDir, nonce);
  // Unreachable for a `randomUUID`, but the type says it can be null and a
  // silent `join` on a bad name is the F8 bug all over again.
  if (path === null) throw new Error("adoption nonce is not a bare filename");
  const file: AdoptionFile = { nonce, issuedAtMs: nowMs, adoption };
  // `O_EXCL` so a nonce collision is a hard failure rather than a silent
  // overwrite of somebody else's live proof.
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let failure: unknown = null;
  let failed = false;
  try {
    await handle.writeFile(JSON.stringify(file), "utf8");
    await handle.sync();
  } catch (err) {
    failure = err;
    failed = true;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (failed) {
    // The caller CANNOT clean this up: we reject before returning the handle
    // that carries `cancel`, so the nonce is never handed out. Without this
    // the partial proof would accumulate forever - inert once the holder
    // releases, but never deleted, because the age bound only applies to a
    // nonce somebody knows to look for. The unlink runs AFTER `close()` so
    // it also works on Windows, where removing an open file fails — and that
    // rm swallowing its own error was exactly how the leak survived there.
    await rm(path, { force: true }).catch(() => undefined);
    throw failure;
  }
  return {
    nonce,
    cancel: async (): Promise<void> => {
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

export type ConsumedUpdateAdoption =
  | {
      readonly kind: "adopted";
      readonly adoption: UpdateMutationCapabilityAdoption;
    }
  /** No proof, an expired one, or one this process cannot trust. */
  | { readonly kind: "absent"; readonly cause: string };

/**
 * Read and consume the proof named by `nonce`.
 *
 * Total: every failure - missing, unreadable, malformed, expired, or naming a
 * different host home - resolves to `absent`, and every `absent` makes the
 * caller fall back to ordinary acquisition. That fallback is what keeps a
 * solo invocation of these commands byte-identical to today: absent proof,
 * absent adoption, same acquire-or-refuse path.
 *
 * Consumed on read, so a proof cannot be replayed by a second child.
 */
export async function consumeUpdateAttemptAdoption(
  hostHomeDir: string,
  nonce: string,
  nowMs: number,
): Promise<ConsumedUpdateAdoption> {
  const path = adoptionPath(hostHomeDir, nonce);
  // A nonce that is not a bare filename never reaches the filesystem at all.
  if (path === null) return { kind: "absent", cause: "malformed-nonce" };

  // ---- Atomically CLAIM the proof, then read the claim. ----
  //
  // Read-then-remove was not one-shot. Several children could open the same
  // proof before any of them unlinked it, and all would then validate against
  // the same still-live parent - one proof authorizing N children. The
  // reviewer measured it: 32 parallel consumers, 8 accepted by the real
  // validator.
  //
  // `rename` is atomic and single-winner on POSIX: exactly one caller moves
  // the proof out of the shared name, every other caller gets ENOENT. Claiming
  // BEFORE reading is what makes consumption one-shot, and it also fixes the
  // swallowed-`rm` half of the finding - once the rename succeeds the shared
  // nonce is gone, so a later cleanup failure can no longer enable a replay.
  const claimPath = `${path}.claimed.${randomUUID()}`;
  try {
    await rename(path, claimPath);
  } catch {
    return { kind: "absent", cause: "unreadable" };
  }

  let text: string;
  try {
    const handle = await open(claimPath, constants.O_RDONLY);
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: "absent", cause: "unreadable" };
  } finally {
    // The claim is private to this caller, so removing it cannot race anyone.
    // A failure here leaks a file but CANNOT authorize a second child.
    await rm(claimPath, { force: true }).catch(() => undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "absent", cause: "malformed" };
  }
  const file = decodeAdoptionFile(parsed);
  if (file === null) return { kind: "absent", cause: "malformed" };
  if (file.nonce !== nonce) return { kind: "absent", cause: "nonce-mismatch" };
  // Symmetric, like the host-start adoption expiry: a proof more than the
  // grant window away from now IN EITHER DIRECTION is not a grant anyone can
  // still use. A signed check never fires for a future-dated `issuedAtMs`
  // (backward clock step, corrupted stamp), which would honor a stale proof
  // until the wall clock caught up with it.
  if (Math.abs(nowMs - file.issuedAtMs) > UPDATE_ADOPTION_MAX_AGE_MS) {
    return { kind: "absent", cause: "expired" };
  }
  if (resolve(file.adoption.hostHomeDir) !== resolve(hostHomeDir)) {
    return { kind: "absent", cause: "wrong-host-home" };
  }
  return { kind: "adopted", adoption: file.adoption };
}

function decodeAdoptionFile(value: unknown): AdoptionFile | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nonce !== "string" || raw.nonce.length === 0) return null;
  if (typeof raw.issuedAtMs !== "number" || !Number.isFinite(raw.issuedAtMs)) {
    return null;
  }
  const adoption = raw.adoption;
  if (adoption === null || typeof adoption !== "object") return null;
  const candidate = adoption as Record<string, unknown>;
  if (
    typeof candidate.hostHomeDir !== "string" ||
    candidate.holder === null ||
    typeof candidate.holder !== "object"
  ) {
    return null;
  }
  // The holder's fields are re-compared against the live lock by the shared
  // validator, so this decode only has to prove the shape is present - it is
  // deliberately not a second source of truth for what makes a holder valid.
  return {
    nonce: raw.nonce,
    issuedAtMs: raw.issuedAtMs,
    adoption: adoption as UpdateMutationCapabilityAdoption,
  };
}

/**
 * Resolve a `--attempt-adoption <nonce>` flag into a proof, or `undefined`.
 *
 * `undefined` is the ordinary case and the safe one: no flag, an expired or
 * malformed proof, a nonce that names nothing. Every one of them falls back to
 * ordinary acquisition, which is what keeps a solo invocation of these commands
 * byte-identical to its behaviour before adoption existed.
 *
 * It deliberately does NOT fail the command when a proof is unusable. A child
 * spawned with a stale nonce is not a security event - it simply contends for
 * the lock like any other caller, and either wins it or reports the same busy
 * refusal it always would.
 */
export async function resolveAttemptAdoptionFromNonce(
  hostHomeDir: string,
  nonce: string | null,
  nowMs: number,
): Promise<UpdateMutationCapabilityAdoption | undefined> {
  if (nonce === null || nonce.length === 0) return undefined;
  const consumed = await consumeUpdateAttemptAdoption(
    hostHomeDir,
    nonce,
    nowMs,
  );
  return consumed.kind === "adopted" ? consumed.adoption : undefined;
}
