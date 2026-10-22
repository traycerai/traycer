import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "@traycer/protocol/config/data-bootstrap-records";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import { withCliScopedFileLock } from "./cli-lock";

/**
 * The `traycer task create --idempotency-key` record: what makes a scheduled
 * create that runs twice, or is retried, start one Task.
 *
 * The host cannot be the dedupe. Each run mints its own ids and timestamps,
 * so two runs are two different requests to it, and its key cache is
 * per-process and lasts ten minutes. This record lasts 24 hours and outlives
 * a host restart.
 *
 * A run holds the key's file lock from the read to the last write, and
 * writes `intent` (the ids it is about to send) BEFORE the request goes out,
 * as a durable atomic write. `intent` with no `done` therefore means a create
 * may exist, and a later run with the key refuses rather than create a second
 * Task. `done` is a create the host confirmed. The caller removes `intent`
 * only for a failure that proves nothing was created.
 */

/** How long a record answers for its key. Deleting the file clears it sooner. */
export const TASK_CREATE_KEY_TTL_MS = 24 * 60 * 60 * 1000;

const LOCK_POLL_INTERVAL_MS = 50;

const taskCreateKeyRecordSchema = z.object({
  state: z.enum(["intent", "done"]),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  /** Of the person's inputs, never of the ids or timestamps a run mints. */
  fingerprint: z.string().min(1),
  writtenAt: z.number(),
});
export type TaskCreateKeyRecord = z.infer<typeof taskCreateKeyRecordSchema>;

export type TaskCreateKeyRead =
  | { readonly kind: "absent" }
  | { readonly kind: "expired" }
  | { readonly kind: "damaged" }
  | { readonly kind: "intent"; readonly record: TaskCreateKeyRecord }
  | { readonly kind: "done"; readonly record: TaskCreateKeyRecord };

/**
 * One file per signed-in person and key. Named by a hash so the file name
 * carries neither the account id nor a key a script may have built from
 * something private.
 */
export function taskCreateKeyRecordPath(
  dir: string,
  userId: string,
  key: string,
): string {
  const name = createHash("sha256")
    .update(userId)
    .update("\0")
    .update(key)
    .digest("hex");
  return join(dir, `${name}.json`);
}

/**
 * Runs `fn` holding the key's lock. A run still waiting when `waitMs` ends
 * has done nothing, which is what its error says.
 */
export async function withTaskCreateKeyLock<T>(
  recordPath: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  const outcome = await withCliScopedFileLock(
    {
      lockPath: `${recordPath}.lock`,
      reason: "task create",
      waitMs,
      pollIntervalMs: LOCK_POLL_INTERVAL_MS,
    },
    fn,
  );
  if (outcome.kind === "busy") {
    throw cliError({
      code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
      message:
        "traycer: another run with this --idempotency-key is still creating its Task. This run created nothing; run it again to read that run's result.",
      details: null,
      exitCode: 75, // EX_TEMPFAIL - caller may retry
    });
  }
  return outcome.result;
}

export async function readTaskCreateKey(
  recordPath: string,
  now: number,
): Promise<TaskCreateKeyRead> {
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "damaged" };
  }
  const record = taskCreateKeyRecordSchema.safeParse(parsed);
  if (!record.success) return { kind: "damaged" };
  if (now - record.data.writtenAt > TASK_CREATE_KEY_TTL_MS) {
    return { kind: "expired" };
  }
  return record.data.state === "intent"
    ? { kind: "intent", record: record.data }
    : { kind: "done", record: record.data };
}

/** Durable: on disk, with the rename flushed, when this resolves. */
export async function writeTaskCreateKey(
  recordPath: string,
  record: TaskCreateKeyRecord,
): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(recordPath, JSON.stringify(record));
}

export async function clearTaskCreateKey(recordPath: string): Promise<void> {
  await rm(recordPath, { force: true });
}
