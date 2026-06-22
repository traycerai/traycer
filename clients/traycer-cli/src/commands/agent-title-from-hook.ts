import { z } from "zod";
import {
  generateTuiAgentTitleRequestSchema,
  generateTuiAgentTitleResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { tuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS } from "@traycer/protocol/host/epic/unary-schemas";
import {
  callHostRpcFastFail,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

const STDIN_READ_TIMEOUT_MS = 5_000;

/**
 * Provider hook payloads we accept on stdin. Each provider hands us a
 * different shape; we extract the first user prompt only and never log it.
 *
 *   - `claude` / `codex`: top-level `prompt` string.
 *   - `opencode`: text concatenated from `output.parts[*].text` (only
 *     entries with `type: "text"` and a non-empty `text` contribute).
 */
const claudeOrCodexHookSchema = z.looseObject({ prompt: z.string() });

const opencodeTextPartSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

const opencodeHookSchema = z.looseObject({
  output: z.looseObject({
    parts: z.array(z.unknown()),
  }),
});

type NoopReason =
  | "missing-context"
  | "empty-stdin"
  | "empty-prompt"
  | "stdin-timeout"
  | "unknown-provider"
  | "host-unreachable";

/**
 * `traycer agent title-from-hook --provider <provider>` - invoked by a
 * provider hook (Claude, Codex, OpenCode) on the user's first prompt.
 * Reads the hook JSON from stdin, extracts the prompt, and asks the
 * host to schedule a title for the bound `tuiAgentId` via
 * `agent.tui.generateTitle@1.0`.
 *
 * The command is intentionally lenient: missing `TRAYCER_EPIC_ID` /
 * `TRAYCER_AGENT_ID`, an empty prompt, an unparsable JSON payload, a
 * stdin timeout, an unknown provider, or a host-not-running condition
 * all exit cleanly (exit 0) with `accepted: false` and no stderr noise.
 * The hook fires unconditionally (e.g. when claude is launched standalone
 * outside Traycer), so any benign condition must be a silent no-op.
 * Genuine errors (auth rejection, schema mismatches once the host
 * answers, etc.) still surface.
 *
 * Harness id is derived from the `--provider` arg (claude → "claude",
 * codex → "codex", opencode → "opencode"). The host resolver
 * cross-checks this against the persisted `tuiAgent.harnessId`, so a
 * mismatched hook (e.g. a stale Claude hook firing against a Codex
 * agent) is rejected server-side.
 */
export function buildAgentTitleFromHookCommand(opts: {
  readonly provider: string;
  readonly epicId: string | null;
  readonly agentId: string | null;
  readonly harnessSessionId: string | null;
}): CommandFn {
  return async () => {
    const parsedHarness = tuiHarnessIdSchema.safeParse(opts.provider);
    if (!parsedHarness.success) return noop("unknown-provider");
    const harnessId = parsedHarness.data;

    const harnessSessionId =
      opts.harnessSessionId !== null && opts.harnessSessionId.trim().length > 0
        ? opts.harnessSessionId
        : null;
    const epicId = harnessSessionId === null ? readEpicId(opts.epicId) : null;
    const tuiAgentId =
      harnessSessionId === null ? readTuiAgentId(opts.agentId) : null;
    if (harnessSessionId === null && (epicId === null || tuiAgentId === null)) {
      return noop("missing-context");
    }

    const stdin = await readStdinJson();
    if (stdin === "timeout") return noop("stdin-timeout");
    if (stdin === null) return noop("empty-stdin");

    const promptText = extractPrompt(harnessId, stdin);
    if (promptText === null || promptText.length === 0) {
      return noop("empty-prompt");
    }

    const truncated = promptText.slice(0, GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS);
    const request = parseUserInput(generateTuiAgentTitleRequestSchema, {
      epicId,
      tuiAgentId,
      harnessSessionId,
      harnessId,
      promptText: truncated,
    });

    // Treat host-not-running as a benign condition - the hook fires
    // unconditionally and the host may simply not be installed/up. All
    // other RPC errors (auth, etc.) still surface.
    const rpcResult = await toAgentCliError(
      callHostRpcFastFail("agent.tui.generateTitle", request),
    ).catch((err: unknown) => {
      if (
        err instanceof CliError &&
        err.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
      ) {
        return "host-unreachable" as const;
      }
      throw err;
    });
    if (rpcResult === "host-unreachable") {
      return noop("host-unreachable");
    }

    const { accepted } = parseHostResponse(
      generateTuiAgentTitleResponseSchema,
      rpcResult,
    );
    // No `human` line: a `UserPromptSubmit` hook's stdout is surfaced
    // back into the codex / claude TUI as "hook context", and leaking
    // "title scheduled" into the user's chat history would be noise.
    return {
      data: { accepted, reason: null },
      human: null,
      exitCode: 0,
    };
  };
}

function noop(reason: NoopReason) {
  return {
    data: { accepted: false, reason },
    human: null,
    exitCode: 0,
  };
}

function extractPrompt(
  harness: z.infer<typeof tuiHarnessIdSchema>,
  payload: unknown,
): string | null {
  if (harness === "claude" || harness === "codex") {
    const parsed = claudeOrCodexHookSchema.safeParse(payload);
    if (!parsed.success) return null;
    return parsed.data.prompt.trim().length === 0 ? null : parsed.data.prompt;
  }
  if (harness === "opencode") {
    const parsed = opencodeHookSchema.safeParse(payload);
    if (!parsed.success) return null;
    const text = parsed.data.output.parts
      .flatMap((part) => {
        const r = opencodeTextPartSchema.safeParse(part);
        return r.success ? [r.data.text] : [];
      })
      .join("");
    return text.trim().length === 0 ? null : text;
  }
  // Cursor TUI exists in the schema but ships no hook payload contract
  // yet; treat as a quiet no-op rather than failing the hook.
  return null;
}

/**
 * Read stdin as JSON, with a hard timeout. Returns:
 *   - `"timeout"` if the read didn't finish in time (caller noops);
 *   - `null` for an empty stream, unparsable JSON, or a TTY stdin;
 *   - the parsed JSON value otherwise.
 *
 * On timeout we explicitly `destroy()` stdin to release the async iterator
 * and let the event loop exit cleanly. (Without this, `for await (chunk of
 * process.stdin)` keeps the loop alive even after we've resolved.)
 */
async function readStdinJson(): Promise<unknown | "timeout"> {
  if (process.stdin.isTTY === true) return null;

  const read = (async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  // When the timeout branch wins and we call `process.stdin.destroy()`,
  // the still-pending `for await` iterator above rejects. Attach a
  // no-op catch so that rejection doesn't bubble up as an unhandled
  // promise rejection - the timeout outcome is already wired through
  // `wrappedRead` / `timeout` below.
  read.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  type Outcome = { kind: "ok"; raw: string } | { kind: "timeout" };
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      STDIN_READ_TIMEOUT_MS,
    );
  });
  const wrappedRead = read.then((raw): Outcome => ({ kind: "ok", raw }));

  const winner = await Promise.race([wrappedRead, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (winner.kind === "timeout") {
    // Release the async iterator so the process can exit promptly.
    try {
      process.stdin.destroy();
    } catch {
      // best-effort
    }
    return "timeout";
  }
  const raw = winner.raw;
  if (raw.trim().length === 0) return null;
  return safeJsonParse(raw);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
