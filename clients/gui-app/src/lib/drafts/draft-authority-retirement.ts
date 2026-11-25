import { persistKey } from "@/lib/persist/keys";
import { mintDraftId } from "./draft-ids";
import { z } from "zod";
import { runDraftAuthorityTransaction } from "./draft-authority-db";
import { draftAuthorityActorIsCurrent } from "./draft-authority-session";
import type { DraftAuthorityActor } from "./draft-authority-types";

const retirementSchema = z.object({
  accountId: z.string(),
  hostId: z.string(),
  draftId: z.string(),
  kind: z.enum(["delete", "retract"]),
  operationId: z.string(),
  state: z.enum(["pending", "retired"]),
});

export type DraftAuthorityRetirement = z.infer<typeof retirementSchema>;

function keyFor(retirement: DraftAuthorityRetirement): IDBValidKey {
  return ["host", retirement.accountId, retirement.hostId, retirement.draftId, retirement.kind];
}

export async function listDraftAuthorityRetirements(
  actor: DraftAuthorityActor,
  hostId: string,
): Promise<readonly DraftAuthorityRetirement[] | null> {
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  const result = await runDraftAuthorityTransaction(
    ["retirements"],
    "readonly",
    async ({ retirements }) => {
      const rows = await retirements.readAll(
        IDBKeyRange.bound(["host", actor.accountId, hostId], ["host", actor.accountId, hostId, []]),
      );
      return rows.flatMap((row) => {
        const parsed = retirementSchema.safeParse(row);
        return parsed.success && parsed.data.accountId === actor.accountId &&
          parsed.data.hostId === hostId ? [parsed.data] : [];
      });
    },
  );
  return result.kind === "complete" && draftAuthorityActorIsCurrent(actor)
    ? result.value
    : null;
}

export async function settleDraftAuthorityRetirement(
  actor: DraftAuthorityActor,
  retirement: DraftAuthorityRetirement,
): Promise<void> {
  if (actor.accountId !== retirement.accountId) return;
  await runDraftAuthorityTransaction(
    ["retirements"],
    "readwrite",
    async ({ retirements }) => {
      const key = keyFor(retirement);
      const current = retirementSchema.safeParse(await retirements.read(key));
      if (!current.success || !draftAuthorityActorIsCurrent(actor) ||
        current.data.operationId !== retirement.operationId ||
        current.data.accountId !== actor.accountId ||
        current.data.state !== "pending") {
        return;
      }
      await retirements.write(key, { ...current.data, state: "retired" });
    },
  );
}

const RETIREMENT_CHANGE = persistKey("draft-authority-retirement-changed");
const changeSchema = z.object({ accountId: z.string(), hostId: z.string() });
type RetirementListener = (accountId: string, hostId: string) => void;
const listeners = new Set<RetirementListener>();

function emit(accountId: string, hostId: string): void {
  for (const listener of listeners) queueMicrotask(() => listener(accountId, hostId));
}

function readChange(event: StorageEvent): void {
  if (event.key !== RETIREMENT_CHANGE || event.newValue === null) return;
  try {
    const change = changeSchema.parse(JSON.parse(event.newValue));
    emit(change.accountId, change.hostId);
  } catch {
    // A later session reads its authority receipts on startup.
  }
}

export function subscribeToDraftAuthorityRetirements(
  listener: RetirementListener,
): () => void {
  if (listeners.size === 0) globalThis.window?.addEventListener("storage", readChange);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.window?.removeEventListener("storage", readChange);
  };
}

export function notifyDraftAuthorityRetirement(accountId: string, hostId: string): void {
  try {
    globalThis.localStorage?.setItem(
      RETIREMENT_CHANGE,
      JSON.stringify({ accountId, hostId, notificationId: mintDraftId() }),
    );
  } catch {
    // A failed notification leaves the receipt pending for the next connection.
  }
  emit(accountId, hostId);
}

export async function draftAuthorityHostIdIsRetired(
  actor: DraftAuthorityActor,
  draftId: string,
): Promise<boolean> {
  if (!draftAuthorityActorIsCurrent(actor)) return true;
  const outcome = await runDraftAuthorityTransaction(
    ["retirements"],
    "readonly",
    async ({ retirements }) =>
      typeof (await retirements.read(["draft-id", actor.accountId, draftId])) === "string",
  );
  return outcome.kind !== "complete" ||
    !draftAuthorityActorIsCurrent(actor) ||
    outcome.value;
}
