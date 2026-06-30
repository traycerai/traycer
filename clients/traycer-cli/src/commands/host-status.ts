import { homedir } from "node:os";
import {
  readBootstrapLogTail,
  readBootstrapMarkers,
  type BootstrapLogEntry,
  type BootstrapPhase,
} from "../host/bootstrap-log";
import {
  maybeAutoBootstrap,
  type AutoBootstrapDecision,
} from "../host/auto-bootstrap";
import {
  readHostPidMetadata,
  type HostPidMetadata,
} from "../host/pid-metadata";
import { bootstrapLogPath } from "../store/paths";
import { isProcessAlive } from "../store/cli-lock";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { RuntimeContext } from "../runner/runtime";

const BOOTSTRAP_LOG_TAIL_LINES = 80;
const RECENT_ACTIVITY_ROWS = 6;

interface HostStatusOutput {
  readonly running: boolean;
  readonly pidMetadata: HostPidMetadata | null;
  readonly bootstrapMarkers: readonly BootstrapLogEntry[];
  readonly bootstrapLogPath: string;
  readonly bootstrapLogTail: string;
  readonly bootstrap: AutoBootstrapDecision;
}

// Runner-aware `traycer host status`. Wires Core Flow 7 auto-bootstrap
// behind the existing structured payload so a first run on a clean
// machine triggers `installHost` + service registration, then proceeds
// to read pid metadata, bootstrap markers, and the log tail.
//
// `--no-bootstrap`, `CI=1`, `TRAYCER_NONINTERACTIVE=1` cause bootstrap
// to be skipped with a structured `bootstrap` field on the payload; the
// remainder of the status output (`pidMetadata`, `bootstrapMarkers`,
// `bootstrapLogTail`) is rendered unchanged.
//
// JSON mode emits the runner's NDJSON envelope; the legacy `--json`
// pretty-print is replaced by the runner's `{ type:"result", status:"ok",
// data: ... }` line so Desktop can parse it through `runTraycerCliJson`.
// Free-form human text is never mixed into the JSON stream.
export const hostStatusCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const bootstrap = await maybeAutoBootstrap({
    runtime: ctx.runtime,
    trigger: "host-status",
    onProgress: (info) => ctx.progress(info),
  });

  const pidMetadata = await readHostPidMetadata(ctx.runtime.environment);
  const markers = await readBootstrapMarkers(ctx.runtime.environment, 20);
  const bootstrapLogTail = await readBootstrapLogTail(
    ctx.runtime.environment,
    BOOTSTRAP_LOG_TAIL_LINES,
  );

  const output: HostStatusOutput = {
    // `running` must reflect process liveness, not merely the presence of a
    // pid.json - a stopped/crashed host can leave a stale record behind.
    // (service status already checks isProcessAlive; this keeps host
    // status consistent and makes `host stop` observable.)
    running: pidMetadata !== null && isProcessAlive(pidMetadata.pid),
    pidMetadata,
    bootstrapMarkers: markers,
    bootstrapLogPath: bootstrapLogPath(ctx.runtime.environment),
    bootstrapLogTail,
    bootstrap,
  };

  return {
    data: output,
    human: renderHumanStatus(output, ctx.runtime),
    exitCode: 0,
  };
};

// ---------------------------------------------------------------- formatting

// ANSI color resolution is per-call (not module-load) so the runner's
// `--json` mode can force-disable colors even on a TTY: JSON-mode
// callers consume `result.data` and never see the human text, but a
// future caller that mixes both must never get ANSI codes leaked into a
// machine-readable payload. `NO_COLOR` (env) and a non-TTY stdout
// continue to suppress colors as before.
function shouldUseColor(runtime: RuntimeContext): boolean {
  if (runtime.json) return false;
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

interface Colorizer {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

function makeColorizer(useColor: boolean): Colorizer {
  const wrap = (s: string, code: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    bold: (s) => wrap(s, "1"),
    dim: (s) => wrap(s, "2"),
    green: (s) => wrap(s, "32"),
    red: (s) => wrap(s, "31"),
    yellow: (s) => wrap(s, "33"),
    cyan: (s) => wrap(s, "36"),
    gray: (s) => wrap(s, "90"),
  };
}

function renderHumanStatus(
  output: HostStatusOutput,
  runtime: RuntimeContext,
): string {
  const c = makeColorizer(shouldUseColor(runtime));
  const lines: string[] = [];
  const home = homedir();
  const tildePath = (p: string) =>
    p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

  if (output.running && output.pidMetadata !== null) {
    const m = output.pidMetadata;
    lines.push(`${c.green("●")} ${c.bold("Traycer host is running")}`);
    lines.push("");
    lines.push(
      ...kvBlock(c, [
        ["PID", String(m.pid)],
        ["Version", m.version],
        ["WebSocket", m.websocketUrl],
        ["Started", formatStartedAt(m.startedAt, c)],
        ["Host ID", m.hostId],
        ["Log", tildePath(output.bootstrapLogPath)],
      ]),
    );
  } else {
    const last = output.bootstrapMarkers.at(-1);
    lines.push(`${c.gray("○")} ${c.bold("Traycer host is not running")}`);
    lines.push("");
    const rows: [string, string][] = [
      ["Log", tildePath(output.bootstrapLogPath)],
    ];
    // A non-null pidMetadata with a dead pid means the host exited
    // (e.g. after `host stop` or a crash) but its pid.json was left
    // behind. Surface it as stale rather than silently reporting
    // "running" off a dead record.
    if (output.pidMetadata !== null) {
      rows.push(["Stale pid", `${output.pidMetadata.pid} (not alive)`]);
    }
    if (last !== undefined) {
      rows.push(["Last phase", phaseLabel(last, c)]);
      rows.push(["Last seen", formatStartedAt(last.timestamp, c)]);
    }
    lines.push(...kvBlock(c, rows));
  }

  const bootstrapLine = renderBootstrapLine(output.bootstrap, c);
  if (bootstrapLine !== null) {
    lines.push("");
    lines.push(bootstrapLine);
  }

  const recent = output.bootstrapMarkers.slice(-RECENT_ACTIVITY_ROWS).reverse();
  if (recent.length > 0) {
    lines.push("");
    lines.push(c.bold("Recent activity"));
    for (const entry of recent) {
      lines.push(`  ${formatActivityRow(entry, c)}`);
    }
  }

  lines.push("");
  lines.push(c.dim("Run with --json for the full structured payload."));
  return lines.join("\n");
}

function renderBootstrapLine(
  decision: AutoBootstrapDecision,
  c: Colorizer,
): string | null {
  switch (decision.status) {
    case "ready":
      return null;
    case "installed":
      if (decision.reason === "service-registration-warning") {
        return `${c.yellow("⚠")} bootstrap: installed host ${decision.installedVersion ?? ""}, service registration warning - ${decision.postSwapError ?? ""}`.trim();
      }
      return `${c.green("✓")} bootstrap: installed host ${decision.installedVersion ?? ""}`.trim();
    case "service-registered":
      return `${c.green("✓")} bootstrap: registered OS service for installed host ${decision.installedVersion ?? ""} (no download)`.trim();
    case "skipped":
      if (decision.reason === "explicit-no-bootstrap") {
        return c.dim("bootstrap: skipped (--no-bootstrap)");
      }
      return c.dim(
        "bootstrap: skipped (non-interactive - CI=1 or TRAYCER_NONINTERACTIVE=1)",
      );
    case "failed":
      if (decision.reason === "service-registration-failed") {
        return `${c.red("✗")} bootstrap: OS service registration failed - ${decision.error?.message ?? ""} [${decision.error?.code ?? "?"}]`;
      }
      return `${c.red("✗")} bootstrap: failed - ${decision.error?.message ?? ""} [${decision.error?.code ?? "?"}]`;
  }
}

function kvBlock(c: Colorizer, rows: readonly [string, string][]): string[] {
  const keyWidth = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `  ${c.dim(k.padEnd(keyWidth))}  ${v}`);
}

function formatStartedAt(iso: string, c: Colorizer): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const absolute = parsed.toISOString().replace("T", " ").replace(/\..+$/, "Z");
  const rel = formatRelative(parsed);
  return rel === null ? absolute : `${absolute} ${c.dim(`(${rel})`)}`;
}

function formatRelative(then: Date): string | null {
  const diffMs = Date.now() - then.getTime();
  if (!Number.isFinite(diffMs)) return null;
  const sec = Math.round(diffMs / 1000);
  if (sec < 0) return null;
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} d ago`;
}

function formatActivityRow(entry: BootstrapLogEntry, c: Colorizer): string {
  const time = formatShortTime(entry.timestamp);
  const phase = formatPhase(entry.phase, c);
  const detail = formatPhaseDetail(entry);
  const detailPart = detail === "" ? "" : `  ${c.dim(detail)}`;
  return `${c.gray(time)}  ${phase}${detailPart}`;
}

function formatShortTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(11, 19);
}

function formatPhase(phase: BootstrapPhase, c: Colorizer): string {
  const padded = phase.padEnd(8);
  switch (phase) {
    case "starting":
      return c.cyan(padded);
    case "exited":
      return c.gray(padded);
    case "crashed":
    case "failed-to-spawn":
      return c.red(padded);
    case "killed":
      return c.yellow(padded);
    default:
      return padded;
  }
}

function phaseLabel(entry: BootstrapLogEntry, c: Colorizer): string {
  const phase = formatPhase(entry.phase, c).trim();
  const detail = formatPhaseDetail(entry);
  return detail === "" ? phase : `${phase} (${detail})`;
}

function formatPhaseDetail(entry: BootstrapLogEntry): string {
  const f = entry.fields;
  const parts: string[] = [];
  if (f.code !== undefined && f.code !== "") parts.push(`code=${f.code}`);
  if (f.signal !== undefined && f.signal !== "")
    parts.push(`signal=${f.signal}`);
  if (f.error !== undefined && f.error !== "") parts.push(`error=${f.error}`);
  return parts.join(" ");
}
