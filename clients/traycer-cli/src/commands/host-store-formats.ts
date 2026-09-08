import { dirname } from "node:path";
import {
  resolveHostStoreFormats,
  CHAT_DB_FORMAT_TABLE_CEILING,
  type HostStoreFormats,
} from "@traycer/protocol/host/store-formats";
import { surveyChatDbStamps } from "../host/chat-store-survey";
import { readInstalledVersionForFloor } from "../host/store-format-floor";
import { readExtractedStoreFormats } from "../installer/install";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { hostHomeDir } from "../store/paths";
import type { ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import type { CommandFn, CommandResult } from "../runner/runner";

/**
 * `traycer host store-formats` - the read-only view behind the store-format
 * floor.
 *
 * HIDDEN, and deliberately so: it answers a question a user never has until
 * something has already refused, and the refusal itself names the epics. What
 * it exists for is the two callers that need the raw facts rather than a
 * sentence - support, when someone reports "the CLI will not let me install
 * 1.2.0" and the epic list has scrolled away, and the SEA release smoke, which
 * uses it as the per-platform proof that `node:sqlite` actually works inside
 * the signed binary (see `scripts/smoke-cli-sea.cjs`).
 *
 * It mutates nothing and refuses nothing. Every failure the survey collects is
 * REPORTED here rather than raised - the point of a diagnostic is to show the
 * unreadable files, and a command that threw on the first one would hide the
 * rest. Exit code is always 0 for the same reason; the floor is what refuses.
 *
 * It reads `chat_db_meta` directly, never through the host's store open, which
 * migrates a file on sight. Running a diagnostic must not be the thing that
 * changes the answer.
 */
export function buildHostStoreFormatsCommand(): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    const hostHome = hostHomeDir(environment);
    const installedVersion = await readInstalledVersionForFloor(
      environment,
      ctx.runtime.logger,
    );
    const survey = await surveyChatDbStamps(hostHome);
    // No manifest entry is consulted here - this is a local read, and an
    // offline machine must still get an answer - so the installed build is
    // placed by what its own tree DECLARES, falling back to the fixed table.
    // The declaration is the half that matters in practice: a locally packaged
    // install is stamped `<target>.<epochMs>.<sha>`, which the table cannot
    // place at all, and "unknown" would otherwise be the only thing this
    // command could ever say about a developer's machine.
    const installedDeclaredFormats = await readInstalledDeclaredFormats(
      environment,
      ctx.runtime.logger,
    );
    const installedFormats =
      installedVersion === null
        ? null
        : resolveHostStoreFormats(installedVersion, installedDeclaredFormats);
    const readings = [...survey.readings].sort(
      (left, right) => right.schemaVersion - left.schemaVersion,
    );
    const maxChatDb =
      readings.length === 0
        ? null
        : readings.reduce(
            (highest, reading) => Math.max(highest, reading.schemaVersion),
            0,
          );
    return {
      data: {
        hostHome,
        installedVersion,
        // Both halves of the knowledge, not a flattened number: "this build
        // writes 9" and "nothing here knows what this build writes" are
        // different answers, and a `null` chatDb alone cannot tell them apart.
        installedChatDbFormat:
          installedFormats !== null && installedFormats.kind === "known"
            ? installedFormats.formats.chatDb
            : null,
        installedFormatsUnknownReason:
          installedFormats !== null && installedFormats.kind === "unknown"
            ? installedFormats.reason
            : null,
        // Reported beside the resolved value, not folded into it: "the install
        // declares 9" and "the table places this version at 9" are different
        // provenances, and support needs to know which one answered.
        installedDeclaredChatDbFormat: installedDeclaredFormats?.chatDb ?? null,
        chatDbFormatTableCeiling: CHAT_DB_FORMAT_TABLE_CEILING,
        maxChatDbFormatOnDisk: maxChatDb,
        epics: readings.map((reading) => ({
          epicId: reading.epicId,
          chatDbFormat: reading.schemaVersion,
        })),
        failures: survey.failures.map((failure) => ({
          epicId: failure.epicId,
          reason: failure.reason,
        })),
      },
      human: humanSummary({
        hostHome,
        installedVersion,
        installedChatDb:
          installedFormats !== null && installedFormats.kind === "known"
            ? installedFormats.formats.chatDb
            : null,
        maxChatDb,
        epicLines: readings.map(
          (reading) => `  ${reading.epicId}  chatDb=${reading.schemaVersion}`,
        ),
        failureLines: survey.failures.map(
          (failure) => `  ${failure.epicId}  unreadable: ${failure.reason}`,
        ),
      }),
      exitCode: 0,
    };
  };
}

/**
 * The installed tree's own `version.json` declaration, or `null`.
 *
 * Read through the STRICT record reader deliberately: unlike
 * `readInstalledVersionForFloor`, which collapses an unreadable record to
 * `null` so the floor still evaluates, a diagnostic that cannot read the
 * record has nothing to locate the tree with and simply reports no
 * declaration. Every failure is `null`; nothing here refuses.
 */
async function readInstalledDeclaredFormats(
  environment: Environment,
  logger: ILogger,
): Promise<HostStoreFormats | null> {
  let record: HostInstallRecord | null;
  try {
    record = await readHostInstallRecord(environment);
  } catch {
    return null;
  }
  if (record === null) return null;
  return readExtractedStoreFormats(
    dirname(record.executablePath),
    environment,
    logger,
  );
}

function humanSummary(args: {
  readonly hostHome: string;
  readonly installedVersion: string | null;
  readonly installedChatDb: number | null;
  readonly maxChatDb: number | null;
  readonly epicLines: readonly string[];
  readonly failureLines: readonly string[];
}): string {
  const lines: string[] = [
    `hostHome: ${args.hostHome}`,
    `installed host: ${args.installedVersion ?? "none"}`,
    `installed host reads chatDb: ${args.installedChatDb ?? "unknown"}`,
    `highest chatDb on disk: ${args.maxChatDb ?? "none"}`,
    "",
  ];
  if (args.epicLines.length === 0 && args.failureLines.length === 0) {
    lines.push("no per-epic chat stores found");
    return lines.join("\n");
  }
  lines.push(...args.epicLines, ...args.failureLines);
  return lines.join("\n");
}
