// Single source of truth for the V8 flags the long-running host process must
// be created with. Applied at the host's creation time, where it is honored:
//   - `host-start.ts` appends it to the spawned host's NODE_OPTIONS. This is
//     the ONE cross-platform launch path (launchd, systemd-user, and the Windows
//     Scheduled Task all run `traycer host start`, which spawns the host), so
//     it gives Linux and Windows the same cap as macOS - Task Scheduler XML
//     cannot set env vars, and a systemd unit would need its own duplicate.
//   - the macOS LaunchAgent plist also sets NODE_OPTIONS directly (see
//     `platforms/macos.ts`); the append above is a no-op there because the host
//     inherits that value via `process.env` and `withHostNodeOptions` collapses
//     the duplicate to the single canonical cap.
//
// `--max-semi-space-size=64` caps V8's young generation. Left uncapped, V8
// sizes the scavenge space for throughput on a host with a large heap limit and
// lets `new_space` reach ~64 MB idle / ~128 MB under churn - reserved,
// mostly-empty space that still counts as RSS. This MUST be a creation-time
// flag: a runtime `v8.setFlagsFromString` does NOT cap `new_space`.
//
// ## Why 64 and not the 16 this shipped with
//
// A trade, deliberately taken in both directions. 16 MB is what kept idle RSS
// small, and that was the whole point of capping at all. The other side of it
// showed up in a memory profile of a long-lived host: the parse and fold bursts
// this process is built out of allocate TENS OF MEGABYTES AT ONCE, and a burst
// larger than the semi-space cannot be scavenged - V8 promotes essentially all
// of it to old space, where it dies under mark-compact instead. Mark-compact of
// short-lived garbage is the expensive way to collect it, and GC was the
// dominant CPU consumer during churn (3.5% of CPU even in a quiet window).
//
// So the cap was not sized wrong for RSS; it was sized below the allocation
// bursts it had to survive, which converted a cheap collection into an
// expensive one. 64 MB is chosen to sit above those bursts. The cost is
// reserved young-generation RSS, which is why the number is not a guess:
//
// ## Measured on staging before it is trusted
//
// `ai.traycer.host.staging`, same long chat open at least an hour on each side:
// GC share of CPU (`PerformanceObserver` on `gc` entries, 120 s), footprint
// idle and under churn (`footprint -p`), and `new_space` size
// (`v8.getHeapSpaceStatistics()`).
//
// KILL CRITERION - revert to 16 if idle footprint rises by more than 150 MB
// with no GC-share gain, or if any host smoke that reads NODE_OPTIONS reddens.
// 128 is the next value to consider, and only if 64 measures well.
//
// Provider CLIs (codex/opencode/claude) are spawned from the user's SHELL env -
// NOT the host's process.env (see `getProviderSpawnEnv`) - so this never leaks
// into third-party binaries.
export const HOST_V8_FLAGS = "--max-semi-space-size=64";

// Diagnostic-report flags for the host process. `--report-on-fatalerror`
// makes Node write a JSON report on a V8 fatal (OOM and friends) - the class
// of abort that otherwise leaves nothing but `phase=crashed` in the log
// (0xC0000409 on Windows). All tokens are in Node's NODE_OPTIONS allowlist
// and space-free on purpose: the report directory is RELATIVE, resolved
// against the spawn cwd (the host data dir), so a Windows profile path with
// spaces never needs NODE_OPTIONS quoting - and a crash BEFORE the host's
// own runtime arming still lands in the exact directory the supervisor
// creates, prunes, and scans. The host entrypoint re-anchors the same
// `<cwd>/crash-reports` absolutely at boot; the two always agree because
// both derive from the spawn cwd.
export const HOST_DIAGNOSTIC_REPORT_FLAGS =
  "--report-on-fatalerror --report-compact --report-directory=crash-reports";

const HOST_APPENDED_FLAGS = `${HOST_V8_FLAGS} ${HOST_DIAGNOSTIC_REPORT_FLAGS}`;

// Value-taking flags this helper strips before appending the canonical set.
// Node's NODE_OPTIONS allowlist admits the four heap-limit families below.
// An inherited old-generation flag would override a Worker's
// resourceLimits.maxOldGenerationSizeMb, so none may reach the spawned host.
// The one deliberate exception is our own semi-space cap, re-appended below:
// it overrides workers' young-generation limit, not their old-generation cap.
//
// The strip MUST be quote-aware and MUST cover the space-separated form:
// some NODE_OPTIONS flags accept `--flag value` as well as `--flag=value`, and values
// may be double-quoted (`--report-directory="/path with spaces"`). Removing
// only the flag leaves the VALUE behind as a bare token, and Node rejects the
// whole of NODE_OPTIONS on an unrecognized token - so the host never starts
// at all. That is the worst failure a diagnostics change can ship.
//
// So the strip works on Node's own TOKENS, never on the raw text: a text match
// also fires inside another option's quoted value, and
// `--require="./my --max-old-space-size=4096 module.js"` then loads a module
// that does not exist. See `tokenizeNodeOptions`.
const VALUE_FLAGS_OWNED = [
  "--max-old-space-size",
  "--max-old-space-size-percentage",
  "--max-heap-size",
  "--max-semi-space-size",
  "--report-directory",
  // Not appended by us, but stripped: an inherited constant report filename
  // makes every crash overwrite one file, which defeats the supervisor's
  // "report newer than this child, and not one that pre-existed it" scan
  // (and a non-`.json` name makes the scan ignore reports entirely).
  "--report-filename",
] as const;

/** Boolean flags this helper appends; stripped so they cannot duplicate. */
const BOOLEAN_FLAGS_OWNED = [
  "--report-on-fatalerror",
  "--report-compact",
] as const;

const OWNED_VALUE_FLAGS: ReadonlySet<string> = new Set(VALUE_FLAGS_OWNED);
const OWNED_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(BOOLEAN_FLAGS_OWNED);

/** One NODE_OPTIONS token: as written, and as Node reads it. */
interface NodeOptionsToken {
  /** The token's text exactly as written, quotes and escapes included. */
  readonly raw: string;
  /** The argument Node passes on: quotes removed, escapes applied. */
  readonly value: string;
}

// Splits NODE_OPTIONS exactly as Node does (`ParseNodeOptionsEnvVar` in
// `src/node_options.cc`), measured on Node 24.20:
//   - only a SPACE outside double quotes separates tokens; a tab is part of
//     the token (`--title=a<TAB>--trace-warnings` sets that whole title);
//   - a double quote opens or closes a quoted run and is not itself part of
//     the argument, so `"--title=q r"` and `--title="q r"` both read `q r`;
//   - inside a quoted run a backslash escapes the next character;
//   - single quotes are ordinary characters (`--title='a b'` reads `'a`);
//   - quotes alone start no argument (`""` between spaces is nothing).
// Each token keeps its raw text so a token that survives the strip is passed
// on byte for byte.
function tokenizeNodeOptions(options: string): NodeOptionsToken[] {
  const tokens: NodeOptionsToken[] = [];
  let raw = "";
  let value = "";
  let started = false;
  let quoted = false;
  const flush = (): void => {
    if (started) tokens.push({ raw, value });
    raw = "";
    value = "";
    started = false;
  };
  for (let index = 0; index < options.length; index += 1) {
    const char = options[index];
    if (quoted && char === "\\" && index + 1 < options.length) {
      raw += char + options[index + 1];
      value += options[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      raw += char;
      continue;
    }
    if (char === " " && !quoted) {
      flush();
      continue;
    }
    raw += char;
    value += char;
    started = true;
  }
  flush();
  return tokens;
}

// The option a token names: the part before `=`, with `_` read as `-` the way
// Node reads option names (the value keeps its underscores).
function optionName(value: string): string {
  const equals = value.indexOf("=");
  const name = equals === -1 ? value : value.slice(0, equals);
  return name.replaceAll("_", "-");
}

// Appends the host's required creation-time flags to an inherited
// NODE_OPTIONS value, after stripping heap-limit overrides and every token
// this helper owns. The host always lands on the canonical set whether the
// inherited value is the macOS plist's identical copy (a true no-op) or
// something an operator set in their shell. Unrelated operator tokens survive
// verbatim, including every character inside their quoted values.
export function withHostNodeOptions(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return HOST_APPENDED_FLAGS;
  }
  const tokens = tokenizeNodeOptions(existing);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const name = optionName(token.value);
    if (OWNED_BOOLEAN_FLAGS.has(name)) continue;
    if (!OWNED_VALUE_FLAGS.has(name)) {
      kept.push(token.raw);
      continue;
    }
    // `--flag=value` carries its value. `--flag value` takes the next token
    // with it - unless that token is itself an option, so a value-less flag
    // cannot eat its neighbor.
    const next = tokens[index + 1];
    if (
      !token.value.includes("=") &&
      next !== undefined &&
      !next.value.startsWith("--")
    ) {
      index += 1;
    }
  }
  return kept.length > 0
    ? `${kept.join(" ")} ${HOST_APPENDED_FLAGS}`
    : HOST_APPENDED_FLAGS;
}
