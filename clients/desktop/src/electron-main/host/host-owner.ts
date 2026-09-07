import { readFile } from "node:fs/promises";
import {
  decodeSubstrateRecord,
  decodeTransitionJournal,
  isTerminalPhase,
  type DurableBytes,
} from "@traycer-clients/shared/host-lifecycle";
import type { HostFsLayout } from "./host-paths";

// That is a capability of the build, and it stays true on a machine where the CLI owns a raw LaunchAgent.

export type HostServiceSubstrate = "smappservice" | "raw-fallback";

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

/** The precedence, pure and total (plan §3.1): 1. active registration/takeover transition -> unknown (veto); 2. inherited service label recognised as the agent or raw label. */
export function projectHostServiceOwner(
  evidence: HostServiceOwnerEvidence,
): HostServiceOwner {
  // The invariant, from the transition model's author: *persisted history never grants ownership by itself, but completed history also never permanently blocks ownership.
  const transition = decodeTransitionJournal(evidence.transition);
  if (transition.kind === "valid") {
    if (!isTerminalPhase(transition.value.phase)) {
      return { kind: "unknown", cause: "transition-in-flight" };
    }
  } else if (transition.kind !== "absent") {
    // Unreadable or version-rejected stays FAIL-CLOSED. An undecodable journal
    // could be an in-flight one we cannot parse, and that is the case where
    // guessing is genuinely unsafe.
    return { kind: "unknown", cause: "transition-record-faulted" };
  }

  const labelled = substrateForLabel(evidence.observedLabel, evidence.labels);

  const substrate = decodeSubstrateRecord(evidence.substrate);
  const recorded = substrate.kind === "valid" ? substrate.value.active : null;

  if (labelled !== null) {
    if (recorded !== null && recorded !== labelled) {
      return { kind: "unknown", cause: "label-substrate-contradiction" };
    }
    return { kind: "owned", substrate: labelled, from: "service-label" };
  }

  if (recorded !== null) {
    return { kind: "owned", substrate: recorded, from: "substrate" };
  }

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
