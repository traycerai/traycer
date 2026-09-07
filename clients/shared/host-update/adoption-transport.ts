import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { UpdateMutationCapabilityAdoption } from "./index";

// The two halves have different owners.
// The CLI consumes - those children validate the parent's proof instead of contending for a lock the parent already holds.

const ADOPTION_FILE_PREFIX = ".update-attempt-adoption";
/**
 * Deliberately the same bound as `HOST_START_ADOPTION_MAX_AGE_MS`.
 * A proof only has to survive a spawn, and a short window is what stops a crashed parent's leftover file from being consumable against a recycled pid later.
 */
export const UPDATE_ADOPTION_MAX_AGE_MS = 60_000;

// **It waives the attempt lock only.
// `withCliUpdateContender` wraps its adoption-aware segment in `withCliAttemptMutation`, which takes `withCliLock` whether or not a proof was presented.

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
 * A nonce is an opaque name, never a path fragment.
 * `join` then normalized the `..` segments away, so `../../../victim` addressed a real file outside the host home - which consume opened and removed before validating anything.
 */
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function adoptionPath(hostHomeDir: string, nonce: string): string | null {
  if (!NONCE_PATTERN.test(nonce)) return null;
  const home = resolve(hostHomeDir);
  const path = join(home, `${ADOPTION_FILE_PREFIX}.${nonce}.json`);
  // Belt and braces: even a pattern-passing nonce must resolve to a direct child of the host home.
  // A future edit to the alphabet cannot widen the blast radius past this check.
  return dirname(path) === home ? path : null;
}

/**
 * Write an already-minted proof to disk under a fresh nonce.
 * Keeping the call at the caller means this transport never references that module, so it needs no third trusted-importer entry.
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
    // The caller cannot clean this up: we reject before returning the handle that carries `cancel`, so the nonce is never handed out.
    // Without this the partial proof would accumulate forever - inert once the holder releases, but never deleted, because the age bound only applies to a nonce somebody knows to look for.
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
   * That fallback is what keeps a solo invocation of these commands byte-identical to today: absent proof, absent adoption, same acquire-or-refuse path.
   */
export async function consumeUpdateAttemptAdoption(
  hostHomeDir: string,
  nonce: string,
  nowMs: number,
): Promise<ConsumedUpdateAdoption> {
  const path = adoptionPath(hostHomeDir, nonce);
  // A nonce that is not a bare filename never reaches the filesystem at all.
  if (path === null) return { kind: "absent", cause: "malformed-nonce" };

  // ---- Atomically claim the proof, then read the claim.
  // ---- Read-then-remove was not one-shot.
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
    // A failure here leaks a file but cannot authorize a second child.
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
  // Symmetric, like the host-start adoption expiry: a proof more than the grant window away from now IN either direction is not a grant anyone can still use.
  // A signed check never fires for a future-dated `issuedAtMs` (backward clock step, corrupted stamp), which would honor a stale proof until the wall clock caught up with it.
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
  // The holder's fields are re-compared against the live lock by the shared validator, so this decode only has to prove the shape is present - it is deliberately not a second source of truth for what makes a holder valid.
  return {
    nonce: raw.nonce,
    issuedAtMs: raw.issuedAtMs,
    adoption: adoption as UpdateMutationCapabilityAdoption,
  };
}

/**
 * Resolve a `--attempt-adoption <nonce>` flag into a proof, or `undefined`.
 * Every one of them falls back to ordinary acquisition, which is what keeps a solo invocation of these commands byte-identical to its behaviour before adoption existed.
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
