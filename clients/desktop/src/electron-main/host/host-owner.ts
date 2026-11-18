import { readFile } from "node:fs/promises";
import {
  decodeSubstrateRecord,
  decodeTransitionJournal,
  isTerminalPhase,
  type DurableBytes,
} from "@traycer-clients/shared/host-lifecycle";
import type { HostFsLayout } from "./host-paths";

// Composite current-owner projection for the host's service registration
// (Host update technical plan §3.1; authority/transport synthesis,
// "Packaged-mac ownership and execution").
//
// The question this answers is "who owns launchd for this host RIGHT NOW",
// and the reason it needs its own module is that the predicate the desktop
// has always used - `hostManagesHostLoginItem()` - answers a DIFFERENT
// question: "can this Desktop build register a login item at all" (darwin,
// not dev, in-bundle plist present). That is a capability of the build, and
// it stays true on a machine where the CLI owns a raw LaunchAgent. Reading
// capability as ownership is exactly the dual-registration bug
// `inspectLaunchdOwnership` exists to prevent, and it is why persisting
// `--no-service-register` was rejected as the owner fact.
//
// Nothing here mutates. The backfill writer lives in `update-mutation.ts`
// behind a live attempt capability, with the other destructive edges.

export type HostServiceSubstrate = "smappservice" | "raw-fallback";

/**
 * Why the projection could not name an owner.
 *
 * `unknown` is a real, supported, fail-closed state - never a synonym for
 * `raw-fallback`. A genuinely raw-owned Darwin host must complete an attested
 * takeover before anything activates on its behalf; it cannot be inferred
 * from Desktop's absence or from a missing record.
 */
export type HostServiceOwnerUnknownCause =
  /** A takeover is journaled as in flight. Neither substrate is authoritative. */
  | "transition-in-flight"
  /** The journal exists but does not decode. Ambiguity, not absence. */
  | "transition-record-faulted"
  /** No durable owner has ever been committed on this machine. */
  | "substrate-absent"
  /** The record is corrupt, unreadable, or a version this build cannot act on. */
  | "substrate-record-faulted"
  /** A live label and the durable record name different owners. */
  | "label-substrate-contradiction";

export type HostServiceOwner =
  | {
      readonly kind: "owned";
      readonly substrate: HostServiceSubstrate;
      /** Which leg of the precedence produced it - diagnostics, not policy. */
      readonly from: "service-label" | "substrate";
    }
  | { readonly kind: "unknown"; readonly cause: HostServiceOwnerUnknownCause };

/**
 * The service label the RUNNING host inherited from its launchd job.
 *
 * ## Why this is an input rather than a `process.env` read
 *
 * The plan's second precedence leg is the inherited `XPC_SERVICE_NAME`. That
 * variable belongs to the HOST's launchd job - launchd sets it for the
 * process it spawns. Desktop is started by the user from `/Applications`, so
 * its own environment carries nothing about the host's job, and reading
 * `process.env.XPC_SERVICE_NAME` here would be reading Desktop's own launch
 * context and calling it the host's owner.
 *
 * Making the host's observed label available is therefore a host-published
 * fact, not something Desktop can derive. Until that fact exists this leg is
 * `unavailable` in production, and the projection falls through to the
 * durable substrate - which is safe by construction, because every fallthrough
 * path ends in `substrate` or `unknown` and never in `raw-fallback` by guess.
 *
 * `launchctl print` is deliberately NOT wired in as a substitute: it is
 * point-in-time corroboration, and a login item the user toggled off reads
 * `not-loaded` while SMAppService still owns the BTM record. Using it as
 * authority would flip the owner on a disable and let the CLI bootstrap a
 * second job.
 */
export type ObservedHostServiceLabel =
  | { readonly kind: "unavailable" }
  | { readonly kind: "observed"; readonly label: string };

export interface HostServiceOwnerLabels {
  /** The CLI/raw LaunchAgent label, e.g. `ai.traycer.host`. */
  readonly cliLabelId: string;
  /** The SMAppService agent label, e.g. `ai.traycer.host.agent`. */
  readonly agentLabelId: string;
}

export interface HostServiceOwnerEvidence {
  readonly transition: DurableBytes;
  readonly substrate: DurableBytes;
  readonly observedLabel: ObservedHostServiceLabel;
  readonly labels: HostServiceOwnerLabels;
}

/**
 * The precedence, pure and total (plan §3.1):
 *
 *   1. active registration/takeover transition -> unknown (veto);
 *   2. inherited service label recognised as the agent or raw label;
 *   3. durable `substrate.json`, corroborating or standing alone;
 *   4. contradiction, corruption, or unresolved absence -> unknown.
 *
 * Clock-free and filesystem-free so the whole matrix is exhaustively
 * testable without a temp tree.
 */
export function projectHostServiceOwner(
  evidence: HostServiceOwnerEvidence,
): HostServiceOwner {
  // ---- 1. Transition veto - only while a transition is actually IN FLIGHT.
  //
  // The invariant, from the transition model's author: *persisted history never
  // grants ownership by itself, but completed history also never permanently
  // blocks ownership; only an in-flight transition vetoes.*
  //
  // This used to veto on ANY decodable journal, on the reasoning that the
  // world-probe projection drops `terminal` so a settled journal is
  // indistinguishable from a live one. That reasoning was wrong in its premise
  // and catastrophic in its consequence:
  //
  //  - Wrong premise: `terminal` is dropped, but `phase` is NOT, and the phase
  //    vocabulary names its own terminals (`done`, `failed`, `compensated`).
  //    The distinction was available the whole time.
  //  - Consequence: terminal journals are RETAINED as durable audit history
  //    and `TransitionJournalStore` has no removal operation. So one completed
  //    fallback or reclaim vetoed the packaged-mac owner FOREVER - every later
  //    launch read the same terminal journal and refused. The old comment's
  //    consolation, that Desktop resolves this on its next healthy launch, was
  //    false: the substrate backfill defers on the identical cause, so the
  //    machine was excluded until some unrelated writer happened to overwrite
  //    the journal.
  //
  // "Over-vetoing is the recoverable direction" holds only for a veto that
  // something can later clear. A permanent one is not the safe side of the
  // trade - it is the unrecoverable side wearing the safe side's argument.
  const transition = decodeTransitionJournal(evidence.transition);
  if (transition.kind === "valid") {
    // A settled journal is history: it falls through to the live label and
    // durable substrate below, which are the current-ownership evidence.
    // The CANONICAL classifier, consumed rather than duplicated. It is an
    // exhaustive switch with a `never` guard, and the decoder now rejects an
    // unrecognized phase outright - so a new terminal phase upstream breaks
    // the build at the one place the decision belongs, instead of silently
    // reclassifying retained journals as in-flight and re-creating the
    // permanent ownership veto. (T3 attempt-core seat's ruling; their surface,
    // their sign-off.)
    if (!isTerminalPhase(transition.value.phase)) {
      return { kind: "unknown", cause: "transition-in-flight" };
    }
  } else if (transition.kind !== "absent") {
    // Unreadable or version-rejected stays FAIL-CLOSED. An undecodable journal
    // could be an in-flight one we cannot parse, and that is the case where
    // guessing is genuinely unsafe.
    return { kind: "unknown", cause: "transition-record-faulted" };
  }

  // ---- 2. The live inherited label, when the host has published one.
  const labelled = substrateForLabel(evidence.observedLabel, evidence.labels);

  // ---- 3. The durable record.
  const substrate = decodeSubstrateRecord(evidence.substrate);
  const recorded = substrate.kind === "valid" ? substrate.value.active : null;

  if (labelled !== null) {
    // A live label that the durable record contradicts is the one case the
    // plan singles out as unknown rather than "trust the fresher one". The
    // two disagreeing is evidence that a takeover happened without journaling
    // - precisely when guessing is least safe.
    if (recorded !== null && recorded !== labelled) {
      return { kind: "unknown", cause: "label-substrate-contradiction" };
    }
    return { kind: "owned", substrate: labelled, from: "service-label" };
  }

  if (recorded !== null) {
    return { kind: "owned", substrate: recorded, from: "substrate" };
  }

  // ---- 4. Unresolved.
  return {
    kind: "unknown",
    cause:
      substrate.kind === "absent"
        ? "substrate-absent"
        : "substrate-record-faulted",
  };
}

function substrateForLabel(
  observed: ObservedHostServiceLabel,
  labels: HostServiceOwnerLabels,
): HostServiceSubstrate | null {
  if (observed.kind !== "observed") return null;
  if (observed.label === labels.agentLabelId) return "smappservice";
  if (observed.label === labels.cliLabelId) return "raw-fallback";
  // An unrecognised label is not a contradiction - it is no evidence. Fall
  // through to the durable record rather than vetoing, so a future label
  // scheme cannot strand every machine on `unknown`.
  return null;
}

/**
 * Read the two durable records and project. `unavailable` is the production
 * value for the label leg - see {@link ObservedHostServiceLabel}.
 */
export async function readHostServiceOwner(
  layout: HostFsLayout,
  labels: HostServiceOwnerLabels,
  observedLabel: ObservedHostServiceLabel,
): Promise<HostServiceOwner> {
  const [transition, substrate] = await Promise.all([
    readDurableBytes(layout.transitionJournalFile),
    readDurableBytes(layout.substrateFile),
  ]);
  return projectHostServiceOwner({
    transition,
    substrate,
    observedLabel,
    labels,
  });
}

/**
 * Map a file read into the decoder's total input shape.
 *
 * `ENOENT` is the only error that means absence. Everything else - a
 * permission error, an EIO, a directory where a file belongs - is
 * `unreadable`, which the projection resolves to `unknown` rather than to
 * "no owner recorded". Collapsing those would turn an unreadable record into
 * a fresh-machine verdict.
 */
async function readDurableBytes(path: string): Promise<DurableBytes> {
  try {
    return { kind: "bytes", text: await readFile(path, "utf8") };
  } catch (err) {
    return errorCode(err) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", cause: errorCode(err) ?? "read-failed" };
  }
}

function errorCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const code = Reflect.get(err, "code");
  return typeof code === "string" ? code : null;
}
