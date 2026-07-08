import { z } from "zod";

const STDIN_READ_TIMEOUT_MS = 5_000;

/**
 * Read stdin as JSON, with a hard timeout. Returns:
 *   - `"timeout"` if the read didn't finish in time (caller noops);
 *   - `null` for an empty stream, unparsable JSON, or a TTY stdin;
 *   - the parsed JSON value otherwise.
 *
 * Shared by the provider hook commands (title / activity / session-observed):
 * each is invoked by a provider hook that pipes its JSON payload on stdin, and
 * each must degrade to a quiet no-op on a missing/slow/garbage stream rather
 * than fail the hook.
 *
 * On timeout we explicitly `destroy()` stdin to release the async iterator
 * and let the event loop exit cleanly. (Without this, `for await (chunk of
 * process.stdin)` keeps the loop alive even after we've resolved.)
 */
export async function readStdinJson(): Promise<unknown | "timeout"> {
  if (process.stdin.isTTY === true) return null;

  const read = (async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  let timer: NodeJS.Timeout | undefined;
  type Outcome = { kind: "ok"; raw: string } | { kind: "timeout" };
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      STDIN_READ_TIMEOUT_MS,
    );
  });
  // `wrappedRead` must never reject: any stdin stream failure - including the
  // `for await` iterator rejecting when the timeout branch calls
  // `process.stdin.destroy()` - degrades to the same quiet no-op as an empty
  // stream (`raw: ""` -> `null`). This is what upholds the "never throws"
  // contract of `readObservedHarnessSessionId`; a hook must not fail on a
  // stdin error. It also handles `read`'s rejection, so no separate
  // unhandled-rejection catch is needed.
  const wrappedRead = read.then(
    (raw): Outcome => ({ kind: "ok", raw }),
    (): Outcome => ({ kind: "ok", raw: "" }),
  );

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

// Every Claude Code hook stamps the live `session_id` on its stdin JSON. We
// extract it with a loose object so unrelated fields on the payload are
// ignored and a schema drift never fails the hook.
const observedSessionSchema = z.looseObject({ session_id: z.string() });

/**
 * Read the live provider `session_id` from the hook stdin payload, for the
 * Claude TUI session-id resync. Returns the trimmed non-empty id, or `null`
 * for any benign condition (empty/TTY/timeout stdin, unparsable JSON, missing
 * or blank `session_id`). Never throws - a resync that can't read an id is a
 * quiet no-op, never a failed hook.
 */
export async function readObservedHarnessSessionId(): Promise<string | null> {
  const stdin = await readStdinJson();
  if (stdin === "timeout" || stdin === null) return null;
  const parsed = observedSessionSchema.safeParse(stdin);
  if (!parsed.success) return null;
  const sessionId = parsed.data.session_id.trim();
  return sessionId.length === 0 ? null : sessionId;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
