import { z } from "zod";
import { persistKey, scopedPersistKey, STORE_KEYS } from "@/lib/persist";
import { appLogger, describeLogError } from "@/lib/logger";
import type { PendingHostDelete } from "./draft-mirror-session";

const retirementSchema = z.object({
  hostId: z.string().nullable(),
  pendingDelete: z.boolean(),
  ownerResolved: z.boolean(),
  // A pending request that is a `drafts.retract` of a row `hostId` does not
  // own (a foreign row deleted here), not a `drafts.delete`. Receipts
  // written before the field existed are deletes.
  retract: z.boolean().default(false),
});

interface LandingDraftRetirement {
  readonly hostId: string | null;
  readonly pendingDelete: boolean;
  readonly ownerResolved: boolean;
  readonly retract: boolean;
}

// Desktop disables the landing store's localStorage persistence. Keep its
// retirement receipts separately, one key per ID so windows cannot overwrite
// each other's receipts. A host ACK does not prove a stale cloud head is gone:
// retain the small receipt until the normal GUI-state wipe, without prompt bytes.
const prefix = `${persistKey(STORE_KEYS.landingDraftRetirement)}:`;
const volatileRetirements = new Map<string, LandingDraftRetirement>();

function retirementKey(draftId: string): string {
  return scopedPersistKey(
    STORE_KEYS.landingDraftRetirement,
    encodeURIComponent(draftId),
  );
}

function readRetirement(draftId: string): LandingDraftRetirement | undefined {
  const fallback = volatileRetirements.get(draftId);
  if (fallback !== undefined) return fallback;
  try {
    const raw = window.localStorage.getItem(retirementKey(draftId));
    if (raw === null) return undefined;
    const parsed = retirementSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeRetirement(
  draftId: string,
  retirement: LandingDraftRetirement,
): void {
  try {
    window.localStorage.setItem(
      retirementKey(draftId),
      JSON.stringify(retirement),
    );
    volatileRetirements.delete(draftId);
  } catch (error: unknown) {
    // Storage failure must not reopen the submitted prompt in this renderer.
    volatileRetirements.set(draftId, retirement);
    appLogger.warn("[draft-retirement] could not persist deletion receipt", {
      error: describeLogError(error),
    });
  }
}

function retiredIds(): string[] {
  const ids = new Set(volatileRetirements.keys());
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) {
        ids.add(decodeURIComponent(key.slice(prefix.length)));
      }
    }
  } catch {
    // The in-memory receipts still protect a renderer with storage disabled.
  }
  return [...ids];
}

export function retireLandingDraft(
  draftId: string,
  hostId: string | null,
): void {
  if (readRetirement(draftId) !== undefined) return;
  writeRetirement(draftId, {
    hostId,
    pendingDelete: hostId !== null,
    ownerResolved: hostId !== null,
    retract: false,
  });
}

/**
 * Record that a retired foreign row's cloud entry is to be retracted
 * through `hostId` (the placement host, on the user's authority), so the
 * request is retried by that host's session like a pending delete until
 * the host answers. A receipt already pending a request is left alone.
 */
export function retireLandingDraftForRetract(
  draftId: string,
  hostId: string,
): void {
  const receipt = readRetirement(draftId);
  if (receipt?.pendingDelete === true) return;
  writeRetirement(draftId, {
    hostId,
    pendingDelete: true,
    ownerResolved: true,
    retract: true,
  });
}

export function resolveLandingDraftRetirementOwner(
  draftId: string,
  hostId: string,
): void {
  const receipt = readRetirement(draftId);
  if (receipt === undefined || receipt.ownerResolved) return;
  writeRetirement(draftId, {
    hostId,
    pendingDelete: true,
    ownerResolved: true,
    retract: false,
  });
}

export function isLandingDraftRetirementKey(key: string | null): boolean {
  return key?.startsWith(prefix) === true;
}

export function landingDraftIsRetired(draftId: string): boolean {
  return readRetirement(draftId) !== undefined;
}

export function pendingLandingDraftDeleteHostId(
  draftId: string,
): string | null {
  const receipt = readRetirement(draftId);
  return receipt?.pendingDelete ? receipt.hostId : null;
}

/** Every receipt still pending a request through `hostId`, with its kind. */
export function pendingLandingDraftDeletesForHost(
  hostId: string,
): readonly PendingHostDelete[] {
  const out: PendingHostDelete[] = [];
  for (const draftId of retiredIds()) {
    const receipt = readRetirement(draftId);
    if (receipt?.pendingDelete !== true || receipt.hostId !== hostId) continue;
    out.push({ draftId, retract: receipt.retract });
  }
  return out;
}

export function completeLandingDraftDelete(draftId: string): void {
  const receipt = readRetirement(draftId);
  if (
    receipt === undefined ||
    (!receipt.pendingDelete && receipt.ownerResolved)
  )
    return;
  writeRetirement(draftId, {
    ...receipt,
    pendingDelete: false,
    ownerResolved: true,
  });
}

export function resetLandingDraftRetirementsForTests(): void {
  for (const draftId of retiredIds()) {
    window.localStorage.removeItem(retirementKey(draftId));
  }
  volatileRetirements.clear();
}
