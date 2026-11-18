import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../app/logger";
import type { HostFsLayout } from "./host-paths";

/**
 * Why the CLI parked a launch apply: this account cannot start the service
 * the apply would stop. `disabled` - the host's Scheduled Task switched off in
 * Task Scheduler by its owner (`E_SERVICE_REGISTRATION_DISABLED`); `not-owned`
 * - the task is another Windows user's while a host started through it runs
 * (`E_SERVICE_TASK_NOT_OWNED`, `details.reason: "other-owner"`);
 * `owner-unconfirmed` - the same refusal over a task whose owner the CLI could
 * not confirm (`details.reason: "unconfirmed"`), which is parked the same way
 * and never said to be another user's. All arrive as
 * `HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE`; the code says which.
 */
export type HostUpdateParkReason =
  | "disabled"
  | "not-owned"
  | "owner-unconfirmed";

/**
 * The desktop's memory that the launch apply of ONE stage was parked by the
 * CLI, and why.
 *
 * Without it every launch would spawn a `host apply --respect-hold` that is
 * refused the same way. While it holds for the ready stage, the launch
 * reconcile skips that apply - no spawn - and the update-ready row shows the
 * notice for `reason` from this record (`HostControllerStatus.updateDeferral`):
 * with the enable action for a disabled task, and without one for another
 * user's, which nothing in this app can change.
 *
 * It stops holding when:
 *   - a DIFFERENT stage is ready: it is keyed on the stage fingerprint, so a
 *     new stage gets its own launch apply, which asks the CLI afresh;
 *   - this app registers the background service (`registerService`: Doctor's
 *     Register service, the update row's enable action), the one repair that
 *     turns a disabled task back on;
 *   - `HOST_UPDATE_PARK_LATCH_TTL_MS` has passed since it was set: an enable
 *     done outside this app (in Task Scheduler), or the other user's task
 *     going away, is invisible here without a spawn, so the first launch a day
 *     or more later asks again.
 *
 * Desktop state, not the CLI's: it lives beside the install record in the
 * host root, holds a fingerprint, a reason and a time and nothing else - no
 * account - and no other process reads it.
 */
export interface HostUpdateParkLatch {
  readonly stageFingerprint: string;
  readonly reason: HostUpdateParkReason;
  readonly latchedAtMs: number;
}

/** A day: the longest a change made outside this app waits for a launch apply. */
export const HOST_UPDATE_PARK_LATCH_TTL_MS = 24 * 60 * 60 * 1000;

const LATCH_FILE = "desktop-update-park-latch.json";

function latchPath(layout: HostFsLayout): string {
  return join(layout.rootDir, LATCH_FILE);
}

/**
 * The latch when it still stands for the stage `stageFingerprint` names at
 * `nowMs`, else `null`.
 */
export function standingHostUpdateParkLatch(
  latch: HostUpdateParkLatch | null,
  stageFingerprint: string | null,
  nowMs: number,
): HostUpdateParkLatch | null {
  if (latch === null || stageFingerprint === null) return null;
  if (latch.stageFingerprint !== stageFingerprint) return null;
  // A clock that moved backwards past the latch reads as expired rather than
  // as a latch that never ends.
  const ageMs = nowMs - latch.latchedAtMs;
  return ageMs >= 0 && ageMs < HOST_UPDATE_PARK_LATCH_TTL_MS ? latch : null;
}

/** The latch on disk, or `null` when absent or unreadable (no latch: ask the CLI). */
export async function readHostUpdateParkLatch(
  layout: HostFsLayout,
): Promise<HostUpdateParkLatch | null> {
  let text: string;
  try {
    text = await readFile(latchPath(layout), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const stageFingerprint: unknown = Reflect.get(parsed, "stageFingerprint");
  const reason: unknown = Reflect.get(parsed, "reason");
  const latchedAtMs: unknown = Reflect.get(parsed, "latchedAtMs");
  if (
    typeof stageFingerprint !== "string" ||
    stageFingerprint.length === 0 ||
    (reason !== "disabled" &&
      reason !== "not-owned" &&
      reason !== "owner-unconfirmed") ||
    typeof latchedAtMs !== "number" ||
    !Number.isFinite(latchedAtMs)
  ) {
    return null;
  }
  return { stageFingerprint, reason, latchedAtMs };
}

/**
 * Best-effort: a latch that failed to write costs one more refused spawn on
 * the next launch, never a wrong apply, so a write failure is logged and
 * swallowed.
 */
export async function writeHostUpdateParkLatch(
  layout: HostFsLayout,
  latch: HostUpdateParkLatch,
): Promise<void> {
  const path = latchPath(layout);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(latch)}\n`, "utf8");
  } catch (err) {
    log.warn("[host-controller] could not record the parked-update latch", {
      err,
    });
  }
}

/** Best-effort, like the write: a latch left behind still expires. */
export async function clearHostUpdateParkLatch(
  layout: HostFsLayout,
): Promise<void> {
  try {
    await rm(latchPath(layout), { force: true });
  } catch (err) {
    log.warn("[host-controller] could not clear the parked-update latch", {
      err,
    });
  }
}
