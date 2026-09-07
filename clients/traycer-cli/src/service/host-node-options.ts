// Single source of V8 flags for the long-running host. Service units and `host start` must not drift.
export const HOST_V8_FLAGS = "--max-semi-space-size=16";

// Diagnostic-report flags for the host process.
// `--report-on-fatalerror` makes Node write a JSON report on a V8 fatal (OOM and friends) - the class of abort that otherwise leaves nothing but `phase=crashed` in the log (0xC0000409 on Windows).
export const HOST_DIAGNOSTIC_REPORT_FLAGS =
  "--report-on-fatalerror --report-compact --report-directory=crash-reports";

const HOST_APPENDED_FLAGS = `${HOST_V8_FLAGS} ${HOST_DIAGNOSTIC_REPORT_FLAGS}`;

// Value-taking flags this helper canonically owns.
// Each is stripped from the inherited value before the canonical set is appended.
const VALUE_FLAGS_OWNED = [
  "--max-semi-space-size",
  "--report-directory",
  // Not appended by us, but stripped: an inherited constant report filename makes every crash overwrite one file, which defeats the supervisor's "report newer than this child, and not one that pre-existed it" scan (and a non-`.json` name makes the scan ignore reports entirely).
  "--report-filename",
] as const;

/** Boolean flags this helper appends; stripped so they cannot duplicate. */
const BOOLEAN_FLAGS_OWNED = [
  "--report-on-fatalerror",
  "--report-compact",
] as const;

// `--flag`, optionally followed by `=value` or ` value`, where value may be quoted.
// The space-separated arm refuses to swallow a following `--flag`, so a malformed value-less token cannot eat its neighbor.
function valueFlagPattern(flag: string): RegExp {
  return new RegExp(
    `(^|\\s)${flag}(?:=(?:"[^"]*"|\\S+)|\\s+(?:"[^"]*"|(?!--)\\S+))?(?=\\s|$)`,
    "g",
  );
}

// Appends the host's required creation-time flags to an inherited NODE_OPTIONS value, after stripping every token this helper owns - so the host always lands on the canonical set whether the inherited value is the macOS plist's identical copy (a true no-op) or something an operator set in their shell that would silently defeat or duplicate it.
// Unrelated operator tokens are preserved.
export function withHostNodeOptions(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return HOST_APPENDED_FLAGS;
  }
  let stripped = existing;
  for (const flag of VALUE_FLAGS_OWNED) {
    stripped = stripped.replace(valueFlagPattern(flag), " ");
  }
  for (const flag of BOOLEAN_FLAGS_OWNED) {
    stripped = stripped.replace(
      new RegExp(`(^|\\s)${flag}(?=\\s|$)`, "g"),
      " ",
    );
  }
  stripped = stripped.trim().replace(/\s+/g, " ");
  return stripped.length > 0
    ? `${stripped} ${HOST_APPENDED_FLAGS}`
    : HOST_APPENDED_FLAGS;
}
