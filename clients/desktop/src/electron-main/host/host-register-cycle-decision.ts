import type { HostPendingRevisionState } from "@traycer-clients/shared/platform/runner-host";
import type { Environment } from "./host-paths";

// The executable register-cycle state machine (Finding F). Evaluated in full
// INSIDE the registration lock immediately before bootout, via the
// `revalidateBeforeBootout` seam — because a caller's idle/busy check taken at
// its entry point can go stale while queued behind another in-flight cycle
// (`respawnHost` and `runEnsureHost` share the lock).
//
// Governing invariant: the SMAppService register cycle runs iff a definition
// change must be applied, OR no viable current-generation agent spawn exists.
//
//   needCycle := force ∨ definitionChange ∨ noViableAgentSpawn
//   if needCycle ∧ busy ∧ ¬force:
//       persist the pending-cycle marker — for EVERY cause
//       persisted   → defer-busy(cause)          (durable disk marker)
//       write FAILS → defer-busy-unpersisted(cause)  (in-memory flag; monitor
//                     drives it this launch; cross-launch durability is lost
//                     but surfaced, never silent)
//   if needCycle → cycle
//   else         → skip-join   (a viable agent spawn exists; join its readiness)
//
// definitionChange := CLI payload `action === "installed"` (the transition, not
// the presence flag) ∨ pending-revision marker ∨ registration-stamp mismatch ∨
// the in-memory pending-cycle flag.
//
// noViableAgentSpawn := no live pid under the agent label. On darwin the ONLY
// evidence that authorizes a skip is `launchctl print gui/<uid>/<agent-label>`:
// bootstrap markers are forgeable (legacy + agent labels share a log), so a
// null agent pid is `noViableAgentSpawn` regardless of any marker.
//
// removed-by-user and requires-approval are absolute and outrank `force`, but
// are enforced by the surrounding call sites (the removed sentinel check at the
// top of `registerHostLoginItemUnserialized`, and the pre-flight / post-cycle
// approval checks in the ensure paths — which correctly let a clean install
// with nothing running cycle anyway). This machine covers cycle / skip-join /
// defer only.

export type RegisterCycleDecision =
  | { readonly kind: "cycle"; readonly causes: ReadonlyArray<string> }
  | { readonly kind: "skip-join" }
  | { readonly kind: "defer-busy"; readonly cause: string }
  | {
      readonly kind: "defer-busy-unpersisted";
      readonly cause: string;
      readonly error: string | null;
    };

export interface RegisterCycleDecisionInputs {
  readonly force: boolean;
  readonly environment: Environment;
  readonly agentLabel: string;
  /** The desktop build identity (`config.version`) for the stamp comparison. */
  readonly identity: string;
  /** CLI ensure payload `action === "installed"` — false on the fast path. */
  readonly cliActionInstalled: boolean;

  // Seams (production passes the real module functions; tests inject stubs).
  /** `launchctl print` agent-label pid — the sole darwin viable-spawn authority. */
  readonly readAgentLabelPid: (agentLabel: string) => Promise<number | null>;
  readonly hasPendingRevisionMarker: (
    environment: Environment,
  ) => Promise<boolean>;
  readonly isPendingCycleFlagSet: (environment: Environment) => boolean;
  readonly registrationStampMatches: (
    environment: Environment,
    identity: string,
  ) => Promise<boolean>;
  /** In-launch applied latch — suppresses the stamp-mismatch cause only. */
  readonly isRegistrationIdentityApplied: (identity: string) => boolean;
  /** Whether the (still-running) host currently has work in progress. */
  readonly probeBusy: () => Promise<boolean>;
  /** The centralized retrying marker writer (T4); its result carries durability. */
  readonly persistPendingCycle: (
    environment: Environment,
    cause: string,
  ) => Promise<HostPendingRevisionState>;
}

async function collectDefinitionChangeCauses(
  inputs: RegisterCycleDecisionInputs,
): Promise<string[]> {
  const causes: string[] = [];
  // Cheap synchronous causes first.
  if (inputs.cliActionInstalled) causes.push("action-installed");
  if (inputs.isPendingCycleFlagSet(inputs.environment)) {
    causes.push("pending-flag");
  }
  if (await inputs.hasPendingRevisionMarker(inputs.environment)) {
    causes.push("pending-marker");
  }
  // The applied latch suppresses ONLY the stamp-mismatch reason for this launch.
  if (
    !inputs.isRegistrationIdentityApplied(inputs.identity) &&
    !(await inputs.registrationStampMatches(
      inputs.environment,
      inputs.identity,
    ))
  ) {
    causes.push("stamp-mismatch");
  }
  return causes;
}

export async function evaluateRegisterCycleDecision(
  inputs: RegisterCycleDecisionInputs,
): Promise<RegisterCycleDecision> {
  const causes = await collectDefinitionChangeCauses(inputs);
  // A null agent-label pid is the ONLY darwin skip authority — no marker can
  // stand in for it.
  const noViableAgentSpawn =
    (await inputs.readAgentLabelPid(inputs.agentLabel)) === null;
  const allCauses = noViableAgentSpawn ? [...causes, "no-agent-spawn"] : causes;
  const needCycle = inputs.force || allCauses.length > 0;

  if (!needCycle) {
    // Nothing to apply and a viable current-generation spawn exists.
    return { kind: "skip-join" };
  }

  // `force` overrides busy, version, and spawn evidence — it never defers.
  if (!inputs.force && (await inputs.probeBusy())) {
    const cause = allCauses.join(",");
    // Persist for EVERY cause (the marker is the only durable wake-up for the
    // deferred repair — including the no-agent-repair case).
    const persisted = await inputs.persistPendingCycle(
      inputs.environment,
      cause,
    );
    if (persisted.durable) {
      return { kind: "defer-busy", cause };
    }
    // The write failed; `persistPendingCycle` has set the in-memory
    // pending-cycle flag (itself a definitionChange cause), so a later ensure
    // this launch still reads needCycle. The 30s monitor applies at idle.
    return { kind: "defer-busy-unpersisted", cause, error: persisted.error };
  }

  return { kind: "cycle", causes: allCauses };
}
