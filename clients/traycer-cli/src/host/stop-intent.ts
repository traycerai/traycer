import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import {
  isStopIntentWithin,
  parseStopIntent,
  type StopIntent,
  type StopIntentReason,
} from "@traycer/protocol/config/host-stop-intent";
import { writeJsonAtomically } from "./lifecycle-probe";
import { hostStopIntentPath } from "../store/paths";
import type { Environment } from "../runner/environment";

// Host reads this file at SIGTERM to tell a deliberate restart from death. Path is CLI-owned; no RPC leg.
export type { StopIntent, StopIntentReason };

/** File, not in-process: win32 `schtasks /End` orphans the supervisor. Expires so a half-finished stop cannot wedge never-relaunch. */
export const STOP_INTENT_STALE_MS = 300_000;

/** Write before any kill. Never throws; on win32 a failed write still runs `/End` and the orphaned supervisor relaunches. */
export async function writeStopIntent(
  environment: Environment | undefined,
  reason: StopIntentReason,
): Promise<boolean> {
  const intent: StopIntent = {
    v: 1,
    requestedAt: new Date().toISOString(),
    requestedByPid: process.pid,
    reason,
  };
  try {
    await writeJsonAtomically(hostStopIntentPath(environment), intent);
    return true;
  } catch {
    // Caller decides what an unrecorded intent means (platform-dependent; see `withStopIntent`).
    return false;
  }
}

/** Drop served intent on a successful start so it cannot suppress the next crash's recovery. */
export async function clearStopIntent(
  environment: Environment | undefined,
): Promise<void> {
  try {
    await rm(hostStopIntentPath(environment), { force: true });
  } catch {
    // Best effort: a stale intent expires on its own.
  }
}

/** Record identity independent of clock: `requestedAt` plus writing pid. */
export interface StopIntentIdentity {
  readonly requestedAt: string;
  readonly requestedByPid: number;
}

export function stopIntentIdentity(intent: StopIntent): StopIntentIdentity {
  return {
    requestedAt: intent.requestedAt,
    requestedByPid: intent.requestedByPid,
  };
}

/** Null identity matches nothing, so a later record is unanswered. */
export function isSameStopIntent(
  intent: StopIntent,
  identity: StopIntentIdentity | null,
): boolean {
  if (identity === null) return false;
  return (
    intent.requestedAt === identity.requestedAt &&
    intent.requestedByPid === identity.requestedByPid
  );
}

export async function readStopIntentIdentity(
  environment: Environment | undefined,
): Promise<StopIntentIdentity | null> {
  const intent = await readStopIntent(environment);
  return intent === null ? null : stopIntentIdentity(intent);
}

/** `null` when absent, unreadable, or not a well-formed intent record. */
export async function readStopIntent(
  environment: Environment | undefined,
): Promise<StopIntent | null> {
  let text: string;
  try {
    text = await readFile(hostStopIntentPath(environment), "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseStopIntent(raw);
}

/** Torn file reads as no intent. Remember `servedAtStartup` rather than deleting or comparing clocks: a stop between invoke and clear would be erased, and RTC steps mis-serve both ways. */
export async function hasActionableStopIntent(
  environment: Environment | undefined,
  nowMs: number,
  servedAtStartup: StopIntentIdentity | null,
): Promise<boolean> {
  const intent = await readStopIntent(environment);
  if (intent === null) return false;
  if (!isStopIntentFresh(intent, nowMs)) return false;
  return !isSameStopIntent(intent, servedAtStartup);
}

/** Symmetric window bound to `STOP_INTENT_STALE_MS`. Host uses a tighter window for the SIGTERM gap only. */
export function isStopIntentFresh(intent: StopIntent, nowMs: number): boolean {
  return isStopIntentWithin(intent, nowMs, STOP_INTENT_STALE_MS);
}
