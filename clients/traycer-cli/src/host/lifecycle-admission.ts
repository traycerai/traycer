import type { DesktopPresence } from "@traycer/protocol/config/desktop-presence";
import type {
  HostLifecycleMode,
  HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { Environment } from "../runner/environment";
import type { HostStartAdoptionConsumeResult } from "./host-start-adoption";
import {
  effectiveModeOf,
  type DesktopPresenceLiveness,
  type LifecycleRecordRead,
  type ObservedDesktopPresence,
} from "./lifecycle-files";

// The supervisor's start admission under the host lifecycle policy (lifecycle
// mechanics, "Start admission and run ownership").
//
// ONE question, asked once per supervisor, before its first attempt writes
// anything: may an UNATTENDED start run? Everything else runs:
//
// | Admission          | Policy mode        | Presence             | Result |
// | ------------------ | ------------------ | -------------------- | ------ |
// | grant (any origin) | any                | any                  | run    |
// | absent             | background         | any                  | run    |
// | absent             | any other          | alive                | run    |
// | absent             | any other          | indeterminate        | run    |
// | absent             | any other          | dead, or no record   | PARK   |
//
// "Absent" is the adoption proof's verdict, never `serviceStarted` and never
// the launcher's nonce: the launcher mints a nonce at every start, and
// `serviceStarted` is true for a desktop converge and a terminal `host ensure`
// just as for a login (critique round 1, R1). What an explicit start has and
// an unattended one lacks is a live parent's proof, consumed here.
//
// `indeterminate` runs because it is never evidence of death: a refused
// `tasklist` at login must not park the host of a desktop that is running.
//
// A start that is not a labelled service launch at all (a hand-run `traycer
// host start`, a reclaim probe, a legacy unlabelled launcher) never parks and
// never reads a file here.

/**
 * The park rule itself, for an `absent` admission of a service launch.
 * `presence` is `null` when there is no well-formed presence record.
 */
export function decideUnattendedStart(
  mode: HostLifecycleMode,
  presence: DesktopPresenceLiveness | null,
): "run" | "park" {
  if (mode === "background") return "run";
  if (presence === null || presence === "dead") return "park";
  return "run";
}

/** What the gate needs from the outside world; injected by `host start`. */
export interface SupervisorLifecycleGateDeps {
  readonly readPolicy: (
    environment: Environment,
  ) => Promise<LifecycleRecordRead<HostLifecyclePolicy>>;
  readonly readPresence: (
    environment: Environment,
  ) => Promise<LifecycleRecordRead<DesktopPresence>>;
  readonly probePresence: (
    presence: DesktopPresence,
  ) => Promise<DesktopPresenceLiveness>;
  readonly consumeAdoption: (
    environment: Environment,
    serviceLabel: string,
    adoptionNonce: string | null,
  ) => Promise<HostStartAdoptionConsumeResult>;
  readonly now: () => string;
}

export type SupervisorLifecycleGateInput = {
  readonly environment: Environment;
  /**
   * The labelled service launch this supervisor is, or `null` for every
   * start the policy never parks (see the header).
   */
  readonly serviceLaunch: {
    readonly serviceLabel: string;
    readonly adoptionNonce: string | null;
  } | null;
};

export type SupervisorLifecycleGate =
  | {
      readonly kind: "run";
      /**
       * The first attempt's adoption, when the gate had to consume it to
       * decide. The first admission MUST use this instead of consuming
       * again: a grant is one-shot, and it is held from here through the
       * spawn it acknowledges. `null` when the gate did not consume, and
       * the first admission consumes its own exactly as before.
       */
      readonly consumed: HostStartAdoptionConsumeResult | null;
      /** The presence the gate observed, for the run state; `null` if none. */
      readonly presence: ObservedDesktopPresence | null;
    }
  | { readonly kind: "park"; readonly mode: HostLifecycleMode };

/**
 * Decide whether this supervisor may run at all under the lifecycle policy.
 *
 * Byte-for-byte today's behaviour whenever the mode is Background, which is
 * every install without a policy file: one read of an absent file, and the
 * first attempt consumes its own adoption as it always did.
 *
 * Under any other mode the proof is consumed FIRST - before the presence probe,
 * which can take seconds on Windows - so an explicit start's grant is claimed
 * well inside its window and a slow probe can never let it expire into an
 * `absent` that parks it. Only a start that really is unattended pays for the
 * probe.
 */
export async function admitSupervisorLifecycle(
  input: SupervisorLifecycleGateInput,
  deps: SupervisorLifecycleGateDeps,
): Promise<SupervisorLifecycleGate> {
  if (input.serviceLaunch === null) {
    return { kind: "run", consumed: null, presence: null };
  }
  const mode = effectiveModeOf(await deps.readPolicy(input.environment));
  if (mode === "background") {
    return { kind: "run", consumed: null, presence: null };
  }
  const consumed = await deps.consumeAdoption(
    input.environment,
    input.serviceLaunch.serviceLabel,
    input.serviceLaunch.adoptionNonce,
  );
  // A grant runs whatever the policy says, and a proof that was refused,
  // lost or unreadable is not `absent` either: the park rule is not asked,
  // and the first admission meets that result exactly as it would have
  // without this gate (it refuses the spawn).
  if (consumed.kind !== "absent") {
    return { kind: "run", consumed, presence: null };
  }
  const presenceRead = await deps.readPresence(input.environment);
  const presence: ObservedDesktopPresence | null =
    presenceRead.kind === "valid"
      ? {
          pid: presenceRead.record.pid,
          onExit: presenceRead.record.onExit,
          liveness: await deps.probePresence(presenceRead.record),
          observedAt: deps.now(),
        }
      : null;
  const verdict = decideUnattendedStart(mode, presence?.liveness ?? null);
  return verdict === "park"
    ? { kind: "park", mode }
    : { kind: "run", consumed, presence };
}
