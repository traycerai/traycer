import { type ChildProcess, spawn } from "node:child_process";

// Resolve the PID + process name holding a TCP port. Used by Doctor to
// distinguish a true port-conflict (Free Port + Restart can ask the
// holder to exit) from a generic unreachable endpoint (where the host
// PID is alive but its socket isn't accepting connections - restart is
// the right fix). The platforms we ship CLI on each expose a different
// listing tool; we shell out, parse stdout, and tolerate any tool
// missing/erroring so Doctor can always degrade to "no identifiable
// conflict, route to restart".
export interface PortConflictInfo {
  readonly pid: number;
  readonly processName: string;
}

export interface ResolvePortConflictDeps {
  // Allows tests to inject a deterministic stdout per tool instead of
  // shelling out. Resolves null when the tool isn't available on the
  // current host.
  runCommand(
    bin: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string } | null>;
  readonly platform: NodeJS.Platform;
}

export async function resolvePortConflict(
  port: number,
  ignorePids: ReadonlySet<number>,
  deps: ResolvePortConflictDeps,
): Promise<PortConflictInfo | null> {
  if (!Number.isFinite(port) || port <= 0) return null;
  if (deps.platform === "darwin" || deps.platform === "linux") {
    const lsof = await deps.runCommand("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpcn",
    ]);
    const parsed = lsof !== null ? parseLsof(lsof.stdout) : null;
    if (parsed !== null && !ignorePids.has(parsed.pid)) return parsed;

    // Linux fallback: `ss -ltnp sport = :<port>` is available on systemd
    // distros where lsof is not.
    if (deps.platform === "linux") {
      const ss = await deps.runCommand("ss", ["-ltnpH", `sport = :${port}`]);
      const parsedSs = ss !== null ? parseSs(ss.stdout) : null;
      if (parsedSs !== null && !ignorePids.has(parsedSs.pid)) return parsedSs;
    }
    return null;
  }
  if (deps.platform === "win32") {
    const netstat = await deps.runCommand("netstat", ["-ano", "-p", "tcp"]);
    const parsed = netstat !== null ? parseNetstat(netstat.stdout, port) : null;
    if (parsed === null) return null;
    if (ignorePids.has(parsed.pid)) return null;
    // Resolve PID → process name via tasklist (best effort).
    const tasklist = await deps.runCommand("tasklist", [
      "/FI",
      `PID eq ${parsed.pid}`,
      "/FO",
      "CSV",
      "/NH",
    ]);
    const name = tasklist !== null ? parseTasklist(tasklist.stdout) : null;
    return { pid: parsed.pid, processName: name ?? "(unknown)" };
  }
  return null;
}

// lsof -Fpcn emits a single record per FD:
//   p<pid>\n
//   c<command>\n
//   n<endpoint>\n
// We only care about the first LISTEN match.
export function parseLsof(stdout: string): PortConflictInfo | null {
  const lines = stdout.split("\n");
  let pid: number | null = null;
  let command: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const rest = line.slice(1);
    if (tag === "p") {
      const parsedPid = Number.parseInt(rest, 10);
      pid = Number.isFinite(parsedPid) ? parsedPid : null;
      command = null;
    } else if (tag === "c") {
      command = rest;
      if (pid !== null && command.length > 0) {
        return { pid, processName: command };
      }
    }
  }
  if (pid !== null) {
    return { pid, processName: command ?? "(unknown)" };
  }
  return null;
}

// `ss -ltnpH sport = :<port>` rows look like:
//   LISTEN 0  128  0.0.0.0:7300  0.0.0.0:*  users:(("node",pid=1234,fd=18))
export function parseSs(stdout: string): PortConflictInfo | null {
  for (const line of stdout.split("\n")) {
    const usersMatch = line.match(/users:\(\("([^"]+)",pid=(\d+),/);
    if (usersMatch !== null) {
      const pid = Number.parseInt(usersMatch[2] ?? "", 10);
      if (Number.isFinite(pid)) {
        return { pid, processName: usersMatch[1] ?? "(unknown)" };
      }
    }
  }
  return null;
}

// netstat -ano -p tcp rows on Windows look like:
//   TCP    127.0.0.1:7300   0.0.0.0:0   LISTENING   1234
export function parseNetstat(
  stdout: string,
  port: number,
): { pid: number } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    if (!trimmed.includes("LISTENING")) continue;
    if (!trimmed.includes(`:${port} `)) continue;
    const tokens = trimmed.split(/\s+/);
    const pidToken = tokens[tokens.length - 1];
    const pid = Number.parseInt(pidToken ?? "", 10);
    if (Number.isFinite(pid)) return { pid };
  }
  return null;
}

// tasklist /NH CSV rows:
//   "node.exe","1234","Console","1","42,108 K"
export function parseTasklist(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (firstLine === undefined) return null;
  const match = firstLine.match(/^"([^"]+)"/);
  return match !== null ? (match[1] ?? null) : null;
}

export function createRealRunCommand(): ResolvePortConflictDeps["runCommand"] {
  return (bin, args) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let child: ChildProcess;
      try {
        child = spawn(bin, [...args], { windowsHide: true });
      } catch {
        resolve(null);
        return;
      }
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(null);
      }, 1500);
      child.once("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 || stdout.length > 0) {
          resolve({ stdout, stderr });
        } else {
          resolve(null);
        }
      });
    });
}
