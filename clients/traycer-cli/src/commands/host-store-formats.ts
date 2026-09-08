import {
  resolveHostStoreFormats,
  CHAT_DB_FORMAT_TABLE_CEILING,
} from "@traycer/protocol/host/store-formats";
import { surveyChatDbStamps } from "../host/chat-store-survey";
import { readInstalledFloorOperands } from "../host/installed-store-formats";
import { hostHomeDir } from "../store/paths";
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
 * uses it as the per-platform proof that the survey's SQLite engine actually
 * works inside the signed binary (see `scripts/smoke-cli-sea.cjs`).
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
    // The same operands the floor itself judges with, through the same reader
    // - a diagnostic that resolved the installed side its own way could
    // disagree with the refusal it is being run to explain. No manifest entry
    // is consulted: this is a local read and an offline machine must still get
    // an answer, so the installed build is placed by what its own tree
    // DECLARES, falling back to the fixed table.
    const installed = await readInstalledFloorOperands(
      environment,
      ctx.runtime.logger,
    );
    const installedVersion = installed.version;
    const survey = await surveyChatDbStamps(hostHome);
    const installedFormats =
      installedVersion === null
        ? null
        : resolveHostStoreFormats(installedVersion, installed.storeFormats);
    const readings = [...survey.readings].sort(
      (left, right) => right.schemaVersion - left.schemaVersion,
    );
    // Sorted descending immediately above, so the head IS the maximum.
    const maxChatDb = readings[0]?.schemaVersion ?? null;
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
        installedDeclaredChatDbFormat: installed.storeFormats?.chatDb ?? null,
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
