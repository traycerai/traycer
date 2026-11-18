import { attestTraycerRegistration, type TraycerLabelIds } from "../identity";
import type { LingerState, UnitFileState } from "./types";

/**
 * Classify a systemd user unit file on disk with Traycer identity
 * attestation over ExecStart tokens.
 */
export function classifyUnitFile(input: {
  readonly path: string;
  readonly labelId: string;
  readonly knownLabels: TraycerLabelIds | null;
  readonly exists: boolean;
  readonly text: string | null;
  readonly readError: string | null;
}): UnitFileState {
  if (input.readError !== null) {
    return { kind: "unreadable", cause: input.readError };
  }
  if (!input.exists || input.text === null) {
    return { kind: "absent" };
  }
  const tokens = extractExecStartTokens(input.text);
  if (tokens === null) {
    return { kind: "indeterminate", cause: "parse-error" };
  }
  const identity = attestTraycerRegistration({
    labelId: input.labelId,
    knownLabels: input.knownLabels,
    programArguments: tokens,
    contentTag: null,
    sourceText: input.text,
  });
  // Map program-arguments signal to exec-start for Linux clarity.
  const withExec =
    identity.kind === "attested"
      ? {
          ...identity,
          signals: identity.signals.map((s) =>
            s.kind === "program-arguments"
              ? { kind: "exec-start" as const, tokens: s.tokens }
              : s,
          ),
        }
      : identity;

  return {
    kind: "observed",
    path: input.path,
    identity: withExec,
  };
}

export function extractExecStartTokens(
  unitText: string,
): readonly string[] | null {
  const line = unitText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ExecStart="));
  if (line === undefined) return null;
  const raw = line.slice("ExecStart=".length).trim();
  if (raw.length === 0) return null;
  return tokenizeExecStart(raw);
}

/**
 * Minimal systemd ExecStart tokenizer: respects double quotes and
 * backslash escapes. Good enough for units this project writes.
 */
export function tokenizeExecStart(raw: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    if (ch === "\\" && inQuote) {
      const next = raw[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if ((ch === " " || ch === "\t") && !inQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Parse `loginctl show-user <user> -p Linger` output.
 */
export function classifyLingerState(
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly spawnFailed: boolean;
  },
  userKnown: boolean,
): LingerState {
  if (!userKnown) return { kind: "absent" };
  if (result.spawnFailed || result.timedOut || result.exitCode !== 0) {
    return { kind: "indeterminate", cause: "loginctl-failed" };
  }
  const match = /Linger=(yes|no|true|false)/i.exec(result.stdout);
  if (match === null || match[1] === undefined) {
    return { kind: "indeterminate", cause: "parse-error" };
  }
  const v = match[1].toLowerCase();
  return {
    kind: "observed",
    enabled: v === "yes" || v === "true",
  };
}
