import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { dataLocationRecordSchema } from "./data-root";

/**
 * Versioned record contracts of the data-root migration transaction (design:
 * issue-718 "migration transaction, maintenance API and recovery"). Pure:
 * schemas, the phase table, the external-action reconciliation rule, the
 * session-impact digest and the component handshake. Persistence lives in
 * `data-bootstrap-records.ts`; admission and locks in
 * `data-migration-admission.ts`. Node-only (`node:crypto`), so subpath-only
 * like `data-root.ts`.
 *
 * Nothing here performs a migration. The coordinator (CLI) and the host's
 * offline maintenance entry point build on these shapes.
 */

export const DATA_MIGRATION_RECORD_VERSION = 1;

/**
 * The data-migration protocol generation every participant (Desktop, CLI,
 * host, the host's maintenance entry point) publishes in its admission entry
 * and maintenance handshake. A participant publishing a lower value - or none
 * at all, which is every binary older than this feature - cannot take part in
 * a migration.
 *
 * Protocol SUPPORT only: it says a participant honors the barrier and reads
 * these records. It does not say relocation is enabled or qualified on this
 * platform - that is a separate decision the user-facing commands make, and
 * nothing here advertises it.
 */
export const DATA_MIGRATION_PROTOCOL_VERSION = 1;

// ---- Identifiers and digests ----------------------------------------------

/**
 * Migration ids name flat files in the bootstrap folder, so they are lower
 * case (Windows compares names case-insensitively) and carry no separators.
 */
export const migrationIdSchema = lazySchema(() =>
  z.string().regex(/^m-[a-z0-9][a-z0-9-]{7,62}$/u, "invalid migration id"),
);
export type MigrationId = z.infer<typeof migrationIdSchema>;

export function newMigrationId(): MigrationId {
  return `m-${randomUUID()}`;
}

export const sha256DigestSchema = lazySchema(() =>
  z.string().regex(/^sha256:[0-9a-f]{64}$/u, "invalid digest"),
);
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

/**
 * Deterministic JSON: object keys sorted at every depth, no whitespace. The
 * one serialization every digest and record checksum in this transaction is
 * taken over, so two writers never disagree about the bytes of one value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("canonicalJson: value is not JSON-serializable");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256Digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

// ---- Component handshake --------------------------------------------------

export const migrationComponentSchema = lazySchema(() =>
  z.enum(["desktop", "cli", "host", "maintenance"]),
);
export type MigrationComponent = z.infer<typeof migrationComponentSchema>;

/**
 * What a participant says about itself: which component, which build, and
 * which data-migration protocol generation it implements. Published in every
 * admission entry and in every maintenance response.
 */
export const componentHandshakeSchema = lazySchema(() =>
  z.strictObject({
    component: migrationComponentSchema,
    build: z.string().min(1).max(200),
    dataMigrationProtocol: z.number().int().positive(),
  }),
);
export type ComponentHandshake = z.infer<typeof componentHandshakeSchema>;

export function currentComponentHandshake(
  component: MigrationComponent,
  build: string,
): ComponentHandshake {
  return {
    component,
    build,
    dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION,
  };
}

export type HandshakeBlocker = {
  readonly component: MigrationComponent;
  readonly build: string;
  readonly reason: "protocol-too-old" | "protocol-too-new";
};

/**
 * Participants that cannot take part in a migration run by this binary. An
 * older protocol does not honor the barrier semantics this one relies on; a
 * newer one may write records this one cannot read. Either refuses: there is
 * no mixed-version migration.
 */
export function incompatibleHandshakes(
  handshakes: readonly ComponentHandshake[],
): HandshakeBlocker[] {
  const blockers: HandshakeBlocker[] = [];
  for (const handshake of handshakes) {
    if (handshake.dataMigrationProtocol === DATA_MIGRATION_PROTOCOL_VERSION) {
      continue;
    }
    blockers.push({
      component: handshake.component,
      build: handshake.build,
      reason:
        handshake.dataMigrationProtocol < DATA_MIGRATION_PROTOCOL_VERSION
          ? "protocol-too-old"
          : "protocol-too-new",
    });
  }
  return blockers;
}

// ---- Phases ---------------------------------------------------------------

export const MIGRATION_PHASES = [
  "planned",
  "quiescing",
  "copying",
  "repairing",
  "preparing-external",
  "ready",
  "switching",
  "switched",
  "activated",
  "cleaning",
  "complete",
  "rollback-requested",
  "rolled-back",
] as const;
export const migrationPhaseSchema = lazySchema(() => z.enum(MIGRATION_PHASES));
export type MigrationPhase = z.infer<typeof migrationPhaseSchema>;

/**
 * The phase table. A phase is a durable INTENT to perform it, not proof that
 * every effect of it finished; recovery is observation-driven.
 *
 * Rollback is reachable from every phase before `activated` and from none
 * after: `activated` is the irreversible authorization boundary whether or
 * not any destination write has been observed. `rollback-requested` only
 * moves on to `rolled-back` - a crashed rollback resumes its inverses, never
 * the forward migration. `complete` re-enters `cleaning` for the explicit,
 * later source cleanup.
 */
const PHASE_TRANSITIONS: Readonly<
  Record<MigrationPhase, readonly MigrationPhase[]>
> = {
  planned: ["quiescing", "rolled-back"],
  quiescing: ["copying", "rollback-requested"],
  copying: ["repairing", "rollback-requested"],
  repairing: ["preparing-external", "rollback-requested"],
  "preparing-external": ["ready", "rollback-requested"],
  ready: ["switching", "rollback-requested"],
  switching: ["switched", "rollback-requested"],
  switched: ["activated", "rollback-requested"],
  activated: ["cleaning", "complete"],
  cleaning: ["complete"],
  complete: ["cleaning"],
  "rollback-requested": ["rolled-back"],
  "rolled-back": [],
};

/**
 * Phases during which normal Desktop, CLI-mutation, host and service starts
 * are refused. `planned` is a read-only inventory with no barrier yet;
 * `activated` is recorded BEFORE the barrier lifts, so from it onward the
 * destination may start.
 */
const BARRIER_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "quiescing",
  "copying",
  "repairing",
  "preparing-external",
  "ready",
  "switching",
  "switched",
  "rollback-requested",
]);

/** Phases from which the destination is authoritative and rollback is refused. */
const POST_ACTIVATION_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "activated",
  "cleaning",
  "complete",
]);

/** Phases after which a new migration may be planned. */
const TERMINAL_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "complete",
  "rolled-back",
]);

export function phaseHoldsStartupBarrier(phase: MigrationPhase): boolean {
  return BARRIER_PHASES.has(phase);
}

export function phaseIsPostActivation(phase: MigrationPhase): boolean {
  return POST_ACTIVATION_PHASES.has(phase);
}

export function phaseIsTerminal(phase: MigrationPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function canTransitionPhase(
  from: MigrationPhase,
  to: MigrationPhase,
): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/** Whether rollback (or, from `planned`, discarding the plan) is still allowed. */
export function rollbackAllowedFrom(phase: MigrationPhase): boolean {
  return (
    canTransitionPhase(phase, "rollback-requested") ||
    canTransitionPhase(phase, "rolled-back")
  );
}

// ---- Journal --------------------------------------------------------------

/**
 * A root captured at planning time: the normalized lexical path plus the
 * volume and directory identities the coordinator observed, so a remounted
 * or replaced folder at the same spelling is detected rather than trusted.
 * Identities are platform-opaque strings, or null where the platform cannot
 * produce one.
 */
export const capturedRootSchema = lazySchema(() =>
  z.strictObject({
    path: z.string().min(1),
    volumeId: z.string().min(1).nullable(),
    directoryId: z.string().min(1).nullable(),
  }),
);
export type CapturedRoot = z.infer<typeof capturedRootSchema>;

/** The live coordinator incarnation that holds the coordinator lock. */
export const coordinatorIncarnationSchema = lazySchema(() =>
  z.strictObject({
    pid: z.number().int().positive(),
    startIdentity: z.string().min(1).nullable(),
    lockNonce: z.string().min(1),
  }),
);
export type CoordinatorIncarnation = z.infer<
  typeof coordinatorIncarnationSchema
>;

/** Summary of the frozen source inventory and its per-file verification. */
export const copyManifestSummarySchema = lazySchema(() =>
  z.strictObject({
    digest: sha256DigestSchema,
    entryCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    verifiedCount: z.number().int().nonnegative(),
  }),
);
export type CopyManifestSummary = z.infer<typeof copyManifestSummarySchema>;

/**
 * The receipt a typed storage adapter commits INSIDE the destination store,
 * in the same per-store transaction as its repair, so re-running the adapter
 * can tell from the store itself whether its repair already happened.
 */
export const storeAdapterReceiptSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    migrationId: migrationIdSchema,
    storeKey: z.string().min(1),
    adapterId: z.string().min(1),
    adapterVersion: z.number().int().positive(),
    inputDigest: sha256DigestSchema,
    outputDigest: sha256DigestSchema,
    committedAt: z.string().min(1),
  }),
);
export type StoreAdapterReceipt = z.infer<typeof storeAdapterReceiptSchema>;

/** The journal's mirror of one per-store adapter receipt. */
export const journalAdapterReceiptSchema = lazySchema(() =>
  z.strictObject({
    storeKey: z.string().min(1),
    adapterId: z.string().min(1),
    adapterVersion: z.number().int().positive(),
    preconditionDigest: sha256DigestSchema,
    outputDigest: sha256DigestSchema.nullable(),
    state: z.enum(["planned", "committed", "verified"]),
  }),
);
export type JournalAdapterReceipt = z.infer<typeof journalAdapterReceiptSchema>;

/**
 * A fingerprint of one externally visible object (a scheduled task, a PATH
 * entry, a shortcut, a Git link file): absent, or present with a digest of
 * the bytes/fields the action owner compares.
 */
export const objectFingerprintSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("absent") }),
    z.strictObject({ kind: z.literal("present"), digest: sha256DigestSchema }),
  ]),
);
export type ObjectFingerprint = z.infer<typeof objectFingerprintSchema>;

export function fingerprintsEqual(
  left: ObjectFingerprint,
  right: ObjectFingerprint,
): boolean {
  if (left.kind === "absent" || right.kind === "absent") {
    return left.kind === right.kind;
  }
  return left.digest === right.digest;
}

export const externalActionKindSchema = lazySchema(() =>
  z.enum(["service-registration", "path-entry", "shortcut", "git-metadata"]),
);
export type ExternalActionKind = z.infer<typeof externalActionKindSchema>;

/**
 * One external side effect, durably recorded as `planned` BEFORE it is
 * applied. `object` names the exact affected object; `forward`/`inverse`
 * are the concrete action owner's typed payloads (ticket-specific), opaque
 * here. States:
 * - `planned`: recorded; may or may not have been applied (crash window).
 * - `applied`: the after image was observed.
 * - `abandoned`: never applied; the before image was observed during rollback.
 * - `inverted`: the inverse was applied and the before image observed.
 */
export const externalActionSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/u),
    kind: externalActionKindSchema,
    object: z.string().min(1),
    before: objectFingerprintSchema,
    after: objectFingerprintSchema,
    forward: z.json(),
    inverse: z.json(),
    state: z.enum(["planned", "applied", "abandoned", "inverted"]),
  }),
);
export type ExternalAction = z.infer<typeof externalActionSchema>;

export const migrationJournalSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(DATA_MIGRATION_RECORD_VERSION),
    id: migrationIdSchema,
    revision: z.number().int().positive(),
    phase: migrationPhaseSchema,
    /** The phase a rollback was requested from; null unless rolling back. */
    rollbackFromPhase: migrationPhaseSchema.nullable(),
    /** The entire prior location record; null for the implicit default root. */
    previousLocation: dataLocationRecordSchema.nullable(),
    source: capturedRootSchema,
    destination: capturedRootSchema,
    nextGeneration: z.number().int().positive(),
    coordinatorBuild: componentHandshakeSchema,
    /**
     * SHA-256 (lowercase hex) of the packaged coordinator executable that
     * created this transaction, captured once at planning and immutable: the
     * only evidence a later, possibly newer, binary uses to recognise the exact
     * original coordinator for recovery, without executing anything. Null when
     * the coordinator was not a packaged executable (a development run); then
     * no binary is ever recognised as the original.
     */
    coordinatorExecutableSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    maintenanceBuild: componentHandshakeSchema.nullable(),
    /** The coordinator incarnation currently driving this transaction. */
    coordinator: coordinatorIncarnationSchema.nullable(),
    inventoryDigest: sha256DigestSchema.nullable(),
    sourceIdentityDigest: sha256DigestSchema.nullable(),
    copyManifest: copyManifestSummarySchema.nullable(),
    adapterReceipts: z.array(journalAdapterReceiptSchema),
    actions: z.array(externalActionSchema),
    sessionImpactDigest: sha256DigestSchema.nullable(),
    acceptedSessionImpactDigest: sha256DigestSchema.nullable(),
    /**
     * A person asked to review the session impact report before copying (an
     * interactive start or resume). Monotonic: once true it is never cleared,
     * so a later non-interactive resume cannot skip that review. Consent is
     * still only `acceptedSessionImpactDigest` naming the exact current report.
     */
    impactReviewRequested: z.boolean(),
    /** The revision that durably recorded `activated`; null before it. */
    activationRevision: z.number().int().positive().nullable(),
    cleanupProgress: z
      .strictObject({
        removedEntries: z.number().int().nonnegative(),
        removedBytes: z.number().int().nonnegative(),
        finished: z.boolean(),
      })
      .nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
);
export type MigrationJournal = z.infer<typeof migrationJournalSchema>;

export type JournalTransitionRefusal = {
  readonly code:
    | "id-changed"
    | "revision-not-next"
    | "phase-transition-refused"
    | "rollback-refused-after-activation"
    | "activation-revision-invalid"
    | "rollback-origin-invalid"
    | "immutable-field-changed";
  readonly message: string;
};

// Fields fixed at planning time. A later revision that changes one is a
// different transaction, not a continuation of this one.
const IMMUTABLE_JOURNAL_FIELDS = [
  "previousLocation",
  "source",
  "destination",
  "nextGeneration",
  "coordinatorExecutableSha256",
  "createdAt",
] as const;

/**
 * Validates `next` as the successor revision of `current` (null for the
 * first revision). Enforces the phase table, the activation boundary,
 * immutability of the planned roots, and once-set activation evidence.
 */
export function checkJournalSuccessor(
  current: MigrationJournal | null,
  next: MigrationJournal,
): JournalTransitionRefusal | null {
  if (current === null) {
    if (next.revision !== 1) {
      return refusal("revision-not-next", "a new journal starts at revision 1");
    }
    if (next.phase !== "planned") {
      return refusal(
        "phase-transition-refused",
        "a new journal starts planned",
      );
    }
    if (next.activationRevision !== null || next.rollbackFromPhase !== null) {
      return refusal(
        "activation-revision-invalid",
        "a planned journal carries no activation or rollback evidence",
      );
    }
    return null;
  }
  if (next.id !== current.id) {
    return refusal("id-changed", "a journal revision cannot change its id");
  }
  if (next.revision !== current.revision + 1) {
    return refusal(
      "revision-not-next",
      `expected revision ${String(current.revision + 1)}, got ${String(next.revision)}`,
    );
  }
  for (const field of IMMUTABLE_JOURNAL_FIELDS) {
    if (canonicalJson(next[field]) !== canonicalJson(current[field])) {
      return refusal(
        "immutable-field-changed",
        `the journal's ${field} is fixed at planning time`,
      );
    }
  }
  if (current.impactReviewRequested && !next.impactReviewRequested) {
    return refusal(
      "immutable-field-changed",
      "a requested impact review cannot be withdrawn",
    );
  }
  if (next.phase !== current.phase) {
    if (
      next.phase === "rollback-requested" &&
      phaseIsPostActivation(current.phase)
    ) {
      return refusal(
        "rollback-refused-after-activation",
        "the destination is authoritative from activation onward; rollback is refused",
      );
    }
    if (!canTransitionPhase(current.phase, next.phase)) {
      return refusal(
        "phase-transition-refused",
        `${current.phase} cannot move to ${next.phase}`,
      );
    }
  }
  const expectedRollbackFrom =
    next.phase === "rollback-requested" &&
    current.phase !== "rollback-requested"
      ? current.phase
      : current.rollbackFromPhase;
  // Discarding a plan (`planned` -> `rolled-back`) has nothing to invert and
  // keeps a null origin.
  if (next.rollbackFromPhase !== expectedRollbackFrom) {
    return refusal(
      "rollback-origin-invalid",
      "rollbackFromPhase records the phase rollback was requested from and never changes",
    );
  }
  const expectedActivation =
    next.phase === "activated" && current.phase !== "activated"
      ? next.revision
      : current.activationRevision;
  if (next.activationRevision !== expectedActivation) {
    return refusal(
      "activation-revision-invalid",
      "activationRevision is set exactly once, by the revision that records activated",
    );
  }
  return null;
}

function refusal(
  code: JournalTransitionRefusal["code"],
  message: string,
): JournalTransitionRefusal {
  return { code, message };
}

/**
 * The first journal revision of a new transaction. The coordinator fills the
 * captured roots and build; everything the later phases produce starts empty.
 */
export function plannedJournal(input: {
  readonly id: MigrationId;
  readonly previousLocation: MigrationJournal["previousLocation"];
  readonly source: CapturedRoot;
  readonly destination: CapturedRoot;
  readonly nextGeneration: number;
  readonly coordinatorBuild: ComponentHandshake;
  readonly coordinatorExecutableSha256: string | null;
  readonly coordinator: CoordinatorIncarnation;
  readonly now: string;
}): MigrationJournal {
  return {
    version: DATA_MIGRATION_RECORD_VERSION,
    id: input.id,
    revision: 1,
    phase: "planned",
    rollbackFromPhase: null,
    previousLocation: input.previousLocation,
    source: input.source,
    destination: input.destination,
    nextGeneration: input.nextGeneration,
    coordinatorBuild: input.coordinatorBuild,
    coordinatorExecutableSha256: input.coordinatorExecutableSha256,
    maintenanceBuild: null,
    coordinator: input.coordinator,
    inventoryDigest: null,
    sourceIdentityDigest: null,
    copyManifest: null,
    adapterReceipts: [],
    actions: [],
    sessionImpactDigest: null,
    acceptedSessionImpactDigest: null,
    impactReviewRequested: false,
    activationRevision: null,
    cleanupProgress: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

// ---- External-action ledger -----------------------------------------------

/**
 * What to do with one ledger entry after observing its object now.
 * - `apply`: perform the forward mutation (compare-and-set against `before`).
 * - `invert`: perform the inverse (compare-and-set against `after`).
 * - `record-applied` / `record-abandoned` / `record-inverted`: the object
 *   already shows the outcome; only the receipt is missing.
 * - `none`: the ledger already matches the object.
 * - `conflict`: the object matches neither image - a third party changed it.
 *   Never overwritten; the barrier stays up and diagnostics name `object`.
 */
export type ExternalActionDecision =
  | "apply"
  | "invert"
  | "record-applied"
  | "record-abandoned"
  | "record-inverted"
  | "none"
  | "conflict";

/**
 * The reconciliation rule for one action, given what is observed on the
 * object now. `direction` is `forward` while the migration proceeds and
 * `inverse` while rolling back. This is what makes a crash between an effect
 * and its receipt safe in both directions.
 */
export function decideExternalAction(
  action: Pick<ExternalAction, "before" | "after" | "state">,
  observed: ObjectFingerprint,
  direction: "forward" | "inverse",
): ExternalActionDecision {
  const isBefore = fingerprintsEqual(observed, action.before);
  const isAfter = fingerprintsEqual(observed, action.after);
  if (direction === "forward") {
    switch (action.state) {
      case "planned":
        if (isAfter) return "record-applied";
        return isBefore ? "apply" : "conflict";
      case "applied":
        return isAfter ? "none" : "conflict";
      case "abandoned":
      case "inverted":
        // A rolled-back action is never re-applied by the same transaction.
        return "conflict";
    }
  }
  switch (action.state) {
    case "planned":
      if (isBefore) return "record-abandoned";
      return isAfter ? "invert" : "conflict";
    case "applied":
      if (isBefore) return "record-inverted";
      return isAfter ? "invert" : "conflict";
    case "abandoned":
    case "inverted":
      return isBefore ? "none" : "conflict";
  }
}

/** Inverses run in reverse ledger order. */
export function actionsInInverseOrder(
  actions: readonly ExternalAction[],
): ExternalAction[] {
  return [...actions].reverse();
}

// ---- Provider-session impact ----------------------------------------------

export const continuationPrimaryRouteSchema = lazySchema(() =>
  z.enum(["native-resume", "native-relocate", "fresh-context", "unknown"]),
);
export const continuationFailureRouteSchema = lazySchema(() =>
  z.enum(["fresh-context", "hold"]),
);

/** The compound continuation route (provider-compatibility contract). */
export const continuationRouteSchema = lazySchema(() =>
  z.strictObject({
    primary: continuationPrimaryRouteSchema,
    onFailure: continuationFailureRouteSchema,
  }),
);
export type ContinuationRoute = z.infer<typeof continuationRouteSchema>;

/**
 * One session's predicted impact. Private: it carries workspace paths and is
 * shown only in the user's own migration report, never logged above DEBUG
 * or sent to analytics.
 */
export const sessionImpactSchema = lazySchema(() =>
  z.strictObject({
    sessionId: z.string().min(1),
    surface: z.enum(["gui", "tui"]),
    provider: z.string().min(1),
    providerVersion: z.string().min(1).nullable(),
    profileRef: z.string().min(1).nullable(),
    oldPrimaryDirectory: z.string().min(1).nullable(),
    newPrimaryDirectory: z.string().min(1).nullable(),
    providerStoreMoved: z.boolean(),
    route: continuationRouteSchema,
    /** Unsafe copy, wrong profile, uncopyable links: a migration blocker. */
    blocker: z.boolean(),
    reason: z.string(),
  }),
);
export type SessionImpact = z.infer<typeof sessionImpactSchema>;

export const sessionImpactReportSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    sourceRoot: z.string().min(1),
    destinationRoot: z.string().min(1),
    sessions: z.array(sessionImpactSchema),
  }),
);
export type SessionImpactReport = z.infer<typeof sessionImpactReportSchema>;

/**
 * The digest a user acknowledges (`--accept-session-impact <digest>`). It
 * covers exactly what the acknowledgement approves: the root mapping and,
 * per session, its id, surface, provider, version, profile and compound
 * route. Order-independent, so re-inventorying the same sessions after
 * quiescence reproduces it; any material change produces a new digest.
 */
export function sessionImpactDigest(report: SessionImpactReport): Sha256Digest {
  const sessions = report.sessions
    .map((session) => ({
      sessionId: session.sessionId,
      surface: session.surface,
      provider: session.provider,
      providerVersion: session.providerVersion,
      profileRef: session.profileRef,
      route: session.route,
    }))
    .sort((left, right) =>
      canonicalJson([left.surface, left.sessionId]) <
      canonicalJson([right.surface, right.sessionId])
        ? -1
        : 1,
    );
  return sha256Digest({
    version: report.version,
    sourceRoot: report.sourceRoot,
    destinationRoot: report.destinationRoot,
    sessions,
  });
}

/**
 * Whether the report needs an explicit acknowledgement before mutation: any
 * `fresh-context` primary or failure fallback, or an `unknown` primary.
 */
export function sessionImpactRequiresAcceptance(
  report: SessionImpactReport,
): boolean {
  return report.sessions.some(
    (session) =>
      session.route.primary === "fresh-context" ||
      session.route.primary === "unknown" ||
      session.route.onFailure === "fresh-context",
  );
}

export function sessionImpactBlockers(
  report: SessionImpactReport,
): SessionImpact[] {
  return report.sessions.filter((session) => session.blocker);
}

// ---- Offline maintenance interface ----------------------------------------

export const maintenanceOperationSchema = lazySchema(() =>
  z.enum(["inventory", "verify-quiesced-source", "repair-copy", "verify-copy"]),
);
export type MaintenanceOperation = z.infer<typeof maintenanceOperationSchema>;

/**
 * Request schema v1 (design: "Offline maintenance interface"). Roots and
 * adapter selection come from the validated journal, never from the request.
 * `authorization` binds the request to the live coordinator incarnation that
 * holds the coordinator lock; a migration id alone is not authority.
 */
export const maintenanceRequestSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    migrationId: migrationIdSchema,
    journalRevision: z.number().int().positive(),
    operation: maintenanceOperationSchema,
    inventoryDigest: sha256DigestSchema.nullable(),
    authorization: coordinatorIncarnationSchema,
  }),
);
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

/**
 * `running-source` is a source writer PROVEN live right now (a running claim
 * holder, child, lease or fence holder, or an unmerged `-wal` its owner will
 * fold on a clean close): the one condition a cooperative stop resolves, so
 * the coordinator may defer it from `planned` to the authoritative quiesced
 * re-inventory. `busy-source` is everything else that is busy or cannot be
 * proven idle (ambiguous liveness, unreadable ledgers, owed transactional
 * work); it never defers.
 */
export const maintenanceErrorCodeSchema = lazySchema(() =>
  z.enum([
    "unauthorized",
    "protocol-mismatch",
    "unsupported-format",
    "running-source",
    "busy-source",
    "integrity-mismatch",
    "external-conflict",
    "permission-failure",
  ]),
);
export type MaintenanceErrorCode = z.infer<typeof maintenanceErrorCodeSchema>;

export const maintenanceBlockerSchema = lazySchema(() =>
  z.strictObject({
    code: maintenanceErrorCodeSchema,
    storeKey: z.string().min(1).nullable(),
    message: z.string(),
  }),
);
export type MaintenanceBlocker = z.infer<typeof maintenanceBlockerSchema>;

/**
 * A store's key in the field-level manifest: its path RELATIVE to the data
 * root, "/"-separated in one canonical spelling. Never absolute (the manifest
 * is shown and digested; a root spelling would make the same inventory differ
 * between source and destination), never a drive, never `.`/`..`/empty
 * segments, never a backslash.
 */
export const storeKeySchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (key) =>
        !key.includes("\\") &&
        !key.startsWith("/") &&
        !/^[A-Za-z]:/u.test(key) &&
        key
          .split("/")
          .every(
            (segment) =>
              segment.length > 0 && segment !== "." && segment !== "..",
          ),
      "store key must be a root-relative canonical slash-separated path",
    ),
);

/**
 * One field the adapter for a store owns: where it lives in the store
 * (`table.column`, `$.json.path`), the rule applied to it (`rebase-under-root`,
 * `preserve`, `scan-refuse`, ...) and how many stored values the rule
 * matched. Counts make the manifest describe the data it was taken over, not
 * only the adapter's capabilities.
 */
export const storeManifestFieldSchema = lazySchema(() =>
  z.strictObject({
    field: z.string().min(1),
    rule: z.string().min(1),
    matches: z.number().int().nonnegative(),
  }),
);
export type StoreManifestField = z.infer<typeof storeManifestFieldSchema>;

/**
 * One discovered store and the versioned adapter that answers for it.
 * - `repair`: a typed destination-only rebase runs for it.
 * - `preserve`: copied bytes are authority and are verified unchanged.
 * - `derived`: reconstructible or file-identity-bound records, retained as is.
 * - `opaque`: user/history bytes copied without interpretation.
 * - `refused`: the store blocks migration; the inventory's blockers say why.
 */
export const storeManifestEntrySchema = lazySchema(() =>
  z.strictObject({
    storeKey: storeKeySchema,
    adapterId: z.string().min(1),
    adapterVersion: z.number().int().positive(),
    format: z.string().min(1),
    disposition: z.enum(["repair", "preserve", "derived", "opaque", "refused"]),
    fields: z.array(storeManifestFieldSchema),
  }),
);
export type StoreManifestEntry = z.infer<typeof storeManifestEntrySchema>;

/** The manifest: one entry per store key, duplicates refused. */
export const storeManifestSchema = lazySchema(() =>
  z
    .array(storeManifestEntrySchema)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.storeKey)).size === entries.length,
      "store manifest has duplicate store keys",
    ),
);

/**
 * The manifest in its one canonical order: entries by store key, each
 * entry's fields by (field, rule). Enumeration order is immaterial to the
 * digest and to what is shown.
 */
export function canonicalStoreManifest(
  entries: readonly StoreManifestEntry[],
): StoreManifestEntry[] {
  const byKey = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return storeManifestSchema
    .parse(entries)
    .map((entry) => ({
      ...entry,
      fields: [...entry.fields].sort(
        (left, right) =>
          byKey(left.field, right.field) || byKey(left.rule, right.rule),
      ),
    }))
    .sort((left, right) => byKey(left.storeKey, right.storeKey));
}

/**
 * The `inventoryDigest` of a manifest: what the stores ARE and what the
 * adapters will do to them. Deliberately not source-content or copy evidence
 * (that is `copyManifest` / `sourceIdentityDigest`): two copies of the same
 * stores with equal field matches have equal inventory digests.
 */
export function storeManifestDigest(
  entries: readonly StoreManifestEntry[],
): Sha256Digest {
  return sha256Digest({ version: 1, stores: canonicalStoreManifest(entries) });
}

export const maintenanceResponseSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    handshake: componentHandshakeSchema,
    migrationId: migrationIdSchema,
    journalRevision: z.number().int().positive(),
    operation: maintenanceOperationSchema,
    /** `inventory` before the barrier is advisory only. */
    provisional: z.boolean(),
    inventoryDigest: sha256DigestSchema.nullable(),
    supportedAdapters: z.array(
      z.strictObject({
        adapterId: z.string().min(1),
        adapterVersion: z.number().int().positive(),
      }),
    ),
    receipts: z.array(storeAdapterReceiptSchema),
    blockers: z.array(maintenanceBlockerSchema),
    sessionImpacts: z.array(sessionImpactSchema),
    /** The field-level manifest `inventoryDigest` is taken over, canonical order. */
    stores: storeManifestSchema,
  }),
);
export type MaintenanceResponse = z.infer<typeof maintenanceResponseSchema>;
