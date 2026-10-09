import { execFile } from "node:child_process";

/**
 * Does a pid name a running process - asked WITHOUT blocking the event loop.
 *
 * The one asynchronous liveness probe for every lock and record in the
 * `~/.traycer` tree: `@traycer-clients/shared/host-lock`'s identity verdicts
 * (the CLI and desktop locks, `pid.json`, the desktop presence record) and
 * this package's credentials lock and spent-base marker. It lives here, not in
 * `clients/shared`, because this package cannot import upward and both need
 * it; two copies of a liveness probe are how "alive" comes to mean two
 * different things.
 *
 * Tri-state, so a probe FAILURE is never read as either answer:
 * - `alive` and `dead` are positive evidence;
 * - `indeterminate` - the probe established neither (`tasklist` missing,
 *   refused or timed out; an unexpected errno). Never break evidence.
 */
export type ProcessLivenessVerdict = "alive" | "dead" | "indeterminate";

/**
 * POSIX: `process.kill(pid, 0)`, which spawns nothing - EPERM is alive (the
 * kernel found the pid to check permissions against), ESRCH is dead, any
 * other errno is `indeterminate`. Windows: `tasklist /FI "PID eq <pid>"`
 * (3s timeout), run asynchronously - a blocking spawn there stalls the
 * calling process for as long as a loaded machine takes to answer.
 */
export async function probeProcessLivenessAsync(
  pid: number,
): Promise<ProcessLivenessVerdict> {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : null;
      if (code === "EPERM") return "alive";
      return code === "ESRCH" ? "dead" : "indeterminate";
    }
  }
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { encoding: "utf8", windowsHide: true, timeout: 3_000 },
      (err, out) => resolve(err === null ? out : null),
    );
  });
  if (stdout === null) return "indeterminate";
  // No match prints nothing on stdout (an `INFO: No tasks ...` line, on the
  // builds that print it there); a match is a CSV row carrying the same pid.
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.startsWith("INFO:")) return "dead";
  return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
}
