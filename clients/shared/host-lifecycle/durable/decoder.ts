import type { DurableRecord } from "../evidence";
import type {
  InstallRecord,
  PendingActivation,
  SubstrateRecord,
  TransitionGovernor,
  TransitionJournal,
} from "./records";
import {
  INSTALL_SUPPORTED_VERSIONS,
  PENDING_ACTIVATION_SUPPORTED_VERSIONS,
  SUBSTRATE_SUPPORTED_VERSIONS,
  TRANSITION_SUPPORTED_VERSIONS,
} from "./records";

/**
 * Input to a durable-record decoder. Callers map fs errors into this
 * shape so the decoder itself stays pure and total.
 */
export type DurableBytes =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "bytes"; readonly text: string };

type RecordParser<T> = (obj: Readonly<Record<string, unknown>>) => T | null;

/**
 * Generic total decoder: maps DurableBytes → DurableRecord<T> without
 * throwing. JSON parse failures and shape failures → `corrupt`.
 */
export function decodeDurableRecord<T>(
  input: DurableBytes,
  supportedVersions: readonly number[],
  parse: RecordParser<T>,
): DurableRecord<T> {
  if (input.kind === "missing") {
    return { kind: "absent" };
  }
  if (input.kind === "unreadable") {
    return { kind: "unreadable", cause: input.cause };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { kind: "corrupt" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }

  const obj = parsed as Record<string, unknown>;
  const versionRaw = obj.v ?? obj.version;
  if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw)) {
    return { kind: "corrupt" };
  }
  if (!supportedVersions.includes(versionRaw)) {
    return { kind: "unsupported-version", version: versionRaw };
  }

  const value = parse(obj);
  if (value === null) {
    return { kind: "corrupt" };
  }
  return { kind: "valid", value, version: versionRaw };
}

export function decodeSubstrateRecord(
  input: DurableBytes,
): DurableRecord<SubstrateRecord> {
  return decodeDurableRecord(input, SUBSTRATE_SUPPORTED_VERSIONS, (obj) => {
    const active = obj.active;
    if (active !== "smappservice" && active !== "raw-fallback") return null;
    if (typeof obj.since !== "string") return null;
    if (typeof obj.reason !== "string") return null;
    const attestation =
      obj.attestation === null || obj.attestation === undefined
        ? null
        : typeof obj.attestation === "string"
          ? obj.attestation
          : null;
    if (
      obj.attestation !== undefined &&
      obj.attestation !== null &&
      attestation === null
    ) {
      return null;
    }
    return {
      active,
      since: obj.since,
      reason: obj.reason,
      attestation,
    };
  });
}

/**
 * Decodes `transition.json` into the **T3 world-probe projection**
 * (`records.ts:TransitionJournal`) — NOT the full journal.
 *
 * The projection deliberately omits `kind`, `probeDeadlineAt` and `terminal`,
 * because the world probe does not need them. The CLI's probe-authority path
 * decides on exactly those three fields, so "just use the shared decoder" is
 * wrong there and would silently delete the `probeDeadlineAt` bound — it
 * reuses this module's total decoder and version gate with its own richer
 * parser instead (`traycer-cli/src/host/lifecycle-probe.ts`).
 *
 * Two shapes, one name: see also `transition/types.ts:LifecycleTransitionJournal`.
 * Widen this projection only if the world probe genuinely needs the field.
 */
export function decodeTransitionJournal(
  input: DurableBytes,
): DurableRecord<TransitionJournal> {
  return decodeDurableRecord(input, TRANSITION_SUPPORTED_VERSIONS, (obj) => {
    if (typeof obj.transitionId !== "string") return null;
    if (typeof obj.probeNonce !== "string") return null;
    if (obj.from !== "smappservice" && obj.from !== "raw-fallback") return null;
    if (obj.to !== "smappservice" && obj.to !== "raw-fallback") return null;
    if (typeof obj.phase !== "string") return null;
    if (typeof obj.startedAt !== "string") return null;
    if (!Array.isArray(obj.expectedIdentities)) return null;
    if (!obj.expectedIdentities.every((x) => typeof x === "string"))
      return null;
    const compensation =
      obj.compensation === null || obj.compensation === undefined
        ? null
        : typeof obj.compensation === "string"
          ? obj.compensation
          : null;
    if (
      obj.compensation !== undefined &&
      obj.compensation !== null &&
      compensation === null
    ) {
      return null;
    }
    const governor = parseGovernor(obj.governor);
    if (
      obj.governor !== undefined &&
      obj.governor !== null &&
      governor === null
    ) {
      return null;
    }
    return {
      transitionId: obj.transitionId,
      probeNonce: obj.probeNonce,
      from: obj.from,
      to: obj.to,
      phase: obj.phase,
      expectedIdentities: obj.expectedIdentities as readonly string[],
      compensation,
      startedAt: obj.startedAt,
      governor,
    };
  });
}

function parseGovernor(raw: unknown): TransitionGovernor | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.attemptCount !== "number") return null;
  return {
    lastAttemptedBuildId: stringOrNull(g.lastAttemptedBuildId),
    lastAttemptedCDHash: stringOrNull(g.lastAttemptedCDHash),
    failureClass: stringOrNull(g.failureClass),
    attemptCount: g.attemptCount,
    nextEligibleAt: stringOrNull(g.nextEligibleAt),
    breaker: stringOrNull(g.breaker),
    lastSustainedHealthAt: stringOrNull(g.lastSustainedHealthAt),
  };
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return null;
}

/**
 * Install records historically omit a top-level `v` and use a looser
 * shape. Accept either `{ v: 1, ... }` or a legacy object with `version`
 * + `installedAt` (synthesized as version 1).
 */
export function decodeInstallRecord(
  input: DurableBytes,
): DurableRecord<InstallRecord> {
  if (input.kind === "missing") return { kind: "absent" };
  if (input.kind === "unreadable") {
    return { kind: "unreadable", cause: input.cause };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }
  const obj = parsed as Record<string, unknown>;

  const versionField = obj.v;
  if (versionField !== undefined) {
    if (typeof versionField !== "number" || !Number.isInteger(versionField)) {
      return { kind: "corrupt" };
    }
    if (!INSTALL_SUPPORTED_VERSIONS.includes(versionField)) {
      return { kind: "unsupported-version", version: versionField };
    }
  }

  if (typeof obj.version !== "string") return { kind: "corrupt" };
  if (typeof obj.installedAt !== "string") return { kind: "corrupt" };

  return {
    kind: "valid",
    version: typeof versionField === "number" ? versionField : 1,
    value: {
      version: obj.version,
      installedAt: obj.installedAt,
      installId: stringOrNull(obj.installId),
      archiveSha256: stringOrNull(obj.archiveSha256),
      platform: stringOrNull(obj.platform),
      arch: stringOrNull(obj.arch),
    },
  };
}

export function decodePendingActivation(
  input: DurableBytes,
): DurableRecord<PendingActivation> {
  return decodeDurableRecord(
    input,
    PENDING_ACTIVATION_SUPPORTED_VERSIONS,
    (obj) => {
      if (typeof obj.toGeneration !== "string") return null;
      if (typeof obj.requestedAt !== "string") return null;
      if (typeof obj.cause !== "string") return null;
      return {
        toGeneration: obj.toGeneration,
        requestedAt: obj.requestedAt,
        cause: obj.cause,
      };
    },
  );
}

/**
 * Read path helper: map node fs outcomes into DurableBytes. Kept pure-
 * callable so probes inject fs without importing mutators.
 */
export type FileReadResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly cause: string };

export function fileReadToDurableBytes(result: FileReadResult): DurableBytes {
  if (result.kind === "not-found") return { kind: "missing" };
  if (result.kind === "error") {
    return { kind: "unreadable", cause: result.cause };
  }
  return { kind: "bytes", text: result.text };
}
