import type { ProcessIncarnationProbe } from "@traycer/protocol/config/data-migration-admission";
import type { DataRootPlatform } from "@traycer/protocol/config/data-root";
import { CLI_ERROR_CODES, type CliErrorCode } from "../../runner/errors";
import type { MigrationEngineDeps } from "../engine/engine-deps";
import type { EngineProgress } from "../engine/engine-types";
import type { DataRootAvailability } from "./data-availability";

/**
 * What a `traycer data ...` command reads and does, behind one record so
 * isolated fixtures can drive every command against a temp home. Production
 * wiring is `productionDataCommandDeps` (`data-control-entry.ts`).
 */
export type DataCommandDeps = {
  readonly homeDir: string;
  readonly platform: DataRootPlatform;
  /** Read only by `data init` / `data migrate` for `TRAYCER_DATA_DIR` (setup-only input). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly availability: DataRootAvailability;
  readonly probe: ProcessIncarnationProbe;
  readonly engine: (input: {
    readonly signal: AbortSignal;
    readonly progress: (event: EngineProgress) => void;
  }) => MigrationEngineDeps;
  readonly signal: AbortSignal;
  readonly io: DataCommandIo;
};

export interface DataCommandIo {
  /** One NDJSON result envelope on stdout instead of text. */
  readonly json: boolean;
  /** A person can answer prompts: a TTY on stdin, not `--json`, not `--non-interactive`. */
  readonly interactive: boolean;
  /** Human progress and report text (stderr, so stdout stays the result). */
  note(text: string): void;
  /**
   * Progress: a `--json` progress event, or `line` on stderr in human mode.
   * Nothing at all under `--no-progress`.
   */
  progress(stage: string, message: string, line: string): void;
  /** A yes/no question; false on anything but yes, Ctrl+C or a closed stdin. */
  confirm(question: string): Promise<boolean>;
}

export type DataCommandOutcome =
  | {
      readonly status: "ok";
      readonly data: Record<string, unknown>;
      /** Human result lines, printed to stdout. */
      readonly text: readonly string[];
    }
  | {
      readonly status: "error";
      readonly code: CliErrorCode;
      readonly message: string;
      readonly details: Record<string, unknown> | null;
      /** Human context printed before the error line (stderr). */
      readonly text: readonly string[];
    };

export function ok(
  data: Record<string, unknown>,
  text: readonly string[],
): DataCommandOutcome {
  return { status: "ok", data, text };
}

/**
 * Ask before a change: null when confirmed (by `--yes` or at the prompt),
 * otherwise the outcome to return. Without a prompt and without `--yes`
 * nothing changes.
 */
export async function confirmOrRefuse(
  deps: DataCommandDeps,
  yes: boolean,
  lines: readonly string[],
  question: string,
): Promise<DataCommandOutcome | null> {
  if (yes) {
    deps.io.note(lines.join("\n"));
    return null;
  }
  if (!deps.io.interactive) {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      "pass --yes to confirm",
      null,
      lines,
    );
  }
  deps.io.note(lines.join("\n"));
  return (await deps.io.confirm(question))
    ? null
    : failed(CLI_ERROR_CODES.INVALID_ARGUMENT, "nothing was changed", null, []);
}

export function failed(
  code: CliErrorCode,
  message: string,
  details: Record<string, unknown> | null,
  text: readonly string[],
): DataCommandOutcome {
  return { status: "error", code, message, details, text };
}
