import type {
  LaunchctlPrintProbe,
  LaunchdRunState,
  WedgeReason,
  WedgeVerdict,
} from "./types";

/**
 * Positive wedge predicate derived from the same print bytes as ownership
 * (annex §1.3). Used by planner arms — not a fourth ownership kind.
 */
export function deriveWedgeVerdict(
  print: LaunchctlPrintProbe,
  options: {
    readonly loginItemEnabled: boolean | null;
    readonly hasPidMetadata: boolean;
    readonly hasAttemptProgress: boolean;
  },
): WedgeVerdict {
  if (print.kind === "indeterminate") {
    return { kind: "indeterminate", cause: print.cause };
  }
  if (print.kind === "absent") {
    return {
      kind: "healthy-or-unknown",
      note: "label not loaded — no wedge applicable",
    };
  }

  const reasons: WedgeReason[] = [];
  const run = print.runState;

  if (isSpawnFailedJobState(run)) {
    reasons.push("job-state-spawn-failed");
  }
  if (isExConfigLastExit(run)) {
    reasons.push("last-exit-ex-config-78");
  }
  if (run.lwcr.kind === "observed" && run.lwcr.markers.length > 0) {
    reasons.push("lwcr-mismatch-markers");
  }
  if (
    options.loginItemEnabled === true &&
    !options.hasPidMetadata &&
    !options.hasAttemptProgress &&
    !hasLivePid(run)
  ) {
    reasons.push("loaded-but-no-live-pid-and-no-attempt-progress");
  }

  if (reasons.length === 0) {
    return {
      kind: "healthy-or-unknown",
      note: "loaded with no positive wedge markers",
    };
  }
  return { kind: "wedged", reasons };
}

function isSpawnFailedJobState(run: LaunchdRunState): boolean {
  if (run.jobState.kind !== "observed") return false;
  const s = run.jobState.value.toLowerCase();
  return s.includes("spawn failed") || s === "spawnfailed";
}

/**
 * `EX_CONFIG` (78) wedge evidence — annex "Loaded-but-dead wedge evidence":
 * matched on the **exit-reason field**, not a bare `"config"` substring.
 *
 * The previous predicate was `r.includes("ex_config") || r.includes("config")`.
 * The first term is subsumed by the second, and bare `"config"` is far too
 * loose for a signal that routes to a destructive transition — the field is
 * free text that can name a configuration daemon, a config path, or a
 * jetsam reason mentioning configuration. Sampling every live job on a
 * healthy Mac, the real values are `JETSAM_REASON_MEMORY_IDLE_EXIT` and
 * `JETSAM_REASON_MEMORY_PERPROCESSLIMIT`, so today's exposure is low — that
 * is luck, not a guard.
 */
function isExConfigLastExit(run: LaunchdRunState): boolean {
  if (run.lastExitCode.kind === "observed" && run.lastExitCode.value === 78) {
    return true;
  }
  if (run.lastExitReason.kind === "observed") {
    return /\bex_config\b/i.test(run.lastExitReason.value);
  }
  return false;
}

function hasLivePid(run: LaunchdRunState): boolean {
  return run.pid.kind === "observed" && run.pid.value > 0;
}
