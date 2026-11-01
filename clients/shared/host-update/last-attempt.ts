import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { renameWithWindowsRetry } from "@traycer/protocol/config/credentials-fs";
import {
  redactHomeDirectoryNames,
  redactSensitiveText,
} from "@traycer/protocol/utils/text/redaction";
import type { HostUpdateTrigger } from "./record";

/**
 * What the last `host update` or `host apply` came to, whoever ran it, and
 * beside it why the last `host download` did not get through.
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
 * So the answer to "did my update work" lives here, beside it. The commands
 * write it as they exit. Desktop writes it for what no command saw: the host it
 * applied coming up or not, and a child that died before it could say. It
 * carries no authority: nothing admits or refuses on it, it takes no lock, and
 * the last writer wins, which is what "latest" means. Losing a write costs a
 * stale line in `host status`, so a failed write never fails the run it
 * describes.
 *
 * `host status` shows it and support reads it, so it is held to what a log is:
 * error text is quoted here, and error text carries paths with the account name
 * in them, emails and signed URLs. See `recordableText`.
 *
 * A download has a file of its own. It runs in the background whether or not
 * anyone asked, so in this one it would replace the update that mattered, a
 * parked one included, and hide the apply Desktop is waiting to conclude. It
 * records only how it failed, and that goes when a download stages something or
 * an update delivers.
 */
const UPDATE_LAST_ATTEMPT_FILENAME = "update-last-attempt.json";
const HOST_DOWNLOAD_FAILURE_FILENAME = "update-last-download-failure.json";
/** The patterns are not linear, so what they scan is bounded first. */
const MAX_SCANNED_TEXT_LENGTH = 16_000;
const MAX_RECORDED_TEXT_LENGTH = 2_000;

const REDACTED = "<redacted>";
const EMAIL_PATTERN = /[^\s@"'<>/:[\]]+@[^\s@"'<>/]+\.[A-Za-z]{2,}/g;

export type HostUpdateAttemptInitiator = HostUpdateTrigger | "desktop";

export type HostUpdateAttemptOutcome =
  /** The target is installed and its host was seen running. */
  | "complete"
  /** The bytes are installed; nothing has seen their host running. */
  | "applied"
  | "no-op"
  /** Waiting for the host to go idle, or for a service it cannot start. */
  | "parked"
  /** Stopped before it changed anything. */
  | "refused"
  | "failed";

export interface HostUpdateLastAttempt {
  readonly command: "host update" | "host apply" | "host download";
  readonly initiator: HostUpdateAttemptInitiator;
  readonly outcome: HostUpdateAttemptOutcome;
  /** `null` when the run stopped before it knew its target. */
  readonly targetVersion: string | null;
  /** The `update-attempt.json` attempt, when the run claimed one. */
  readonly attemptId: string | null;
  /** The CLI error code or refusal reason, when the run ended on one. */
  readonly code: string | null;
  readonly message: string | null;
  readonly recordedAt: string;
}

function lastAttemptPath(
  hostHome: string,
  command: HostUpdateLastAttempt["command"],
): string {
  return join(
    hostHome,
    command === "host download"
      ? HOST_DOWNLOAD_FAILURE_FILENAME
      : UPDATE_LAST_ATTEMPT_FILENAME,
  );
}

function escapedForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What of an error's text may be kept: no credential and no account name.
 *
 * Credentials and home folders are the shared rules. What is added here is what
 * a record needs and a log does not: this account's home wherever it lives, and
 * emails. In this order. A bare name is stripped last, and only where a path, a
 * domain or a mailbox puts it: anywhere else it can be a word the message needs,
 * a home called `traycer` being the plain case, and a mark left early would stop
 * the email and home rules matching.
 */
function recordableText(text: string): string {
  const home = homedir();
  const name = basename(home);
  let redacted = redactSensitiveText(text.slice(0, MAX_SCANNED_TEXT_LENGTH));
  // An empty or root home has no name and stands for nothing to strip.
  if (name !== "") {
    redacted = redacted.replace(
      new RegExp(
        `(?<![\\w.-])${escapedForPattern(home)}(?![^\\\\/\\s"':,)])`,
        "gi",
      ),
      "~",
    );
  }
  redacted = redactHomeDirectoryNames(redacted).replace(
    EMAIL_PATTERN,
    REDACTED,
  );
  if (name !== "") {
    redacted = redacted.replace(
      new RegExp(`(?<=[\\\\/~@])${escapedForPattern(name)}(?![\\w-])`, "gi"),
      REDACTED,
    );
  }
  return redacted.length <= MAX_RECORDED_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_RECORDED_TEXT_LENGTH)}...`;
}

export async function writeHostUpdateLastAttempt(
  hostHome: string,
  attempt: Omit<HostUpdateLastAttempt, "recordedAt">,
  logger: {
    readonly info: (
      message: string,
      fields: { readonly outcome: string; readonly error: string },
    ) => void;
  },
): Promise<void> {
  const path = lastAttemptPath(hostHome, attempt.command);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify({
        ...attempt,
        targetVersion:
          attempt.targetVersion === null
            ? null
            : recordableText(attempt.targetVersion),
        message:
          attempt.message === null ? null : recordableText(attempt.message),
        recordedAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await renameWithWindowsRetry(temporary, path, 0);
    // Whichever version each named: this install has moved on from what the
    // failed download was fetching.
    if (attempt.outcome === "complete" || attempt.outcome === "applied") {
      await clearHostDownloadFailure(hostHome);
    }
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    logger.info("Host update could not record its outcome", {
      outcome: attempt.outcome,
      error: recordableText(err instanceof Error ? err.message : String(err)),
    });
  }
}

async function readAttemptAt(
  path: string,
): Promise<HostUpdateLastAttempt | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseLastAttempt(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readHostUpdateLastAttempt(
  hostHome: string,
): Promise<HostUpdateLastAttempt | null> {
  return readAttemptAt(lastAttemptPath(hostHome, "host update"));
}

export function readHostDownloadFailure(
  hostHome: string,
): Promise<HostUpdateLastAttempt | null> {
  return readAttemptAt(lastAttemptPath(hostHome, "host download"));
}

/** Something was delivered since: the failure no longer describes this install. */
export async function clearHostDownloadFailure(
  hostHome: string,
): Promise<void> {
  await rm(lastAttemptPath(hostHome, "host download"), { force: true }).catch(
    () => undefined,
  );
}

/** Removed with the install it describes. */
export async function removeHostUpdateLastAttempt(
  hostHome: string,
): Promise<void> {
  await rm(lastAttemptPath(hostHome, "host update"), { force: true }).catch(
    () => undefined,
  );
  await clearHostDownloadFailure(hostHome);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseLastAttempt(value: unknown): HostUpdateLastAttempt | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { command, initiator, outcome, recordedAt } = record;
  const { targetVersion, attemptId, code, message } = record;
  if (
    command !== "host update" &&
    command !== "host apply" &&
    command !== "host download"
  ) {
    return null;
  }
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
