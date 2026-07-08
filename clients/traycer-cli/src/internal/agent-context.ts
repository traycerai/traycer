/**
 * Resolves the ambient agent/epic identifiers the `traycer agent`
 * subcommands operate under. A Traycer-launched session carries
 * `TRAYCER_AGENT_ID` and `TRAYCER_EPIC_ID` in its environment, so an
 * agent typically runs `traycer agent send --to …` with no other flags;
 * an explicit flag always overrides the env default.
 *
 * `read*` variants return `null` when neither flag nor env supplies a
 * value - used by hook-driven commands where missing context is a
 * benign no-op. `resolve*` variants throw `INVALID_ARGUMENT` instead.
 */

import { cliError, CLI_ERROR_CODES } from "../runner/errors";

function readEnvOrFlag(flag: string | null, envKey: string): string | null {
  const value = flag ?? process.env[envKey] ?? null;
  if (value === null || value.length === 0) return null;
  return value;
}

function requireValue(value: string | null, missingMessage: string): string {
  if (value === null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: missingMessage,
      details: null,
      exitCode: 1,
    });
  }
  return value;
}

export function readEpicId(flag: string | null): string | null {
  return readEnvOrFlag(flag, "TRAYCER_EPIC_ID");
}

export function readTuiAgentId(flag: string | null): string | null {
  return readEnvOrFlag(flag, "TRAYCER_AGENT_ID");
}

export function resolveEpicId(flag: string | null): string {
  return requireValue(
    readEpicId(flag),
    "traycer: epic id required - pass --epic-id or set TRAYCER_EPIC_ID.",
  );
}

export function resolveSenderAgentId(flag: string | null): string {
  return requireValue(
    readTuiAgentId(flag),
    "traycer: sender agent id required - pass --sender-agent-id or set TRAYCER_AGENT_ID.",
  );
}
