import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HostUpdateTrigger } from "@traycer-clients/shared/host-update";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";
import type { ILogger } from "../logger";
import { CliError } from "../runner/errors";
import { writeJsonAtomically } from "./lifecycle-probe";

/**
 * What the last `host update` or `host apply` came to, whoever ran it.
 *
 * ## Why this is not `update-attempt.json`
 *
 * That record cannot hold every attempt, and neither gap is an oversight:
 *
 *  - Only the holder of the update lock may write it, and a run refused on the
 *    lock is by definition not the holder. A write from there would replace
 *    the record of the update actually running, and that update's next write
 *    would then fail its held-identity check.
 *  - Desktop's update is `host download` then `host apply`, both on the legacy
 *    route. Moving it onto attempts is the executor cutover, which
 *    `decideDesktopUpdateExecutorCohort` fences off, and a `desktop` trigger
 *    would read as corrupt to every host and CLI already deployed.
 *
 * So the answer to "did my update work" lives here, beside it, with one writer
 * and one reader. It carries no authority: nothing admits or refuses on it, it
 * takes no lock, and the last writer wins, which is what "latest" means. Losing
 * a write costs a stale line in `host status`, so a failed write never fails
 * the run it describes.
 */
const UPDATE_LAST_ATTEMPT_FILENAME = "update-last-attempt.json";

export type HostUpdateAttemptInitiator = HostUpdateTrigger | "desktop";

export type HostUpdateAttemptOutcome =
  /** The target is installed and its host was started. */
  | "complete"
  /** The bytes are installed and this run did not start the host. */
  | "applied"
  | "no-op"
  /** Waiting for the host to go idle, or for a service it cannot start. */
  | "parked"
  /** Stopped before it changed anything. */
  | "refused"
  | "failed";

export interface HostUpdateLastAttempt {
  readonly command: "host update" | "host apply";
  readonly initiator: HostUpdateAttemptInitiator;
  readonly outcome: HostUpdateAttemptOutcome;
  /** `null` when the run stopped before it knew its target. */
  readonly targetVersion: string | null;
  /** The `update-attempt.json` attempt, when the run claimed one. */
  readonly attemptId: string | null;
  /** The CLI error code, when the run ended on one. */
  readonly code: string | null;
  readonly message: string | null;
  readonly recordedAt: string;
}

function lastAttemptPath(hostHome: string): string {
  return join(hostHome, UPDATE_LAST_ATTEMPT_FILENAME);
}

export async function writeHostUpdateLastAttempt(
  hostHome: string,
  attempt: Omit<HostUpdateLastAttempt, "recordedAt">,
  logger: ILogger,
): Promise<void> {
  try {
    await writeJsonAtomically(lastAttemptPath(hostHome), {
      ...attempt,
      recordedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.info("Host update could not record its outcome", {
      outcome: attempt.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The outcome a thrown run reports. `started`: it had reached real work. */
export function outcomeOfThrow(
  err: unknown,
  started: boolean,
): HostUpdateAttemptOutcome {
  if (
    err instanceof CliError &&
    err.exitCode === HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE
  ) {
    return "parked";
  }
  return started ? "failed" : "refused";
}

export function errorFacts(err: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  return err instanceof CliError
    ? { code: err.code, message: err.message }
    : { code: null, message: err instanceof Error ? err.message : String(err) };
}

export async function readHostUpdateLastAttempt(
  hostHome: string,
): Promise<HostUpdateLastAttempt | null> {
  let raw: string;
  try {
    raw = await readFile(lastAttemptPath(hostHome), "utf8");
  } catch {
    return null;
  }
  try {
    return parseLastAttempt(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Removed with the install it describes. */
export async function removeHostUpdateLastAttempt(
  hostHome: string,
): Promise<void> {
  await rm(lastAttemptPath(hostHome), { force: true }).catch(() => undefined);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseLastAttempt(value: unknown): HostUpdateLastAttempt | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { command, initiator, outcome, recordedAt } = record;
  const { targetVersion, attemptId, code, message } = record;
  if (command !== "host update" && command !== "host apply") return null;
  if (
    initiator !== "manual" &&
    initiator !== "automatic" &&
    initiator !== "support-floor" &&
    initiator !== "desktop"
  ) {
    return null;
  }
  if (
    outcome !== "complete" &&
    outcome !== "applied" &&
    outcome !== "no-op" &&
    outcome !== "parked" &&
    outcome !== "refused" &&
    outcome !== "failed"
  ) {
    return null;
  }
  if (
    typeof recordedAt !== "string" ||
    !isStringOrNull(targetVersion) ||
    !isStringOrNull(attemptId) ||
    !isStringOrNull(code) ||
    !isStringOrNull(message)
  ) {
    return null;
  }
  return {
    command,
    initiator,
    outcome,
    targetVersion,
    attemptId,
    code,
    message,
    recordedAt,
  };
}
