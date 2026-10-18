import { readFileSync } from "node:fs";
import { lstat, readdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MigrationAdmissionError,
  surveyAdmittedProcesses,
  type MigrationCoordinatorLock,
} from "@traycer/protocol/config/data-migration-admission";
import {
  BootstrapRecordError,
  listMigrationJournalIdsSync,
  migrationLocationOf,
  readLocationRecordSync,
  readMigrationJournalSync,
  readMigrationSelectorSync,
  restoreLocationForRollback,
  restorePreviousRecordRevision,
  switchLocationForMigration,
} from "@traycer/protocol/config/data-bootstrap-records";
import {
  canonicalJson,
  newMigrationId,
  phaseIsTerminal,
  plannedJournal,
  rollbackAllowedFrom,
  sessionImpactDigest,
  sessionImpactRequiresAcceptance,
  sha256Digest,
  type JournalAdapterReceipt,
  type MaintenanceOperation,
  type MaintenanceResponse,
  type MigrationId,
  type MigrationJournal,
  type MigrationPhase,
  type SessionImpactReport,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  DataRootError,
  dataBootstrapDir,
  dataLocationRecordSchema,
  dataRootPathsOverlap,
  resolveDataRoot,
  validateDataRootSelection,
  type DataLocationRecord,
  type DataRootResolution,
} from "@traycer/protocol/config/data-root";
import { isErrnoException } from "../../runner/errors";
import { planGitWorktreeRelocation } from "../external-actions/git-worktree-actions";
import {
  assertSourceUnchanged,
  freezeContentInventory,
  identityFileHashes,
  loadContentInventory,
  measureSource,
  storeContentInventory,
  type LoadedContentInventory,
} from "./content-inventory";
import { withCoordinatorLock } from "./coordinator-lock";
import { copyInventory } from "./copy-engine";
import type { MigrationEngineDeps } from "./engine-deps";
import {
  EngineStop,
  engineBlocker,
  stopped,
  stopWith,
  type EngineBlocker,
  type EngineResult,
  type SessionImpactPresentation,
} from "./engine-types";
import {
  ledgerWithPlanned,
  planBlockers,
  runLedgerInverse,
  runStageForward,
  stageApplied,
  verifyLedger,
} from "./external-ledger";
import {
  installedParticipantBlockers,
  regularFileSha256,
} from "./installed-participants";
import { JournalSession } from "./journal-session";
import { managedProviderRoots } from "./provider-roots";
import {
  assertRootIdentity,
  captureRoot,
  checkRootIdentity,
} from "./root-identity";
import { excludeCoordinator } from "./root-user-census";

/**
 * The data-root migration engine (design: issue 718 "migration transaction,
 * maintenance API and recovery"; ticket 718-6). Internal: no command reaches
 * it yet (ticket 718-7 exposes it).
 *
 * The phase table is executable behavior here, not a progress label. Each
 * phase's work is idempotent and observation-driven, so `runForward` can be
 * entered at ANY recorded phase - after a crash, by another process - and
 * converges: it re-verifies what the phase needs, finishes what the phase
 * intended, and records the next phase only after its conditions hold.
 *
 *   planned            read-only inventory; no barrier
 *   quiescing          barrier up; owned autostart disabled; writers stopped
 *                      and proven gone; impact recomputed; content frozen
 *   copying            private destination filled and verified per file
 *   repairing          host maintenance repairs the copy; every receipt
 *                      mirrored into the journal, then semantically verified
 *   preparing-external Git links, task definitions and PATH staged
 *   ready              everything revalidated; pointer not switched
 *   switching          pointer replaced (only the exact old or new is accepted)
 *   switched           offline final verification
 *   activated          recorded BEFORE the barrier lifts; irreversible
 *   complete           owned registrations re-enabled; source retained
 *   cleaning           explicit source cleanup, launched from the destination
 *
 * Rollback is explicit (`rollbackMigration`), refused from `activated` on, and
 * itself resumable (`rollback-requested` replays the ledger's inverses).
 * Failures and cancellation never roll back on their own: the journal keeps
 * its phase (and barrier), and the result names why.
 */

// ---- Shared setup -----------------------------------------------------------

/** Runs `fn` and converts an operational stop into a result carrying the journal. */
async function guarded(
  session: JournalSession,
  fn: () => Promise<EngineResult>,
): Promise<EngineResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EngineStop) {
      return stopped(
        error.reason,
        session.journal,
        error.blockers,
        error.impact,
      );
    }
    if (error instanceof MigrationAdmissionError) {
      return stopped(
        error.code === "record-damaged" ? "damaged" : "blocked",
        session.journal,
        [engineBlocker(`admission-${error.code}`, null, error.message)],
        null,
      );
    }
    if (error instanceof BootstrapRecordError) {
      return stopped(
        error.code === "record-damaged" ? "damaged" : "conflict",
        session.journal,
        [
          engineBlocker(
            `bootstrap-${error.code}`,
            error.recordPath,
            error.message,
          ),
        ],
        null,
      );
    }
    throw error;
  }
}

function currentSourceRoot(deps: MigrationEngineDeps): {
  readonly root: string;
  readonly location: DataLocationRecord | null;
} {
  let resolution: DataRootResolution;
  try {
    resolution = resolveDataRoot(deps.homeDir, deps.platform);
  } catch (error) {
    if (error instanceof DataRootError)
      throw stopWith("damaged", "location-unreadable", null, error.message);
    throw error;
  }
  if (resolution.root !== deps.processDataRoot()) {
    throw stopWith(
      "blocked",
      "location-changed",
      null,
      "Traycer's data location changed while this command was running; run it again",
    );
  }
  return {
    root: resolution.root,
    location: resolution.kind === "configured" ? resolution.record : null,
  };
}

function readRetainedPreviousGeneration(bootstrapDir: string): number {
  try {
    const parsed = dataLocationRecordSchema.safeParse(
      JSON.parse(
        readFileSync(join(bootstrapDir, "location.prev.json"), "utf8"),
      ),
    );
    return parsed.success ? parsed.data.generation : 0;
  } catch {
    return 0;
  }
}

/**
 * Above the current pointer, the retained previous pointer (a rollback to the
 * default root leaves the rolled-back generation there) and every generation
 * any journal ever planned.
 */
function nextGenerationFor(
  bootstrapDir: string,
  location: DataLocationRecord | null,
): number {
  let floor = Math.max(
    location?.generation ?? 0,
    readRetainedPreviousGeneration(bootstrapDir),
  );
  for (const id of listMigrationJournalIdsSync(bootstrapDir)) {
    const journal = readMigrationJournalSync(bootstrapDir, id);
    if (journal.kind === "valid")
      floor = Math.max(floor, journal.record.nextGeneration);
    else if (journal.kind === "damaged" && journal.previous !== null) {
      floor = Math.max(floor, journal.previous.nextGeneration);
    }
  }
  return floor + 1;
}

function rootsOf(journal: MigrationJournal): {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
} {
  return {
    sourceRoot: journal.source.path,
    destinationRoot: journal.destination.path,
  };
}

function impactReportOf(
  journal: MigrationJournal,
  response: MaintenanceResponse,
): SessionImpactReport {
  return {
    version: 1,
    sourceRoot: journal.source.path,
    destinationRoot: journal.destination.path,
    sessions: response.sessionImpacts,
  };
}

export function presentImpact(
  report: SessionImpactReport,
): SessionImpactPresentation {
  return {
    report,
    digest: sessionImpactDigest(report),
    requiresAcceptance: sessionImpactRequiresAcceptance(report),
  };
}

async function runMaintenance(
  deps: MigrationEngineDeps,
  session: JournalSession,
  operation: MaintenanceOperation,
  inventoryDigest: Sha256Digest | null,
): Promise<MaintenanceResponse> {
  // The request names the current revision and this coordinator: bind first.
  await session.bind();
  const response = await deps.maintenance.run({
    journal: session.journal,
    operation,
    inventoryDigest,
    signal: deps.signal,
    onProgress: (progress) =>
      deps.progress({
        kind: "maintenance",
        operation: progress.operation,
        completed: progress.completedStores,
        total: progress.totalStores,
      }),
  });
  if (session.journal.maintenanceBuild === null) {
    await session.advance({ maintenanceBuild: response.handshake });
  }
  return response;
}

function maintenanceStop(
  response: MaintenanceResponse,
  impact: SessionImpactReport | null,
): EngineStop {
  const blockers = response.blockers.map((blocker) =>
    engineBlocker(blocker.code, blocker.storeKey, blocker.message),
  );
  const integrity = response.blockers.some(
    (blocker) => blocker.code === "integrity-mismatch",
  );
  const unauthorized = response.blockers.some(
    (blocker) =>
      blocker.code === "unauthorized" || blocker.code === "protocol-mismatch",
  );
  return new EngineStop(
    integrity ? "conflict" : unauthorized ? "failed" : "blocked",
    blockers,
    impact,
  );
}

// ---- Readonly advisory ------------------------------------------------------------

/**
 * What can be told about a migration to `destination` WITHOUT changing
 * anything: no coordinator lock, no journal, no bootstrap write, no folder
 * created, no service touched, and no host started. It is advisory, never a
 * clearance: the host's store and session inspection runs only under an
 * authorized migration (`startMigration`), so `storeInspection` is always
 * `"runs-at-start"` here and a clean advisory can still be refused then.
 */
export type MigrationAdvisory = {
  readonly sourceRoot: string;
  readonly destinationRoot: string | null;
  readonly blockers: readonly EngineBlocker[];
  /** Bytes the copy needs: the source's files plus a margin. */
  readonly sourceBytes: number;
  readonly requiredBytes: number;
  readonly destinationFreeBytes: number | null;
  readonly storeInspection: "runs-at-start";
};

/** Source bytes plus 5% and 64 MiB of headroom for repair and evidence. */
function requiredBytes(sourceBytes: number): number {
  return sourceBytes + Math.ceil(sourceBytes * 0.05) + 64 * 1024 * 1024;
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export async function inspectMigrationReadonly(
  deps: MigrationEngineDeps,
  input: { readonly destination: string },
): Promise<MigrationAdvisory> {
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  const blockers: EngineBlocker[] = [];
  let sourceRoot: string;
  try {
    sourceRoot = currentSourceRoot(deps).root;
  } catch (error) {
    if (!(error instanceof EngineStop)) throw error;
    return {
      sourceRoot: deps.processDataRoot(),
      destinationRoot: null,
      blockers: error.blockers,
      sourceBytes: 0,
      requiredBytes: 0,
      destinationFreeBytes: null,
      storeInspection: "runs-at-start",
    };
  }
  const selector = readMigrationSelectorSync(bootstrapDir);
  if (selector.kind === "damaged")
    blockers.push(engineBlocker("selector-damaged", null, selector.reason));
  else if (
    selector.kind === "valid" &&
    selector.record.activeMigrationId !== null
  ) {
    const active = readMigrationJournalSync(
      bootstrapDir,
      selector.record.activeMigrationId,
    );
    if (active.kind !== "valid" || !phaseIsTerminal(active.record.phase)) {
      blockers.push(
        engineBlocker(
          "migration-active",
          selector.record.activeMigrationId,
          "a Traycer data migration is already in progress; recover it first",
        ),
      );
    }
  }
  const check = validateDataRootSelection(input.destination, deps.platform);
  let destinationRoot: string | null = null;
  if (!check.ok)
    blockers.push(
      engineBlocker("destination-invalid", input.destination, check.reason),
    );
  else {
    destinationRoot = check.root;
    for (const root of [sourceRoot, bootstrapDir]) {
      if (dataRootPathsOverlap(check.root, root, deps.platform)) {
        blockers.push(
          engineBlocker(
            "destination-overlaps",
            check.root,
            "the destination overlaps the current data or bootstrap folder",
          ),
        );
      }
    }
  }
  blockers.push(
    ...(await installedParticipantBlockers({
      sourceRoot,
      platform: deps.platform,
      coordinatorExecutable: await deps.coordinatorExecutable(),
    })),
  );
  const quiescePlan = await deps.services.planQuiesce({
    sourceRoot,
    destinationRoot: destinationRoot ?? sourceRoot,
  });
  blockers.push(...planBlockers(quiescePlan.blockers));
  const measured = await measureSource({ sourceRoot, signal: deps.signal });
  blockers.push(...measured.blockers);
  const free =
    destinationRoot === null
      ? null
      : await deps.freeBytes(await nearestExistingAncestor(destinationRoot));
  const needed = requiredBytes(measured.byteCount);
  if (free !== null && free < needed) {
    blockers.push(
      engineBlocker(
        "destination-capacity",
        destinationRoot,
        "the destination drive does not have enough free space",
      ),
    );
  }
  return {
    sourceRoot,
    destinationRoot,
    blockers,
    sourceBytes: measured.byteCount,
    requiredBytes: needed,
    destinationFreeBytes: free,
    storeInspection: "runs-at-start",
  };
}

async function beginSession(
  deps: MigrationEngineDeps,
  lock: MigrationCoordinatorLock,
  bootstrapDir: string,
  journal: MigrationJournal,
): Promise<JournalSession> {
  const secured = await deps.secureBootstrap(bootstrapDir);
  if (!secured.ok)
    throw stopWith(
      "blocked",
      `bootstrap-${secured.code}`,
      bootstrapDir,
      secured.reason,
    );
  try {
    return await JournalSession.begin({
      bootstrapDir,
      lock,
      probe: deps.probe,
      checkpoint: deps.checkpoint,
      now: deps.now,
      journal,
    });
  } catch (error) {
    if (error instanceof MigrationAdmissionError) {
      throw stopWith("blocked", "migration-active", null, error.message);
    }
    throw error;
  }
}

// ---- Start ----------------------------------------------------------------------

/**
 * Start a migration to `destination`: allocate the private empty destination
 * and capture both roots' identities (the mutating preparation the readonly
 * advisory never does), write the planned journal, inventory, and - when the
 * impact needs no acceptance or `acceptedSessionImpactDigest` names exactly
 * the report - continue forward.
 *
 * `reviewImpact` is the caller's statement that a person is present to see
 * the report: when true, `planned` stops (`acceptance-required`,
 * `session-impact-review`) until `acceptedSessionImpactDigest` names the
 * exact report even if no acceptance is required, and a report that changes
 * after quiescence is shown again. A non-interactive caller passes false;
 * a report that requires acceptance always stops either way.
 */
export async function startMigration(
  deps: MigrationEngineDeps,
  input: {
    readonly destination: string;
    readonly acceptedSessionImpactDigest: Sha256Digest | null;
    readonly reviewImpact: boolean;
  },
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ lock, bootstrapDir }) => {
    const { root: sourceRoot, location } = currentSourceRoot(deps);
    const selector = readMigrationSelectorSync(bootstrapDir);
    if (selector.kind === "damaged")
      throw stopWith("damaged", "selector-damaged", null, selector.reason);
    const activeId =
      selector.kind === "valid" ? selector.record.activeMigrationId : null;
    if (activeId !== null) {
      const active = readMigrationJournalSync(bootstrapDir, activeId);
      if (active.kind !== "valid" || !phaseIsTerminal(active.record.phase)) {
        throw stopWith(
          "blocked",
          "migration-active",
          activeId,
          "a Traycer data migration is already in progress; recover it first",
        );
      }
    }
    // Recorded once, before any effect, so a later (possibly newer) binary
    // can recognise this exact coordinator for recovery without running it.
    const coordinatorExecutable = await deps.coordinatorExecutable();
    const coordinatorExecutableSha256 =
      coordinatorExecutable === null
        ? null
        : await regularFileSha256(coordinatorExecutable);
    if (
      coordinatorExecutable !== null &&
      coordinatorExecutableSha256 === null
    ) {
      throw stopWith(
        "blocked",
        "coordinator-executable-unreadable",
        null,
        "Traycer could not read its own executable",
      );
    }
    const prepared = await deps.destination.prepare({
      requested: input.destination,
      protectedRoots: [sourceRoot, bootstrapDir],
    });
    if (!prepared.ok)
      throw stopWith(
        "blocked",
        `destination-${prepared.code}`,
        input.destination,
        prepared.reason,
      );
    // A requested review is in the first durable journal, so a crash before
    // any later revision still leaves it for a non-interactive resume.
    const journal = {
      ...plannedJournal({
        id: newMigrationId(),
        previousLocation: location,
        source: await captureRoot(sourceRoot),
        destination: await captureRoot(prepared.root),
        nextGeneration: nextGenerationFor(bootstrapDir, location),
        coordinatorBuild: deps.coordinatorBuild,
        coordinatorExecutableSha256,
        coordinator: lock.incarnation,
        now: deps.now(),
      }),
      impactReviewRequested: input.reviewImpact,
    };
    const session = await beginSession(deps, lock, bootstrapDir, journal);
    return guarded(session, () =>
      runForward(deps, session, bootstrapDir, impactAcceptanceOf(input)),
    );
  });
}

// ---- Recovery -------------------------------------------------------------------

export type MigrationDiagnosis = {
  readonly journal: MigrationJournal | null;
  readonly pointer:
    | "previous"
    | "migration"
    | "other"
    | "damaged"
    | "not-applicable";
  readonly rollbackAllowed: boolean;
  /** What `recoverMigration` would do for `resume`. */
  readonly resumable: boolean;
};

function loadActiveJournal(bootstrapDir: string): MigrationJournal | null {
  const selector = readMigrationSelectorSync(bootstrapDir);
  if (selector.kind === "damaged") {
    throw stopWith(
      "damaged",
      "selector-damaged",
      null,
      `the migration selector is damaged (${selector.reason})`,
    );
  }
  const id =
    selector.kind === "valid" ? selector.record.activeMigrationId : null;
  if (id === null) return null;
  const journal = readMigrationJournalSync(bootstrapDir, id);
  if (journal.kind === "absent")
    throw stopWith(
      "damaged",
      "journal-missing",
      id,
      "the active migration's journal is missing",
    );
  if (journal.kind === "damaged") {
    throw stopWith(
      "damaged",
      "journal-damaged",
      id,
      `the active migration's journal is damaged (${journal.reason})`,
    );
  }
  return journal.record;
}

/** Where the location pointer stands relative to `journal` (read-only; for status). */
export function pointerState(
  bootstrapDir: string,
  journal: MigrationJournal,
): MigrationDiagnosis["pointer"] {
  const read = readLocationRecordSync(bootstrapDir);
  if (read.kind === "damaged") return "damaged";
  const current = read.kind === "valid" ? read.record : null;
  if (canonicalJson(current) === canonicalJson(journal.previousLocation))
    return "previous";
  if (canonicalJson(current) === canonicalJson(migrationLocationOf(journal)))
    return "migration";
  return "other";
}

/** Read-only diagnosis of the active migration (takes the coordinator lock to read a settled state). */
export async function diagnoseMigration(
  deps: MigrationEngineDeps,
): Promise<
  | { readonly kind: "diagnosis"; readonly diagnosis: MigrationDiagnosis }
  | Extract<EngineResult, { kind: "stopped" }>
> {
  const out: { diagnosis: MigrationDiagnosis | null } = { diagnosis: null };
  const result = await withCoordinatorLock(deps, ({ bootstrapDir }) => {
    const journal = loadActiveJournal(bootstrapDir);
    out.diagnosis =
      journal === null
        ? {
            journal: null,
            pointer: "not-applicable",
            rollbackAllowed: false,
            resumable: false,
          }
        : {
            journal,
            pointer: pointerState(bootstrapDir, journal),
            rollbackAllowed:
              journal.phase === "rollback-requested" ||
              rollbackAllowedFrom(journal.phase),
            resumable:
              !phaseIsTerminal(journal.phase) && journal.phase !== "cleaning",
          };
    return Promise.resolve<EngineResult>(
      journal === null
        ? stopped(
            "blocked",
            null,
            [
              engineBlocker(
                "no-migration",
                null,
                "no data migration is recorded",
              ),
            ],
            null,
          )
        : { kind: "done", journal },
    );
  });
  if (out.diagnosis !== null)
    return { kind: "diagnosis", diagnosis: out.diagnosis };
  if (result.kind === "stopped") return result;
  throw new Error("diagnosis finished without a result");
}

/**
 * Resume the active migration from its recorded phase (forward; a
 * `rollback-requested` journal resumes its rollback). `acceptedSessionImpactDigest`
 * is the user's acknowledgement of the CURRENT report, when one is required
 * or `reviewImpact` asks for review (see `startMigration`).
 */
export async function resumeMigration(
  deps: MigrationEngineDeps,
  input: {
    readonly acceptedSessionImpactDigest: Sha256Digest | null;
    readonly reviewImpact: boolean;
  },
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ lock, bootstrapDir }) => {
    const journal = loadActiveJournal(bootstrapDir);
    if (journal === null)
      throw stopWith(
        "blocked",
        "no-migration",
        null,
        "no data migration is recorded",
      );
    const session = JournalSession.resume({
      bootstrapDir,
      lock,
      probe: deps.probe,
      checkpoint: deps.checkpoint,
      now: deps.now,
      journal,
    });
    return guarded(session, () =>
      journal.phase === "rollback-requested"
        ? runRollback(deps, session, bootstrapDir)
        : runForward(deps, session, bootstrapDir, impactAcceptanceOf(input)),
    );
  });
}

/** Explicit pre-activation rollback (or discarding a plan). Refused from `activated` on. */
export async function rollbackMigration(
  deps: MigrationEngineDeps,
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ lock, bootstrapDir }) => {
    const journal = loadActiveJournal(bootstrapDir);
    if (journal === null)
      throw stopWith(
        "blocked",
        "no-migration",
        null,
        "no data migration is recorded",
      );
    const session = JournalSession.resume({
      bootstrapDir,
      lock,
      probe: deps.probe,
      checkpoint: deps.checkpoint,
      now: deps.now,
      journal,
    });
    return guarded(session, () => runRollback(deps, session, bootstrapDir));
  });
}

/**
 * Explicit recovery of a damaged selector or journal from its valid previous
 * revision. The protocol's refusals stand: a journal whose previous revision
 * is `switched` is never restored (the lost revision may be `activated`), and
 * a selector only when no other journal could have held a barrier.
 */
export async function restoreDamagedRecord(
  deps: MigrationEngineDeps,
  target:
    | { readonly kind: "selector" }
    | { readonly kind: "journal"; readonly id: MigrationId },
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ lock, bootstrapDir }) => {
    await restorePreviousRecordRevision(bootstrapDir, lock, target);
    const journal = loadActiveJournal(bootstrapDir);
    if (journal === null)
      return stopped(
        "blocked",
        null,
        [engineBlocker("no-migration", null, "no data migration is recorded")],
        null,
      );
    return { kind: "done", journal };
  });
}

// ---- Forward driver -------------------------------------------------------------

/** What the caller brings to the session impact report on this run. */
type ImpactAcceptance = {
  /** The exact report digest the person accepted, or null. */
  readonly digest: Sha256Digest | null;
  /** A person is present and must see the report even when acceptance is not required. */
  readonly review: boolean;
};

function impactAcceptanceOf(input: {
  readonly acceptedSessionImpactDigest: Sha256Digest | null;
  readonly reviewImpact: boolean;
}): ImpactAcceptance {
  return {
    digest: input.acceptedSessionImpactDigest,
    review: input.reviewImpact,
  };
}

async function runForward(
  deps: MigrationEngineDeps,
  session: JournalSession,
  bootstrapDir: string,
  accepted: ImpactAcceptance,
): Promise<EngineResult> {
  for (;;) {
    const phase: MigrationPhase = session.journal.phase;
    deps.progress({ kind: "phase", phase });
    switch (phase) {
      case "planned":
        await forwardPlanned(deps, session, accepted);
        break;
      case "quiescing":
        await forwardQuiescing(deps, session, accepted);
        break;
      case "copying":
        await forwardCopying(deps, session);
        break;
      case "repairing":
        await forwardRepairing(deps, session);
        break;
      case "preparing-external":
        await forwardPreparingExternal(deps, session);
        break;
      case "ready":
        await forwardReady(deps, session);
        break;
      case "switching":
        await forwardSwitching(deps, session, bootstrapDir);
        break;
      case "switched":
        await forwardSwitched(deps, session, bootstrapDir);
        break;
      case "activated":
        await forwardActivated(deps, session);
        break;
      case "rollback-requested":
        return runRollback(deps, session, bootstrapDir);
      case "cleaning":
      case "complete":
      case "rolled-back":
        return { kind: "done", journal: session.journal };
    }
  }
}

/**
 * The review this run must honour: the caller's request, or one any earlier
 * run recorded (durable and never cleared, so a later resume with
 * `reviewImpact: false` cannot skip it). A start records it in its first
 * journal; a resume that asks for it records it here before any further work.
 */
async function durableReview(
  session: JournalSession,
  accepted: ImpactAcceptance,
): Promise<ImpactAcceptance> {
  if (accepted.review && !session.journal.impactReviewRequested) {
    await session.advance({ impactReviewRequested: true });
  }
  return {
    digest: accepted.digest,
    review: session.journal.impactReviewRequested,
  };
}

async function forwardPlanned(
  deps: MigrationEngineDeps,
  session: JournalSession,
  requested: ImpactAcceptance,
): Promise<void> {
  const accepted = await durableReview(session, requested);
  const journal = session.journal;
  if (
    journal.destination.volumeId === null ||
    journal.destination.directoryId === null
  ) {
    throw stopWith(
      "blocked",
      "destination-not-allocated",
      journal.destination.path,
      "this plan never allocated a destination; start a new migration",
    );
  }
  await assertRootIdentity(journal.source, "source");
  await assertRootIdentity(journal.destination, "destination");
  // Every installed host and CLI must be proven to understand relocation
  // before any effect: an old one started later would use the old folder.
  const participants = await installedParticipantBlockers({
    sourceRoot: journal.source.path,
    platform: deps.platform,
    coordinatorExecutable: await deps.coordinatorExecutable(),
  });
  if (participants.length > 0)
    throw new EngineStop("blocked", participants, null);
  // Provisional while live; recomputed authoritatively after quiescence.
  const response = await runMaintenance(deps, session, "inventory", null);
  const impact = presentImpact(impactReportOf(session.journal, response));
  // A writer proven running is the one condition the cooperative stop below
  // resolves, so it alone defers to the quiesced re-inventory, which refuses
  // on ANY blocker. Everything else (ambiguous liveness, owed transactional
  // work, unsupported or inconsistent stores) refuses here, before effects.
  const hard = response.blockers.filter(
    (blocker) => blocker.code !== "running-source",
  );
  if (hard.length > 0)
    throw maintenanceStop({ ...response, blockers: hard }, impact.report);
  const deferred = response.blockers.length - hard.length;
  if (deferred > 0)
    deps.progress({ kind: "deferred-to-quiescence", running: deferred });
  if (session.journal.sessionImpactDigest !== impact.digest) {
    await session.advance({
      sessionImpactDigest: impact.digest,
      acceptedSessionImpactDigest: null,
    });
  }
  const quiescePlan = await deps.services.planQuiesce(rootsOf(journal));
  if (quiescePlan.blockers.length > 0)
    throw new EngineStop(
      "blocked",
      planBlockers(quiescePlan.blockers),
      impact.report,
    );
  const mustAccept = impact.requiresAcceptance || accepted.review;
  if (mustAccept && accepted.digest !== impact.digest) {
    throw new EngineStop(
      "acceptance-required",
      [
        impact.requiresAcceptance
          ? engineBlocker(
              "session-impact-acceptance",
              impact.digest,
              "the session impact report must be accepted before the migration starts",
            )
          : engineBlocker(
              "session-impact-review",
              impact.digest,
              "review the session impact report before the migration starts",
            ),
      ],
      impact.report,
    );
  }
  await session.advance({
    phase: "quiescing",
    acceptedSessionImpactDigest: mustAccept ? impact.digest : null,
    actions: ledgerWithPlanned(session.journal.actions, quiescePlan.actions),
  });
}

async function drainAdmittedProcesses(
  deps: MigrationEngineDeps,
  bootstrapDir: string,
): Promise<void> {
  const deadline = Date.now() + deps.drain.waitMs;
  for (;;) {
    const survey = await surveyAdmittedProcesses({
      bootstrapDir,
      probe: deps.probe,
      reap: true,
    });
    if (survey.handshakeBlockers.length > 0) {
      throw new EngineStop(
        "blocked",
        survey.handshakeBlockers.map((blocker) =>
          engineBlocker(
            `participant-${blocker.reason}`,
            `${blocker.component} ${blocker.build}`,
            "a running Traycer component does not support this data migration; update or quit it",
          ),
        ),
        null,
      );
    }
    if (survey.drained) return;
    const remaining = survey.processes.filter(
      (report) => report.state !== "exited" && report.state !== "recycled",
    );
    const undecidable = remaining.filter(
      (report) => report.state === "ambiguous" || report.state === "unreadable",
    );
    if (
      undecidable.length > 0 ||
      Date.now() >= deadline ||
      deps.signal.aborted
    ) {
      throw new EngineStop(
        "blocked",
        remaining.map((report) =>
          engineBlocker(
            report.state === "running"
              ? "participant-running"
              : `participant-${report.state}`,
            report.entry === null
              ? report.entryId
              : `${report.entry.handshake.component} pid ${String(report.entry.pid)}`,
            report.state === "running"
              ? "a Traycer process is still running; quit Traycer (Desktop, CLI commands, hosts) and retry"
              : "a Traycer process could not be proven stopped; it blocks the migration until it is",
          ),
        ),
        null,
      );
    }
    deps.progress({
      kind: "waiting-for-participants",
      running: remaining.length,
    });
    await new Promise<void>((resolve) =>
      setTimeout(resolve, deps.drain.pollMs),
    );
  }
}

function identityStoreKeys(response: MaintenanceResponse): string[] {
  return response.stores
    .filter(
      (store) =>
        store.adapterId === "identity-file" && store.disposition === "preserve",
    )
    .map((store) => store.storeKey);
}

async function forwardQuiescing(
  deps: MigrationEngineDeps,
  session: JournalSession,
  requested: ImpactAcceptance,
): Promise<void> {
  const accepted = await durableReview(session, requested);
  const journal = session.journal;
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  await assertRootIdentity(journal.source, "source");
  await assertRootIdentity(journal.destination, "destination");
  await runStageForward(session, "quiesce", deps.checkpoint);
  const stopBlockers = await deps.services.stopRunningHosts(rootsOf(journal));
  try {
    await drainAdmittedProcesses(deps, bootstrapDir);
  } catch (error) {
    if (!(error instanceof EngineStop)) throw error;
    throw new EngineStop(
      error.reason,
      [...stopBlockers, ...error.blockers],
      null,
    );
  }
  const census = await excludeCoordinator(
    await deps.census.census({
      root: journal.source.path,
      signal: deps.signal,
    }),
    session.coordinatorLock.incarnation,
    deps.probe,
  );
  if (census.kind === "unprovable") {
    throw stopWith(
      "blocked",
      "process-census-unprovable",
      journal.source.path,
      `processes using the data folder could not be ruled out (${census.reason})`,
    );
  }
  if (census.kind === "users") {
    throw new EngineStop(
      "blocked",
      census.users.map((user) =>
        engineBlocker(
          "process-using-data-folder",
          `${user.name ?? "process"} pid ${String(user.pid)} (${user.evidence})`,
          "a process is using the data folder (for example a shell or editor in a managed worktree); close it and retry",
        ),
      ),
      null,
    );
  }
  const response = await runMaintenance(
    deps,
    session,
    "verify-quiesced-source",
    null,
  );
  const impact = presentImpact(impactReportOf(session.journal, response));
  if (response.blockers.length > 0)
    throw maintenanceStop(response, impact.report);
  if (response.inventoryDigest === null)
    throw stopWith(
      "failed",
      "maintenance-no-inventory",
      null,
      "the storage inventory returned no digest",
    );
  if (session.journal.sessionImpactDigest !== impact.digest) {
    // Material change since it was presented: show it again before copying.
    await session.advance({
      sessionImpactDigest: impact.digest,
      acceptedSessionImpactDigest: null,
    });
  }
  if (
    (impact.requiresAcceptance || accepted.review) &&
    session.journal.acceptedSessionImpactDigest !== impact.digest
  ) {
    if (accepted.digest !== impact.digest) {
      throw new EngineStop(
        "acceptance-required",
        [
          engineBlocker(
            "session-impact-changed",
            impact.digest,
            "the session impact changed after Traycer stopped; review and accept it again",
          ),
        ],
        impact.report,
      );
    }
    await session.advance({ acceptedSessionImpactDigest: impact.digest });
  }
  const providerRoots = await managedProviderRoots({
    sourceRoot: journal.source.path,
    platform: deps.platform,
  });
  const inventory = await freezeContentInventory({
    sourceRoot: journal.source.path,
    migrationId: journal.id,
    providerRoots,
    signal: deps.signal,
  });
  const free = await deps.freeBytes(journal.destination.path);
  const needed = requiredBytes(inventory.header.byteCount);
  if (free !== null && free < needed) {
    throw stopWith(
      "blocked",
      "destination-capacity",
      journal.destination.path,
      `the destination drive needs about ${String(Math.ceil(needed / (1024 * 1024)))} MB free`,
    );
  }
  await assertRootIdentity(journal.destination, "destination");
  const digest = await storeContentInventory({
    destinationRoot: journal.destination.path,
    inventory,
    now: deps.now,
    platform: deps.nodePlatform,
  });
  await session.advance({
    phase: "copying",
    inventoryDigest: response.inventoryDigest,
    sourceIdentityDigest: sha256Digest({
      version: 1,
      files: identityFileHashes(inventory, identityStoreKeys(response)),
    }),
    copyManifest: {
      digest,
      entryCount: inventory.header.fileCount + inventory.header.dirCount,
      byteCount: inventory.header.byteCount,
      verifiedCount: 0,
    },
  });
}

async function loadInventory(
  journal: MigrationJournal,
): Promise<LoadedContentInventory> {
  const manifest = journal.copyManifest;
  if (manifest === null)
    throw stopWith(
      "damaged",
      "copy-manifest-missing",
      journal.id,
      "the journal records no source inventory",
    );
  return loadContentInventory({
    destinationRoot: journal.destination.path,
    migrationId: journal.id,
    digest: manifest.digest,
  });
}

async function forwardCopying(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  const journal = session.journal;
  await assertRootIdentity(journal.source, "source");
  await assertRootIdentity(journal.destination, "destination");
  const inventory = await loadInventory(journal);
  await assertSourceUnchanged({
    sourceRoot: journal.source.path,
    inventory,
    signal: deps.signal,
  });
  const totalFiles = inventory.header.fileCount;
  const result = await copyInventory({
    sourceRoot: journal.source.path,
    destinationRoot: journal.destination.path,
    inventory,
    migrationId: journal.id,
    platform: deps.nodePlatform,
    signal: deps.signal,
    progressEvery: deps.copyProgressEvery,
    checkpoint: deps.checkpoint,
    now: deps.now,
    progress: async (files, bytes) => {
      deps.progress({
        kind: "copy",
        files,
        totalFiles,
        bytes,
        totalBytes: inventory.header.byteCount,
      });
      const manifest = session.journal.copyManifest;
      if (
        manifest !== null &&
        manifest.verifiedCount !== files &&
        files < totalFiles
      ) {
        await session.advance({
          copyManifest: { ...manifest, verifiedCount: files },
        });
      }
    },
  });
  const manifest = session.journal.copyManifest;
  if (manifest === null || result.verifiedFiles !== totalFiles) {
    throw stopWith(
      "failed",
      "copy-incomplete",
      null,
      "not every file was copied and verified",
    );
  }
  await session.advance({
    phase: "repairing",
    copyManifest: { ...manifest, verifiedCount: result.verifiedFiles },
  });
}

/**
 * Mirror maintenance receipts into the journal. A store already mirrored must
 * carry the same digests (a receipt is never silently replaced); a newly
 * returned one is recorded `committed`.
 */
function mirrorReceipts(
  existing: readonly JournalAdapterReceipt[],
  receipts: MaintenanceResponse["receipts"],
): JournalAdapterReceipt[] {
  const next = [...existing];
  for (const receipt of receipts) {
    const index = next.findIndex(
      (entry) =>
        entry.storeKey === receipt.storeKey &&
        entry.adapterId === receipt.adapterId,
    );
    const mirrored: JournalAdapterReceipt = {
      storeKey: receipt.storeKey,
      adapterId: receipt.adapterId,
      adapterVersion: receipt.adapterVersion,
      preconditionDigest: receipt.inputDigest,
      outputDigest: receipt.outputDigest,
      state: "committed",
    };
    const current = next[index];
    if (current === undefined) {
      next.push(mirrored);
      continue;
    }
    if (
      current.adapterVersion !== mirrored.adapterVersion ||
      current.preconditionDigest !== mirrored.preconditionDigest ||
      current.outputDigest !== mirrored.outputDigest
    ) {
      throw stopWith(
        "conflict",
        "receipt-mismatch",
        receipt.storeKey,
        "a store's repair receipt differs from the one the journal recorded",
      );
    }
  }
  return next;
}

async function verifyCopy(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  const response = await runMaintenance(
    deps,
    session,
    "verify-copy",
    session.journal.inventoryDigest,
  );
  if (response.blockers.length > 0) throw maintenanceStop(response, null);
  const mirrored = session.journal.adapterReceipts;
  for (const receipt of response.receipts) {
    const match = mirrored.find(
      (entry) =>
        entry.storeKey === receipt.storeKey &&
        entry.adapterId === receipt.adapterId &&
        entry.preconditionDigest === receipt.inputDigest &&
        entry.outputDigest === receipt.outputDigest,
    );
    if (match === undefined) {
      throw stopWith(
        "conflict",
        "receipt-not-mirrored",
        receipt.storeKey,
        "the destination holds a repair receipt the journal never recorded",
      );
    }
  }
}

async function forwardRepairing(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  const journal = session.journal;
  await assertRootIdentity(journal.source, "source");
  await assertRootIdentity(journal.destination, "destination");
  const inventory = await loadInventory(journal);
  await assertSourceUnchanged({
    sourceRoot: journal.source.path,
    inventory,
    signal: deps.signal,
  });
  const repair = await runMaintenance(
    deps,
    session,
    "repair-copy",
    journal.inventoryDigest,
  );
  if (repair.blockers.length > 0) throw maintenanceStop(repair, null);
  await deps.checkpoint("before-receipt-mirror");
  const mirrored = mirrorReceipts(
    session.journal.adapterReceipts,
    repair.receipts,
  );
  if (
    canonicalJson(mirrored) !== canonicalJson(session.journal.adapterReceipts)
  ) {
    await session.advance({ adapterReceipts: mirrored });
  }
  await deps.checkpoint("after-receipt-mirror");
  await verifyCopy(deps, session);
  const verified: JournalAdapterReceipt[] = session.journal.adapterReceipts.map(
    (receipt) => ({
      ...receipt,
      state: "verified",
    }),
  );
  if (
    canonicalJson(verified) !== canonicalJson(session.journal.adapterReceipts)
  ) {
    await session.advance({ adapterReceipts: verified });
  }
  const roots = rootsOf(journal);
  const git = await planGitWorktreeRelocation({ roots });
  const services = await deps.services.planRelocation(
    roots,
    session.journal.actions,
  );
  const blockers = [
    ...planBlockers(git.blockers),
    ...planBlockers(services.blockers),
  ];
  if (blockers.length > 0) throw new EngineStop("blocked", blockers, null);
  await session.advance({
    phase: "preparing-external",
    actions: ledgerWithPlanned(session.journal.actions, [
      ...git.actions,
      ...services.actions,
    ]),
  });
}

async function revalidate(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  const journal = session.journal;
  await assertRootIdentity(journal.source, "source");
  await assertRootIdentity(journal.destination, "destination");
  const inventory = await loadInventory(journal);
  await assertSourceUnchanged({
    sourceRoot: journal.source.path,
    inventory,
    signal: deps.signal,
  });
  if (journal.adapterReceipts.some((receipt) => receipt.state !== "verified")) {
    throw stopWith(
      "conflict",
      "receipt-unverified",
      null,
      "a repair receipt was not verified",
    );
  }
  const ledger = await verifyLedger(journal.actions);
  if (ledger.length > 0) throw new EngineStop("conflict", ledger, null);
}

async function forwardPreparingExternal(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  await assertRootIdentity(session.journal.source, "source");
  await assertRootIdentity(session.journal.destination, "destination");
  await runStageForward(session, "prepare", deps.checkpoint);
  if (
    !stageApplied(session.journal.actions, "prepare") ||
    !stageApplied(session.journal.actions, "quiesce")
  ) {
    throw stopWith(
      "failed",
      "external-incomplete",
      null,
      "not every staged external change is in place",
    );
  }
  await revalidate(deps, session);
  await verifyCopy(deps, session);
  await session.advance({ phase: "ready" });
}

async function forwardReady(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  await revalidate(deps, session);
  await session.advance({ phase: "switching" });
}

async function forwardSwitching(
  deps: MigrationEngineDeps,
  session: JournalSession,
  bootstrapDir: string,
): Promise<void> {
  const journal = session.journal;
  const state = pointerState(bootstrapDir, journal);
  if (state === "damaged")
    throw stopWith(
      "damaged",
      "location-damaged",
      null,
      "the location record is damaged",
    );
  if (state === "other") {
    throw stopWith(
      "conflict",
      "pointer-conflict",
      null,
      "the data location record names neither the old nor this migration's location",
    );
  }
  if (state === "previous") {
    await assertRootIdentity(journal.destination, "destination");
    await session.bind();
    await deps.checkpoint("before-pointer-switch");
    await switchLocationForMigration({
      bootstrapDir,
      held: session.coordinatorLock,
      platform: deps.platform,
      journal: session.journal,
    });
    await deps.checkpoint("after-pointer-switch");
  }
  if (pointerState(bootstrapDir, session.journal) !== "migration") {
    throw stopWith(
      "conflict",
      "pointer-conflict",
      null,
      "the data location record did not take the migration's value",
    );
  }
  await session.advance({ phase: "switched" });
}

async function forwardSwitched(
  deps: MigrationEngineDeps,
  session: JournalSession,
  bootstrapDir: string,
): Promise<void> {
  if (pointerState(bootstrapDir, session.journal) !== "migration") {
    throw stopWith(
      "conflict",
      "pointer-conflict",
      null,
      "the data location record changed after the switch",
    );
  }
  await revalidate(deps, session);
  await verifyCopy(deps, session);
  // Walked again after the last maintenance run: a write to the source while
  // it ran would otherwise survive only in the backup, past rollback.
  await assertSourceUnchanged({
    sourceRoot: session.journal.source.path,
    inventory: await loadInventory(session.journal),
    signal: deps.signal,
  });
  // Durable before anything may start at the destination.
  await session.advance({ phase: "activated" });
}

async function forwardActivated(
  deps: MigrationEngineDeps,
  session: JournalSession,
): Promise<void> {
  // Forward only: a failure is reported and retried by the next recovery.
  await runStageForward(session, "activate", deps.checkpoint);
  if (!stageApplied(session.journal.actions, "activate")) {
    throw stopWith(
      "failed",
      "activation-registrations",
      null,
      "a login registration could not be re-enabled",
    );
  }
  await session.advance({ phase: "complete" });
}

// ---- Rollback driver ------------------------------------------------------------

async function runRollback(
  deps: MigrationEngineDeps,
  session: JournalSession,
  bootstrapDir: string,
): Promise<EngineResult> {
  const phase = session.journal.phase;
  if (phase === "rolled-back")
    return { kind: "done", journal: session.journal };
  if (phase !== "rollback-requested") {
    if (!rollbackAllowedFrom(phase)) {
      throw stopWith(
        "blocked",
        "rollback-refused",
        null,
        "the destination is authoritative from activation onward; the migration cannot be rolled back",
      );
    }
    if (phase === "planned") return discardPlan(session);
    await session.advance({
      phase: "rollback-requested",
      rollbackFromPhase: phase,
    });
  }
  const journal = session.journal;
  deps.progress({ kind: "phase", phase: "rollback-requested" });
  if (
    journal.rollbackFromPhase === "switching" ||
    journal.rollbackFromPhase === "switched"
  ) {
    const state = pointerState(bootstrapDir, journal);
    if (state === "damaged")
      throw stopWith(
        "damaged",
        "location-damaged",
        null,
        "the location record is damaged",
      );
    if (state === "other") {
      throw stopWith(
        "conflict",
        "pointer-conflict",
        null,
        "the data location record names neither the old nor this migration's location",
      );
    }
    if (state === "migration") {
      await session.bind();
      await deps.checkpoint("before-pointer-restore");
      await restoreLocationForRollback({
        bootstrapDir,
        held: session.coordinatorLock,
        journal: session.journal,
      });
      await deps.checkpoint("after-pointer-restore");
    }
  }
  await runLedgerInverse(session, deps.checkpoint);
  if (pointerState(bootstrapDir, session.journal) !== "previous") {
    throw stopWith(
      "conflict",
      "pointer-conflict",
      null,
      "the data location record is not the one from before the migration",
    );
  }
  const mismatches = await verifyLedger(session.journal.actions);
  if (mismatches.length > 0) throw new EngineStop("conflict", mismatches, null);
  await session.advance({ phase: "rolled-back" });
  return { kind: "done", journal: session.journal };
}

/**
 * `planned` -> `rolled-back`: nothing was mutated but the empty destination
 * this start allocated, which is removed only while it is still that folder
 * and still empty. The plan is already discarded when that removal runs, so
 * a folder that cannot be read is kept rather than failing the rollback.
 */
async function discardPlan(session: JournalSession): Promise<EngineResult> {
  const journal = await session.advance({ phase: "rolled-back" });
  if (journal.destination.directoryId !== null) {
    try {
      if (
        (await checkRootIdentity(journal.destination)).kind === "same" &&
        (await readdir(journal.destination.path)).length === 0
      ) {
        await rmdir(journal.destination.path);
      }
    } catch (error) {
      if (!isErrnoException(error)) throw error;
    }
  }
  return { kind: "done", journal };
}
