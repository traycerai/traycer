import { join } from "node:path";

/**
 * The stop-intent record: "someone is deliberately stopping this host".
 * A second writer would reintroduce exactly that race from a process that cannot even see the supervisor.
 */

const HOST_STOP_INTENT_FILENAME = "stop-intent.json";

/** The record's path, given the host runtime home that contains it. */
export function hostStopIntentPath(hostHomeDir: string): string {
  return join(hostHomeDir, HOST_STOP_INTENT_FILENAME);
}

/** Why the host stops, as stated by whoever is stopping it. */
export type StopIntentReason =
  | "stop"
  | "restart"
  | "install-swap"
  | "uninstall";

export interface StopIntent {
  readonly v: 1;
  readonly requestedAt: string;
  readonly requestedByPid: number;
  readonly reason: StopIntentReason;
}

const STOP_INTENT_REASONS: ReadonlySet<string> = new Set<StopIntentReason>([
  "stop",
  "restart",
  "install-swap",
  "uninstall",
]);

/** `null` for anything that is not a well-formed record. */
export function parseStopIntent(value: unknown): StopIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.requestedAt !== "string") return null;
  if (typeof record.requestedByPid !== "number") return null;
  if (typeof record.reason !== "string") return null;
  if (!STOP_INTENT_REASONS.has(record.reason)) return null;
  return {
    v: 1,
    requestedAt: record.requestedAt,
    requestedByPid: record.requestedByPid,
    reason: record.reason as StopIntentReason,
  };
}

/**
 * Whether `intent` was recorded within `windowMs` of `nowMs` - a SYMMETRIC window, `windowMs` either side.
 */
export function isStopIntentWithin(
  intent: StopIntent,
  nowMs: number,
  windowMs: number,
): boolean {
  const requestedAtMs = Date.parse(intent.requestedAt);
  if (Number.isNaN(requestedAtMs)) return false;
  return Math.abs(nowMs - requestedAtMs) < windowMs;
}
