import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  evaluateStartupGate,
  readLocationRecordSync,
  readMigrationJournalSync,
  readMigrationSelectorSync,
  type StartupGateDecision,
} from "@traycer/protocol/config/data-bootstrap-records";
import type { ProcessIncarnationProbe } from "@traycer/protocol/config/data-migration-admission";
import {
  canonicalJson,
  currentComponentHandshake,
  newMigrationId,
  plannedJournal,
  sha256Digest,
  storeManifestDigest,
  type ComponentHandshake,
  type ExternalAction,
  type MaintenanceBlocker,
  type MaintenanceOperation,
  type MaintenanceResponse,
  type MigrationId,
  type MigrationJournal,
  type MigrationPhase,
  type SessionImpact,
  type StoreAdapterReceipt,
  type StoreManifestEntry,
} from "@traycer/protocol/config/data-migration-contracts";
import type { DataLocationRecord } from "@traycer/protocol/config/data-root";
import type { WindowsDataRootCommands } from "@traycer/protocol/config/data-root-target";
import type { AttemptHolderLivenessVerdict } from "@traycer/protocol/config/host-update-attempt-liveness";
import { planFileImageAction } from "../../external-actions/file-image-action";
import type {
  ExternalActionBlocker,
  ExternalActionPlan,
} from "../../external-actions/ledger";
import type { DataRootPair } from "../../external-actions/windows-task-actions";
import {
  bootstrapSecurer,
  posixDestinationPreparer,
  type MigrationEngineDeps,
} from "../engine-deps";
import {
  EngineStop,
  type EngineBlocker,
  type EngineCheckpoint,
  type EngineProgress,
  type EngineResult,
} from "../engine-types";
import { underRoot } from "../content-inventory";
import type { MaintenanceClient } from "../maintenance-client";
import { startMigration } from "../migration-engine";
import type { RootUserCensus, RootUserCensusResult } from "../root-user-census";
import type { ServiceRelocationPort } from "../service-port";

/**
 * Shared fixtures of the issue-718 migration engine suites. Everything here is
 * isolated: fresh `mkdtemp` folders (realpath-resolved, because macOS reaches
 * `/var` through `/private/var`), a fake process probe, a fake maintenance
 * client, a fake service port whose "registrations" are plain files outside
 * both data roots, and a fake process census. The real pieces are the real
 * filesystem, the real bootstrap records and admission files, the real ledger
 * reconciler and the real POSIX destination preparer.
 */

export const TEST_START_IDENTITY = "test-start-identity";
export const HOST_ID_FILE = "host/host-id";
export const PROVIDER_FILE = "host/harness-accounts/claude/p1/session.jsonl";
export const NOTES_FILE = "notes/readme with space.txt";
export const RELOCATION_DIRNAME = ".traycer-relocation";

export const STATE_ENABLED = "enabled\n";
export const STATE_DISABLED = "disabled\n";

// ---- Results ---------------------------------------------------------------------

export type StoppedResult = Extract<EngineResult, { kind: "stopped" }>;

export function assertStopped(result: EngineResult): StoppedResult {
  if (result.kind !== "stopped") {
    throw new Error(
      `expected the engine to stop, but it finished in phase ${result.journal.phase}`,
    );
  }
  return result;
}

export function assertDone(result: EngineResult): MigrationJournal {
  if (result.kind !== "done") {
    throw new Error(
      `expected the engine to finish, but it stopped (${result.reason}): ${result.blockers.map((blocker) => `${blocker.code}${blocker.object === null ? "" : ` [${blocker.object}]`}`).join(", ")}`,
    );
  }
  return result.journal;
}

export function blockerCodes(result: StoppedResult): string[] {
  return result.blockers.map((blocker) => blocker.code);
}

/** The EngineStop a copy/inventory/maintenance call throws. */
export async function captureStop(
  promise: Promise<unknown>,
): Promise<EngineStop> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineStop) return error;
    throw error;
  }
  throw new Error("expected the operation to stop with an EngineStop");
}

export function stopCodes(stop: EngineStop): string[] {
  return stop.blockers.map((blocker) => blocker.code);
}

// ---- Crash injection ---------------------------------------------------------------

export class CrashError extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`injected crash at ${point}`);
    this.name = "CrashError";
    this.point = point;
  }
}

export type RecordingCheckpoint = {
  readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
  /** Normalized checkpoint name -> times it was reached. */
  readonly counts: ReadonlyMap<string, number>;
  /** Every normalized checkpoint, in the order it was reached. */
  readonly sequence: readonly string[];
};

export function recordingCheckpoint(
  normalize: (point: string) => string,
): RecordingCheckpoint {
  const counts = new Map<string, number>();
  const sequence: string[] = [];
  return {
    counts,
    sequence,
    checkpoint: (point) => {
      const name = normalize(point);
      sequence.push(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return Promise.resolve();
    },
  };
}

export type CrashingCheckpoint = {
  readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
  readonly fired: () => boolean;
};

/** Throws a CrashError the `occurrence`-th time (1-based) the normalized `target` is reached. */
export function crashAtCheckpoint(input: {
  readonly target: string;
  readonly occurrence: number;
  readonly normalize: (point: string) => string;
}): CrashingCheckpoint {
  let seen = 0;
  let didFire = false;
  return {
    fired: () => didFire,
    checkpoint: (point) => {
      if (!didFire && input.normalize(point) === input.target) {
        seen += 1;
        if (seen === input.occurrence) {
          didFire = true;
          return Promise.reject(new CrashError(input.target));
        }
      }
      return Promise.resolve();
    },
  };
}

/** The distinct (name, occurrence) pairs a sweep covers: first and last of each name. */
export function sweepPoints(
  counts: ReadonlyMap<string, number>,
): { readonly name: string; readonly occurrence: number }[] {
  const points: { readonly name: string; readonly occurrence: number }[] = [];
  for (const [name, count] of counts) {
    points.push({ name, occurrence: 1 });
    if (count > 1) points.push({ name, occurrence: count });
  }
  return points;
}

// ---- Fake process probe --------------------------------------------------------------

export class FakeProcessProbe implements ProcessIncarnationProbe {
  /** Pids reported `alive-same` (the test process always is). */
  readonly alive = new Set<number>();
  readonly indeterminate = new Set<number>();

  ownStartIdentity(): Promise<string | null> {
    return Promise.resolve(TEST_START_IDENTITY);
  }

  liveness(pid: number): Promise<"alive" | "dead" | "indeterminate"> {
    if (pid === process.pid || this.alive.has(pid))
      return Promise.resolve("alive");
    return Promise.resolve(
      this.indeterminate.has(pid) ? "indeterminate" : "dead",
    );
  }

  verdict(pid: number): Promise<AttemptHolderLivenessVerdict> {
    if (pid === process.pid) return Promise.resolve("alive-same");
    if (this.indeterminate.has(pid)) return Promise.resolve("indeterminate");
    return Promise.resolve(this.alive.has(pid) ? "alive-same" : "dead");
  }
}

// ---- Fake root-user census -------------------------------------------------------------

export class FakeRootUserCensus implements RootUserCensus {
  result: RootUserCensusResult = { kind: "clear" };
  readonly calls: { readonly root: string }[] = [];

  census(input: {
    readonly root: string;
    readonly signal: AbortSignal;
  }): Promise<RootUserCensusResult> {
    this.calls.push({ root: input.root });
    return Promise.resolve(this.result);
  }
}

// ---- Fake maintenance client ---------------------------------------------------------------

export const DEFAULT_STORES: readonly StoreManifestEntry[] = [
  {
    storeKey: HOST_ID_FILE,
    adapterId: "identity-file",
    adapterVersion: 1,
    format: "text",
    disposition: "preserve",
    fields: [],
  },
  {
    storeKey: NOTES_FILE,
    adapterId: "opaque-file",
    adapterVersion: 1,
    format: "opaque",
    disposition: "opaque",
    fields: [],
  },
];

export type MaintenanceCall = {
  readonly operation: MaintenanceOperation;
  readonly phase: MigrationPhase;
  readonly revision: number;
  readonly inventoryDigest: string | null;
  readonly coordinatorPid: number | null;
};

export function receiptStoreKey(migrationId: MigrationId): string {
  return `host/relocation/session-impact-${migrationId}.json`;
}

/** The one receipt the fake `repair-copy` commits and `verify-copy` echoes. */
export function expectedReceipt(
  migrationId: MigrationId,
  salt: string,
): StoreAdapterReceipt {
  return {
    version: 1,
    migrationId,
    storeKey: receiptStoreKey(migrationId),
    adapterId: "session-impact-record",
    adapterVersion: 1,
    inputDigest: sha256Digest({ input: migrationId }),
    outputDigest: sha256Digest({ output: migrationId, salt }),
    committedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function freshContextImpact(sessionId: string): SessionImpact {
  return {
    sessionId,
    surface: "gui",
    provider: "claude",
    providerVersion: "1.0.0",
    profileRef: null,
    oldPrimaryDirectory: null,
    newPrimaryDirectory: null,
    providerStoreMoved: true,
    route: { primary: "fresh-context", onFailure: "hold" },
    blocker: false,
    reason: "the provider store moves with the data folder",
  };
}

export function nativeFallbackImpact(sessionId: string): SessionImpact {
  return {
    ...freshContextImpact(sessionId),
    route: { primary: "native-resume", onFailure: "fresh-context" },
  };
}

export class FakeMaintenanceClient implements MaintenanceClient {
  build = "test-host";
  stores: readonly StoreManifestEntry[] = DEFAULT_STORES;
  receiptSalt = "a";
  blockers: Partial<
    Record<MaintenanceOperation, readonly MaintenanceBlocker[]>
  > = {};
  impacts: (call: {
    readonly operation: MaintenanceOperation;
    readonly phase: MigrationPhase;
  }) => readonly SessionImpact[] = () => [];
  readonly calls: MaintenanceCall[] = [];

  async run(input: {
    readonly journal: MigrationJournal;
    readonly operation: MaintenanceOperation;
    readonly inventoryDigest: string | null;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: {
      readonly operation: MaintenanceOperation;
      readonly completedStores: number;
      readonly totalStores: number;
    }) => void;
  }): Promise<MaintenanceResponse> {
    const { journal, operation } = input;
    this.calls.push({
      operation,
      phase: journal.phase,
      revision: journal.revision,
      inventoryDigest: input.inventoryDigest,
      coordinatorPid: journal.coordinator?.pid ?? null,
    });
    if (input.signal.aborted) {
      throw new EngineStop(
        "failed",
        [
          {
            code: "cancelled",
            object: null,
            message: "the migration was cancelled",
          },
        ],
        null,
      );
    }
    const handshake: ComponentHandshake = {
      component: "maintenance",
      build: this.build,
      dataMigrationProtocol: 1,
    };
    // The real client's validateResponse: a pinned build must keep answering.
    if (
      journal.maintenanceBuild !== null &&
      canonicalJson(journal.maintenanceBuild) !== canonicalJson(handshake)
    ) {
      throw new EngineStop(
        "failed",
        [
          {
            code: "maintenance-build-changed",
            object: null,
            message: "the installed host changed during the migration",
          },
        ],
        null,
      );
    }
    input.onProgress({
      operation,
      completedStores: this.stores.length,
      totalStores: this.stores.length,
    });
    const receipts: StoreAdapterReceipt[] = [];
    if (operation === "repair-copy" || operation === "verify-copy") {
      const receipt = expectedReceipt(journal.id, this.receiptSalt);
      receipts.push(receipt);
      if (operation === "repair-copy") {
        const path = underRoot(journal.destination.path, receipt.storeKey);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, `${JSON.stringify(receipt)}\n`);
      }
    }
    return {
      version: 1,
      handshake,
      migrationId: journal.id,
      journalRevision: journal.revision,
      operation,
      provisional: operation === "inventory" && journal.phase === "planned",
      inventoryDigest: storeManifestDigest(this.stores),
      supportedAdapters: [
        { adapterId: "identity-file", adapterVersion: 1 },
        { adapterId: "session-impact-record", adapterVersion: 1 },
      ],
      receipts,
      blockers: [...(this.blockers[operation] ?? [])],
      sessionImpacts: [...this.impacts({ operation, phase: journal.phase })],
      stores: [...this.stores],
    };
  }
}

// ---- Fake service relocation port ------------------------------------------------------------

/**
 * "Registrations" are two plain files OUTSIDE both data roots: `task-state.txt`
 * (enabled -> disabled while quiescing, back to enabled after activation: one
 * chain on one object) and `task-def.txt` (retargeted from the source root to
 * the destination root while preparing). The real ledger reconciler applies and
 * inverts them.
 */
export class FakeServiceRelocationPort implements ServiceRelocationPort {
  quiesceBlockers: readonly ExternalActionBlocker[] = [];
  relocationBlockers: readonly ExternalActionBlocker[] = [];
  stopBlockers: readonly EngineBlocker[] = [];
  stopCalls = 0;
  /** Runs inside `stopRunningHosts`: a test flips the fake maintenance from running-source to clean here. */
  onStopRunningHosts: () => void = () => undefined;
  /** Ledger action id -> role label, so crash points are stable across fixtures. */
  readonly labels = new Map<string, string>();

  constructor(
    readonly statePath: string,
    readonly definitionPath: string,
  ) {}

  private labelled(label: string, action: ExternalAction): ExternalAction {
    this.labels.set(action.id, label);
    return action;
  }

  planQuiesce(): Promise<ExternalActionPlan> {
    return Promise.resolve({
      actions: [
        this.labelled(
          "quiesce:state",
          planFileImageAction({
            kind: "service-registration",
            stage: "quiesce",
            path: this.statePath,
            before: Buffer.from(STATE_ENABLED),
            after: Buffer.from(STATE_DISABLED),
          }),
        ),
      ],
      blockers: this.quiesceBlockers,
    });
  }

  planRelocation(roots: DataRootPair): Promise<ExternalActionPlan> {
    return Promise.resolve({
      actions: [
        this.labelled(
          "prepare:definition",
          planFileImageAction({
            kind: "service-registration",
            stage: "prepare",
            path: this.definitionPath,
            before: Buffer.from(definitionFor(roots.sourceRoot)),
            after: Buffer.from(definitionFor(roots.destinationRoot)),
          }),
        ),
        this.labelled(
          "activate:state",
          planFileImageAction({
            kind: "service-registration",
            stage: "activate",
            path: this.statePath,
            before: Buffer.from(STATE_DISABLED),
            after: Buffer.from(STATE_ENABLED),
          }),
        ),
      ],
      blockers: this.relocationBlockers,
    });
  }

  stopRunningHosts(): Promise<readonly EngineBlocker[]> {
    this.stopCalls += 1;
    this.onStopRunningHosts();
    return Promise.resolve(this.stopBlockers);
  }
}

export function definitionFor(root: string): string {
  return `definition root=${root}\n`;
}

// ---- Source tree ---------------------------------------------------------------------------------

let cachedLargeBlob: Buffer | null = null;

/** 1.25 MiB of deterministic bytes: crosses the copy engine's 1 MiB chunk. */
function largeBlob(): Buffer {
  if (cachedLargeBlob !== null) return cachedLargeBlob;
  const length = 1280 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for (let counter = 0; total < length; counter += 1) {
    const chunk = createHash("sha256")
      .update(`blob:${String(counter)}`)
      .digest();
    chunks.push(chunk);
    total += chunk.length;
  }
  cachedLargeBlob = Buffer.concat(chunks).subarray(0, length);
  return cachedLargeBlob;
}

type SourceFileSpec = {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
};

function sourceFileSpecs(): readonly SourceFileSpec[] {
  const text = (
    path: string,
    content: string,
    mode: number,
  ): SourceFileSpec => ({ path, bytes: Buffer.from(content, "utf8"), mode });
  return [
    text(HOST_ID_FILE, "host-0001\n", 0o600),
    text(
      PROVIDER_FILE,
      '{"turn":1,"text":"héllo wörld ✓"}\n{"turn":2,"text":"second"}\n',
      0o600,
    ),
    {
      path: "host/harness-accounts/claude/p1/nested/sidecar.bin",
      bytes: Buffer.from([0, 1, 2, 255, 254, 128]),
      mode: 0o644,
    },
    text(NOTES_FILE, "plain text with spaces\n", 0o644),
    text("notes/ünïcode-文件.txt", "unicode name\n", 0o644),
    text("deep/a/b/c/d.txt", "deep file\n", 0o644),
    text("worktrees/g/dirty-like/tracked.txt", "tracked edit\n", 0o644),
    text("worktrees/g/dirty-like/untracked file.txt", "untracked\n", 0o644),
    { path: "blob/large.bin", bytes: largeBlob(), mode: 0o640 },
  ];
}

const SOURCE_EMPTY_DIRS: readonly string[] = [
  "empty-dir",
  "worktrees/g/dirty-like/empty-sub",
];

export type SourceTreeSummary = {
  readonly byteCount: number;
  readonly fileCount: number;
  readonly filePaths: readonly string[];
};

export async function buildSourceTree(
  root: string,
): Promise<SourceTreeSummary> {
  let byteCount = 0;
  const specs = sourceFileSpecs();
  for (const spec of specs) {
    const absolute = underRoot(root, spec.path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, spec.bytes);
    await chmod(absolute, spec.mode);
    byteCount += spec.bytes.length;
  }
  for (const dir of SOURCE_EMPTY_DIRS)
    await mkdir(underRoot(root, dir), { recursive: true });
  return {
    byteCount,
    fileCount: specs.length,
    filePaths: specs.map((spec) => spec.path),
  };
}

// ---- Tree capture ----------------------------------------------------------------------------------

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function byEntryName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Every folder ("dir") and file ("file:<sha256>") below `root`, by relative path. */
export async function contentTree(
  root: string,
  exclude: (relative: string) => boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    const dir = relative === "" ? root : underRoot(root, relative);
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      byEntryName,
    )) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (exclude(child)) continue;
      if (entry.isDirectory()) {
        out.set(child, "dir");
        await walk(child);
      } else if (entry.isFile()) {
        out.set(
          child,
          `file:${sha256Of(await readFile(underRoot(root, child)))}`,
        );
      } else {
        out.set(child, "other");
      }
    }
  };
  await walk("");
  return out;
}

/** Metadata + bytes of every entry (size, mode, mtime in ns, sha256): detects any write to a tree. */
export async function factTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    const dir = relative === "" ? root : underRoot(root, relative);
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      byEntryName,
    )) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const path = underRoot(root, child);
      const stats = await lstat(path, { bigint: true });
      const mode = Number(stats.mode & 0o7777n);
      if (entry.isDirectory()) {
        out.set(child, `dir:${String(mode)}:${String(stats.mtimeNs)}`);
        await walk(child);
      } else {
        out.set(
          child,
          `file:${String(stats.size)}:${String(mode)}:${String(stats.mtimeNs)}:${sha256Of(await readFile(path))}`,
        );
      }
    }
  };
  await walk("");
  return out;
}

/** Facts of every entry below `root`, or null when `root` does not exist: detects any write to a tree. */
export async function snapshotIfPresent(
  root: string,
): Promise<Map<string, string> | null> {
  if (!(await pathExists(root))) return null;
  return factTree(root);
}

/** What the migration itself adds to a destination besides the copied tree. */
export function isMigrationAddition(relative: string): boolean {
  return (
    relative === RELOCATION_DIRNAME ||
    relative.startsWith(`${RELOCATION_DIRNAME}/`) ||
    relative === "host/relocation" ||
    relative.startsWith("host/relocation/")
  );
}

export type SourceCapture = {
  readonly content: ReadonlyMap<string, string>;
  readonly facts: ReadonlyMap<string, string>;
};

export async function captureSource(root: string): Promise<SourceCapture> {
  return {
    content: await contentTree(root, () => false),
    facts: await factTree(root),
  };
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ---- Bootstrap record readers --------------------------------------------------------------------------

export function readActiveJournal(bootstrapDir: string): MigrationJournal {
  const selector = readMigrationSelectorSync(bootstrapDir);
  if (selector.kind !== "valid" || selector.record.activeMigrationId === null) {
    throw new Error("no active migration is selected");
  }
  const journal = readMigrationJournalSync(
    bootstrapDir,
    selector.record.activeMigrationId,
  );
  if (journal.kind !== "valid")
    throw new Error(`the active journal is ${journal.kind}`);
  return journal.record;
}

export function readLocation(bootstrapDir: string): DataLocationRecord | null {
  const read = readLocationRecordSync(bootstrapDir);
  if (read.kind === "damaged")
    throw new Error(`the location record is damaged (${read.reason})`);
  return read.kind === "valid" ? read.record : null;
}

// ---- Windows commands stub -------------------------------------------------------------------------------

export const rejectingWindowsCommands: WindowsDataRootCommands = {
  probeVolume: () =>
    Promise.reject(new Error("Windows volume probe in a POSIX test")),
  applyPrivateAcl: () =>
    Promise.reject(new Error("Windows ACL in a POSIX test")),
  readAcl: () => Promise.reject(new Error("Windows ACL in a POSIX test")),
  securePrivateChildren: () =>
    Promise.reject(new Error("Windows ACL in a POSIX test")),
};

// ---- Harness ---------------------------------------------------------------------------------------------------

/** A clock that starts an hour ahead of real time (file mtimes of the run stay before it) and ticks one second per call. */
function createClock(): () => string {
  const start = Date.now() + 3_600_000;
  let ticks = 0;
  return () => {
    ticks += 1;
    return new Date(start + ticks * 1000).toISOString();
  };
}

export type HarnessParts = {
  readonly base: string;
  readonly home: string;
  readonly sourceRoot: string;
  readonly bootstrapDir: string;
  readonly destinationParent: string;
  readonly destinationRoot: string;
  readonly externalDir: string;
  readonly tree: SourceTreeSummary;
  readonly initial: SourceCapture;
  readonly probe: FakeProcessProbe;
  readonly maintenance: FakeMaintenanceClient;
  readonly services: FakeServiceRelocationPort;
  readonly census: FakeRootUserCensus;
  /** A fake packaged coordinator executable in the harness folder, and its SHA-256. */
  readonly coordinatorExecutable: string;
  readonly coordinatorExecutableSha256: string;
};

export class EngineHarness {
  readonly progressEvents: EngineProgress[] = [];
  private readonly now = createClock();

  constructor(private readonly parts: HarnessParts) {}

  get base(): string {
    return this.parts.base;
  }
  get home(): string {
    return this.parts.home;
  }
  get sourceRoot(): string {
    return this.parts.sourceRoot;
  }
  get bootstrapDir(): string {
    return this.parts.bootstrapDir;
  }
  get destinationParent(): string {
    return this.parts.destinationParent;
  }
  get destinationRoot(): string {
    return this.parts.destinationRoot;
  }
  get externalDir(): string {
    return this.parts.externalDir;
  }
  get tree(): SourceTreeSummary {
    return this.parts.tree;
  }
  /** The source as built, before any engine call. */
  get initial(): SourceCapture {
    return this.parts.initial;
  }
  get probe(): FakeProcessProbe {
    return this.parts.probe;
  }
  get maintenance(): FakeMaintenanceClient {
    return this.parts.maintenance;
  }
  get services(): FakeServiceRelocationPort {
    return this.parts.services;
  }
  get census(): FakeRootUserCensus {
    return this.parts.census;
  }
  get coordinatorExecutable(): string {
    return this.parts.coordinatorExecutable;
  }
  get coordinatorExecutableSha256(): string {
    return this.parts.coordinatorExecutableSha256;
  }

  /** Stable name for a checkpoint: a ledger action id becomes its role label. */
  normalizeCheckpoint = (point: string): string => {
    const match = /^(before|after)-action:(.+)$/u.exec(point);
    if (match === null) return point;
    const label = this.services.labels.get(match[2] ?? "");
    return `${match[1] ?? ""}-action:${label ?? match[2] ?? ""}`;
  };

  makeDeps(overrides: Partial<MigrationEngineDeps>): MigrationEngineDeps {
    const base: MigrationEngineDeps = {
      homeDir: this.home,
      platform: "posix",
      nodePlatform: process.platform,
      probe: this.probe,
      coordinatorBuild: currentComponentHandshake("cli", "test-cli"),
      coordinatorExecutable: () => Promise.resolve(this.coordinatorExecutable),
      maintenance: this.maintenance,
      services: this.services,
      census: this.census,
      destination: posixDestinationPreparer,
      secureBootstrap: bootstrapSecurer("posix", rejectingWindowsCommands),
      freeBytes: () => Promise.resolve(1_000_000_000_000),
      processDataRoot: () => this.sourceRoot,
      now: this.now,
      signal: new AbortController().signal,
      checkpoint: () => Promise.resolve(),
      progress: (event) => {
        this.progressEvents.push(event);
      },
      drain: { waitMs: 50, pollMs: 5 },
      copyProgressEvery: 2,
    };
    return { ...base, ...overrides };
  }

  /** Deps for a command run from the destination (cleanup). */
  makeDestinationDeps(
    overrides: Partial<MigrationEngineDeps>,
  ): MigrationEngineDeps {
    return this.makeDeps({
      processDataRoot: () => this.destinationRoot,
      ...overrides,
    });
  }

  gate(): StartupGateDecision {
    return evaluateStartupGate({
      homeDir: this.home,
      platform: "posix",
      processResolution: null,
    });
  }

  async readTaskState(): Promise<string> {
    return readText(this.parts.services.statePath);
  }

  async readTaskDefinition(): Promise<string> {
    return readText(this.parts.services.definitionPath);
  }

  async destinationContent(): Promise<Map<string, string>> {
    return contentTree(this.destinationRoot, isMigrationAddition);
  }

  async dispose(): Promise<void> {
    await rm(this.base, { recursive: true, force: true });
  }

  /** An admission entry for THIS process: the caller precondition the engine refuses (`coordinator-admitted`). */
  async admitThisProcess(): Promise<void> {
    await this.writeAdmissionEntry({
      pid: process.pid,
      dataMigrationProtocol: currentComponentHandshake("desktop", "test")
        .dataMigrationProtocol,
    });
  }

  /** An `admission-<uuid>.json` entry for a participant the fake probe reports running. */
  async writeAdmissionEntry(input: {
    readonly pid: number;
    readonly dataMigrationProtocol: number;
  }): Promise<void> {
    await mkdir(this.bootstrapDir, { recursive: true, mode: 0o700 });
    const entryId = randomUUID();
    const entry = {
      version: 1,
      entryId,
      pid: input.pid,
      startIdentity: "other-start-identity",
      handshake: {
        component: "desktop",
        build: "1.0.0",
        dataMigrationProtocol: input.dataMigrationProtocol,
      },
      generation: null,
      admittedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(this.bootstrapDir, `admission-${entryId}.json`),
      `${JSON.stringify(entry)}\n`,
      { mode: 0o600 },
    );
  }
}

export async function createHarness(): Promise<EngineHarness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "traycer-engine-")));
  const home = join(base, "home");
  const sourceRoot = join(home, ".traycer");
  const destinationParent = join(base, "dest");
  const externalDir = join(base, "external");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(destinationParent, { recursive: true });
  await mkdir(externalDir, { recursive: true });
  const tree = await buildSourceTree(sourceRoot);
  const statePath = join(externalDir, "task-state.txt");
  const definitionPath = join(externalDir, "task-def.txt");
  await writeFile(statePath, STATE_ENABLED);
  await writeFile(definitionPath, definitionFor(sourceRoot));
  const coordinatorExecutable = join(base, "coordinator-traycer");
  const coordinatorBytes = Buffer.from(
    "fake packaged coordinator executable\n",
  );
  await writeFile(coordinatorExecutable, coordinatorBytes, { mode: 0o644 });
  return new EngineHarness({
    base,
    home,
    sourceRoot,
    bootstrapDir: join(home, ".traycer-bootstrap"),
    destinationParent,
    destinationRoot: join(destinationParent, "data"),
    externalDir,
    tree,
    initial: await captureSource(sourceRoot),
    probe: new FakeProcessProbe(),
    maintenance: new FakeMaintenanceClient(),
    services: new FakeServiceRelocationPort(statePath, definitionPath),
    census: new FakeRootUserCensus(),
    coordinatorExecutable,
    coordinatorExecutableSha256: createHash("sha256")
      .update(coordinatorBytes)
      .digest("hex"),
  });
}

/** Creates harnesses and removes every one after each test. Call at describe level. */
export function harnessScope(): {
  readonly create: () => Promise<EngineHarness>;
} {
  const created: EngineHarness[] = [];
  afterEach(async () => {
    for (const harness of created.splice(0)) await harness.dispose();
  });
  return {
    create: async () => {
      const harness = await createHarness();
      created.push(harness);
      return harness;
    },
  };
}

/** A plain scratch folder (realpath-resolved), removed after each test. Call at describe level. */
export function scratchScope(): { readonly create: () => Promise<string> } {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0))
      await rm(path, { recursive: true, force: true });
  });
  return {
    create: async () => {
      const path = await realpath(
        await mkdtemp(join(tmpdir(), "traycer-engine-scratch-")),
      );
      created.push(path);
      return path;
    },
  };
}

// ---- Scenario helpers -----------------------------------------------------------------------------------------------

export async function runToCompletion(
  harness: EngineHarness,
): Promise<MigrationJournal> {
  return assertDone(
    await startMigration(harness.makeDeps({}), {
      destination: harness.destinationRoot,
      acceptedSessionImpactDigest: null,
      reviewImpact: false,
    }),
  );
}

/** Everything a finished migration must show, from disk. */
export async function expectCompleted(
  harness: EngineHarness,
  journal: MigrationJournal,
  before: SourceCapture,
): Promise<void> {
  expect(journal.phase).toBe("complete");
  expect(journal.activationRevision).not.toBeNull();
  expect(
    journal.activationRevision ?? Number.MAX_SAFE_INTEGER,
  ).toBeLessThanOrEqual(journal.revision);
  expect(readLocation(harness.bootstrapDir)).toEqual({
    version: 1,
    generation: journal.nextGeneration,
    root: harness.destinationRoot,
    migrationId: journal.id,
  });
  const copied = await harness.destinationContent();
  expect(copied).toEqual(before.content);
  expect(await factTree(harness.sourceRoot)).toEqual(before.facts);
  expect(journal.adapterReceipts).toEqual([
    {
      storeKey: receiptStoreKey(journal.id),
      adapterId: "session-impact-record",
      adapterVersion: 1,
      preconditionDigest: expectedReceipt(
        journal.id,
        harness.maintenance.receiptSalt,
      ).inputDigest,
      outputDigest: expectedReceipt(journal.id, harness.maintenance.receiptSalt)
        .outputDigest,
      state: "verified",
    },
  ]);
  expect(journal.actions.every((action) => action.state === "applied")).toBe(
    true,
  );
  expect(await harness.readTaskState()).toBe(STATE_ENABLED);
  expect(await harness.readTaskDefinition()).toBe(
    definitionFor(harness.destinationRoot),
  );
  expect(harness.gate().kind).toBe("open");
}

/** Everything a rolled-back migration must show, from disk. */
export async function expectRolledBack(
  harness: EngineHarness,
  journal: MigrationJournal,
  before: SourceCapture,
): Promise<void> {
  expect(journal.phase).toBe("rolled-back");
  expect(readLocation(harness.bootstrapDir)).toBeNull();
  expect(await factTree(harness.sourceRoot)).toEqual(before.facts);
  expect(await harness.readTaskState()).toBe(STATE_ENABLED);
  expect(await harness.readTaskDefinition()).toBe(
    definitionFor(harness.sourceRoot),
  );
  expect(harness.gate()).toEqual({ kind: "open", generation: null });
}

export function sampleJournal(input: {
  readonly maintenanceBuild: ComponentHandshake | null;
}): MigrationJournal {
  const planned = plannedJournal({
    id: newMigrationId(),
    previousLocation: null,
    source: {
      path: "/tmp/traycer-sample-source",
      volumeId: null,
      directoryId: null,
    },
    destination: {
      path: "/tmp/traycer-sample-destination",
      volumeId: null,
      directoryId: null,
    },
    nextGeneration: 1,
    coordinatorBuild: currentComponentHandshake("cli", "test-cli"),
    coordinatorExecutableSha256: null,
    coordinator: {
      pid: process.pid,
      startIdentity: TEST_START_IDENTITY,
      lockNonce: "sample-nonce",
    },
    now: "2026-01-01T00:00:00.000Z",
  });
  return { ...planned, maintenanceBuild: input.maintenanceBuild };
}
