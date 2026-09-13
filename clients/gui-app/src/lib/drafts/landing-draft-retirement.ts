import { z } from "zod";
import { persistKey, scopedPersistKey, STORE_KEYS } from "@/lib/persist";
import { appLogger, describeLogError } from "@/lib/logger";

const retirementSchema = z.object({
  hostId: z.string().nullable(),
  pendingDelete: z.boolean(),
  ownerResolved: z.boolean(),
});

interface LandingDraftRetirement {
  readonly hostId: string | null;
  readonly pendingDelete: boolean;
  readonly ownerResolved: boolean;
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

export function pendingLandingDraftDeleteIdsForHost(hostId: string): string[] {
  return retiredIds().filter(
    (draftId) => pendingLandingDraftDeleteHostId(draftId) === hostId,
  );
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
