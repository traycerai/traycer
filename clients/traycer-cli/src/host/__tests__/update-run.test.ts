import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `host update` on the attempt executor (`host/update-run.ts`).
//
// This is the successor of `commands/__tests__/host-update.test.ts`: the
// legacy command's on-disk and projected contracts are pinned here through
// `runHostUpdate`, plus the pins the record model adds (the under-lock claim
// selection, the writer's phase trace, the parks, the dispatch ACK).
//
// The fixture is deliberately CLOSER to production than the legacy suite's
// was. `store/paths` is sandboxed into a per-test tmpdir, so the attempt
// record, the attempt lock, the inner CLI lock, `install.json` and
// `staged.json` are all REAL files this suite reads back - the record is the
// contract now, and a fixture that mocked its store could not pin it. What
// stays mocked is what a unit test must never touch: the coarse marker file
// (a shared `mocks.disk` holder, exactly as the legacy suite modelled it, so
// the ported marker pins compare against a coherent "disk" instead of four
// primitives disagreeing), the live host (pid metadata, the identity verdict,
// the busy gate, the service controller), the actuators (transfer, apply,
// stop/relaunch, the downgrade installer) and the recovery/verification
// evidence reader.
//
// SAFETY, not convenience, for two of those: `readActivationState` reads the
// live `pid.json` and would classify a developer's own host as activation
// debt and RESTART it from a unit test, and the inner CLI lock is the
// operator's real `~/.traycer/cli/.lock`.

const currentHome = { value: "" };
vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  // Imported inside the factory: `vi.mock` factories are hoisted above this
  // file's own top-level imports, so those bindings are not yet initialized.
  const nodePath = await import("node:path");
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  // Self-sufficient: a test that throws before `beforeEach` staged a home
  // still resolves to a private directory rather than to the RELATIVE path a
  // bare `join("", ...)` would yield.
  const fallbackRoot = mkdtempSync(nodePath.join(os.tmpdir(), "update-run-"));
  const home = (): string =>
    currentHome.value === "" ? fallbackRoot : currentHome.value;
  const under = (...parts: readonly string[]): string => {
    const path = nodePath.join(home(), ...parts);
    mkdirSync(nodePath.dirname(path), { recursive: true });
    return path;
  };
  return {
    ...actual,
    hostHomeDir: (): string => home(),
    hostInstallDir: (): string => nodePath.join(home(), "install"),
    // Overridden alongside the getters: `store/paths`'s own internal callers
    // close over the REAL `hostInstallDir`, so spreading the actual module
    // would mkdir the operator's true install directory.
    ensureHostInstallDir: async (): Promise<void> => {
      mkdirSync(nodePath.join(home(), "install"), { recursive: true });
    },
    hostInstallRecordPath: (): string =>
      nodePath.join(home(), "install", "install.json"),
    hostStagedDir: (): string => nodePath.join(home(), "staged"),
    hostStagedRecordPath: (): string =>
      nodePath.join(home(), "staged", "staged.json"),
    hostPidMetadataPath: (): string => nodePath.join(home(), "pid.json"),
    hostUpdateProgressMarkerPath: (): string =>
      nodePath.join(home(), "update-progress.json"),
    // Both of these are opened for APPEND/`wx` by code that will not mkdir
    // for us, so they create their parent on the way out.
    cliLogPath: (): string => under("logs", "cli.log"),
    cliLockPath: (): string => under("cli", ".lock"),
  };
});

const mocks = vi.hoisted(() => ({
  // The fixture's model of the on-disk coarse marker file. The five marker
  // primitives are wired to this ONE holder so the mirror's "is the disk
  // still ours" decisions see a coherent file. Reset per test by `armWorld`.
  disk: { current: null } as {
    current: import("../update-progress-marker").HostUpdateProgress | null;
  },
  // The writerIds the liveness rule treats as dead - a fixture DECIDES
  // liveness explicitly rather than shelling out to a real `isProcessAlive`.
  deadWriterIds: new Set<string>(),
  readUpdateProgressMarker: vi.fn(),
  replaceUpdateProgressMarkerIfUnchanged: vi.fn(),
  deleteUpdateProgressMarkerIfUnchanged: vi.fn(),
  createUpdateProgressMarkerIfAbsent: vi.fn(),
  updateProgressRecordHasLiveWriter: vi.fn(),
  readHostPidMetadata: vi.fn(),
  identityVerdict: vi.fn(),
  assertHostNotBusy: vi.fn(),
  applyHostWithAttempt: vi.fn(),
  stopHostForRestartWithAttempt: vi.fn(),
  relaunchHostAfterRestartWithAttempt: vi.fn(),
  downloadAndStageHostInSegment: vi.fn(),
  installHostDowngradeInSegment: vi.fn(),
  observeAttemptRecoveryEvidence: vi.fn(),
  // Every record write this process makes, in order, as the phase that
  // actually landed. Populated by the pass-through wrapper below, so it spans
  // the executor's own claim and completion writes as well as the writer's.
  writes: [] as string[],
  // Models PROCESS DEATH rather than an error: with this set, the `failed`
  // write an arm would make cannot land, so the record is left exactly as the
  // last successful write left it - an ACTIVE record with no live holder,
  // which is the only shape the recovery arm exists to reconcile. Without it
  // a thrown error is just a failure, and the record says `failed`.
  refuseFailedWrites: false,
  // The stage id each mocked transfer actually placed, in order. Needed
  // because the apply CLEARS the stage, so `world.stageId` no longer names it
  // by the time a pin reads back what the apply was pinned to.
  transferStageIds: [] as string[],
  // Every dispatch ACK this run asked for, in order. The FILE only shows the
  // last one, so a run that announced `nothing-to-do` and then overwrote it
  // with a refusal is indistinguishable from one that only ever refused -
  // and those are very different answers to the host that is waiting on it.
  ackWrites: [] as string[],
}));

// A PASS-THROUGH wrapper, not a stand-in: the real commit runs and the real
// record lands on disk. The trace exists because the intermediate phases of a
// run are not observable from the final file, and "which phases were written,
// in what order" is the writer's whole contract.
vi.mock("@traycer-clients/shared/host-update/contender", async () => {
  const actual = await vi.importActual<
    typeof import("@traycer-clients/shared/host-update/contender")
  >("@traycer-clients/shared/host-update/contender");
  return {
    ...actual,
    commitExecutorAttemptMutation: async (
      capability: import("@traycer-clients/shared/host-update").UpdateMutationCapability,
      hostHomeDir: string,
      intent: Exclude<
        import("@traycer-clients/shared/host-update").AttemptMutationIntent,
        { readonly kind: "recover" }
      >,
    ): Promise<
      import("@traycer-clients/shared/host-update").AttemptCommitOutcome
    > => {
      if (
        mocks.refuseFailedWrites &&
        intent.kind === "advance" &&
        intent.advance.phase === "failed"
      ) {
        throw new Error("the process died before it could record a failure");
      }
      const outcome = await actual.commitExecutorAttemptMutation(
        capability,
        hostHomeDir,
        intent,
      );
      mocks.writes.push(
        outcome.kind === "committed"
          ? outcome.record.phase
          : `refused:${outcome.kind}`,
      );
      return outcome;
    },
    // The RECOVERY write is a different export, and recording it is what makes
    // "A's interrupted attempt was terminalized before B started" observable
    // at all: without it the trace of a reselect is indistinguishable from a
    // run that simply found a terminal record and started over. Tagged, so a
    // recovery's `complete` is never read as an ordinary completion.
    commitExecutorRecoveryMutation: async (
      capability: import("@traycer-clients/shared/host-update").UpdateMutationCapability,
      hostHomeDir: string,
      intent: Extract<
        import("@traycer-clients/shared/host-update").AttemptMutationIntent,
        { readonly kind: "recover" }
      >,
    ): Promise<
      import("@traycer-clients/shared/host-update").AttemptCommitOutcome
    > => {
      const outcome = await actual.commitExecutorRecoveryMutation(
        capability,
        hostHomeDir,
        intent,
      );
      mocks.writes.push(
        outcome.kind === "committed"
          ? `recovered:${outcome.record.phase}`
          : `recovery-refused:${outcome.kind}`,
      );
      return outcome;
    },
  };
});

vi.mock("../update-progress-marker", () => ({
  readUpdateProgressMarker: mocks.readUpdateProgressMarker,
  replaceUpdateProgressMarkerIfUnchanged:
    mocks.replaceUpdateProgressMarkerIfUnchanged,
  deleteUpdateProgressMarkerIfUnchanged:
    mocks.deleteUpdateProgressMarkerIfUnchanged,
  createUpdateProgressMarkerIfAbsent: mocks.createUpdateProgressMarkerIfAbsent,
  updateProgressRecordHasLiveWriter: mocks.updateProgressRecordHasLiveWriter,
  progressRecord: (fields: {
    state: "updating" | "failed";
    error: string | null;
    targetVersion: string;
  }): import("../update-progress-marker").HostUpdateProgress => ({
    ...fields,
    updatedAt: new Date().toISOString(),
    writerId: "test-writer",
  }),
  // The REAL comparator (not a `vi.fn()`), so the "is this marker still ours"
  // decisions under test compare the way production does.
  sameProgress: (
    a: import("../update-progress-marker").HostUpdateProgress,
    b: import("../update-progress-marker").HostUpdateProgress,
  ): boolean =>
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error &&
    a.writerId === b.writerId,
}));

// A recording PASS-THROUGH: the real writer still publishes the real bytes,
// so the ACK file stays the thing under test; this only observes the order.
vi.mock("../update-dispatch-ack", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../update-dispatch-ack")>();
  return {
    ...actual,
    installDispatchAckStamper: (
      hostHomeDir: string,
      nonce: string | null,
    ): import("../update-dispatch-ack").DispatchAckStamper | null => {
      const real = actual.installDispatchAckStamper(hostHomeDir, nonce);
      if (real === null) return null;
      return {
        acknowledge: async (claim) => {
          mocks.ackWrites.push("claimed");
          await real.acknowledge(claim);
        },
        noAttempt: async (reason: string) => {
          mocks.ackWrites.push(reason);
          await real.noAttempt(reason);
        },
      };
    },
  };
});

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadata,
}));
vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: mocks.identityVerdict,
}));
vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusy,
}));
vi.mock("../../service", () => ({
  createServiceController: () => ({}),
  serviceLabelFor: (environment: string) => ({
    id: `ai.traycer.host.${environment}`,
    displayName: "Traycer Host",
    environment,
    devSlot: null,
  }),
}));
vi.mock("../update-mutation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../update-mutation")>();
  return {
    ...actual,
    applyHostWithAttempt: mocks.applyHostWithAttempt,
    stopHostForRestartWithAttempt: mocks.stopHostForRestartWithAttempt,
    relaunchHostAfterRestartWithAttempt:
      mocks.relaunchHostAfterRestartWithAttempt,
  };
});
// SAFETY, and the reason the shell pins below can exist at all: a
// `registryClient` of `null` means "build the DEFAULT client", which on a
// networked machine reaches the real registry over the network. Every pin that
// drives `runHostUpdate` passes an explicit client, but `buildHostUpdateCommand`
// hard-codes `null` - so without this the shell pins would fire live HTTP, and
// any future pin that forgot its client would too (that mistake was made once
// already, in an earlier "the registry is unreachable" pin that quietly passed
// `null` and asserted nothing).
vi.mock("../../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry")>();
  return {
    ...actual,
    createDefaultRegistryClient: async (): Promise<RegistryClient> =>
      fakeRegistry(),
  };
});
// The ARGV pins below drive the real `buildProgram()`, and `runCommand` is
// what stands between Commander's action and the command function. Its job -
// resolving runtime flags, building an output sink, mapping a throw to a
// process exit code - is another suite's subject, and here it would swallow
// the very rejection these pins assert. Replaced with the thinnest adapter
// that still runs the REAL registration, the REAL parse and the REAL command:
// `index.ts` is the thing under test on those two pins, not this.
vi.mock("../../runner/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/runner")>();
  return {
    ...actual,
    runCommand: async (
      fn: import("../../runner/runner").CommandFn,
    ): Promise<void> => {
      await fn(shellContext());
    },
  };
});

// `resolveUpdatePlan` stays REAL - the advisory plan is under test, and its
// registry access is already seamed through `registryClient`. Only the
// actuator is replaced.
vi.mock("../../installer/download-stage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../installer/download-stage")>();
  return {
    ...actual,
    downloadAndStageHostInSegment: mocks.downloadAndStageHostInSegment,
  };
});
vi.mock("../../commands/host-update-downgrade", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../commands/host-update-downgrade")
    >();
  return {
    ...actual,
    installHostDowngradeInSegment: mocks.installHostDowngradeInSegment,
  };
});
// Drives BOTH the executor's recovery arm and this command's verification
// loop; `sameAttemptRecoveryEvidenceObservation` stays real so the
// two-read stability check compares the way production does.
vi.mock("../update-recovery-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../update-recovery-evidence")>();
  return {
    ...actual,
    observeAttemptRecoveryEvidence: mocks.observeAttemptRecoveryEvidence,
  };
});

import {
  readUpdateAttemptRecord,
  updateAttemptRecordPath,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  decodeUpdateDispatchAck,
  updateDispatchAckPath,
} from "@traycer/protocol/config/host-update-ack";
import { runHostUpdate, type HostUpdateRunArgs } from "../update-run";
import { buildHostUpdateCommand } from "../../commands/host-update";
import { buildProgram } from "../../index";
import { verifyHostUpdateAttempt } from "../update-verify";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
  deleteHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import { hostStagedDir } from "../../store/paths";
import { CLI_ERROR_CODES, CliError, cliError } from "../../runner/errors";
import type { ILogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";
import type { ProgressInfo } from "../../runner/output";
import type { RegistryClient } from "../../registry";
import type { HostUpdateProgress } from "../update-progress-marker";
import type { AttemptRecoveryEvidenceObservation } from "../update-recovery-evidence";
import type { HostPidMetadata } from "../pid-metadata";

const ENVIRONMENT = "production";
const roots: string[] = [];

/**
 * The world the fixture models: what is installed, what is staged, and what
 * the live host is serving. The actuators move it, and the evidence reader
 * reports it, so a run's success condition is reached the way production
 * reaches it rather than by a canned verdict.
 */
const world = {
  installedVersion: null as string | null,
  installId: "install-seed",
  installedAt: "2026-01-01T00:00:00.000Z",
  runtimeVersion: null as string | null,
  stagedVersion: null as string | null,
  stageId: null as string | null,
  /** Bumped by every staging, so two stages of one version differ by id. */
  stageSerial: 0,
  runningVersion: null as string | null,
  latest: "2.0.0",
};

function installRecordOf(version: string): HostInstallRecord {
  return {
    installId: world.installId,
    version,
    runtimeVersion: world.runtimeVersion,
    platform: "darwin",
    arch: "arm64",
    installedAt: world.installedAt,
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function stagedRecordOf(version: string, stageId: string): HostStagedRecord {
  return {
    schemaVersion: 1,
    stageId,
    version,
    runtimeVersion: null,
    archiveSha256: "b".repeat(64),
    sizeBytes: 1,
    source: { kind: "registry", value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    // RELATIVE to `staged/` by contract: the reader rejects a sidecar whose
    // executable escapes the staged directory, and an absolute path is the
    // first thing it refuses.
    executablePath: "bin/traycer-host",
    platform: "darwin",
    arch: "arm64",
    executableSha256: null,
  };
}

async function seedInstalled(version: string | null): Promise<void> {
  world.installedVersion = version;
  if (version === null) {
    await deleteHostInstallRecord(ENVIRONMENT);
    return;
  }
  await writeHostInstallRecord(ENVIRONMENT, installRecordOf(version));
}

async function seedStaged(version: string | null): Promise<void> {
  const dir = hostStagedDir(ENVIRONMENT);
  if (version === null) {
    world.stagedVersion = null;
    world.stageId = null;
    await rm(join(dir, "staged.json"), { force: true });
    return;
  }
  world.stagedVersion = version;
  // INDEPENDENT per staging, deliberately: a stage id derived from the version
  // alone makes a REPLACEMENT invisible - re-staging 2.0.0 produced the same
  // fingerprint as the one a park had already claimed, so "the claim's
  // fingerprint" and "whatever is on disk now" were the same string and
  // neither of the two binding rules could be told from the other. The serial
  // resets per test, so within one test the ids are still deterministic.
  world.stageSerial += 1;
  world.stageId = `stage-${version}#${world.stageSerial}`;
  await mkdir(dir, { recursive: true });
  await writeHostStagedRecordAt(dir, stagedRecordOf(version, world.stageId));
}

function installGenerationNow(): string {
  return encodeInstallGeneration({
    installId: world.installId,
    installedAt: world.installedAt,
    archiveSha256: "a".repeat(64),
    version: world.installedVersion ?? "0.0.0",
  });
}

function pidMetadata(version: string): HostPidMetadata {
  return {
    pid: 4242,
    hostId: "host-1",
    version,
    websocketUrl: "ws://127.0.0.1:1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: null,
    layer0: null,
    layer0Slot: null,
  };
}

/** The evidence both the recovery arm and the verification loop read. */
function observationOfWorld(): AttemptRecoveryEvidenceObservation {
  const installed = world.installedVersion;
  const running = world.runningVersion;
  const evidence = {
    installed:
      installed === null
        ? ({ kind: "absent" } as const)
        : ({ kind: "verified", version: installed } as const),
    staged:
      world.stagedVersion === null
        ? ({ kind: "absent" } as const)
        : ({ kind: "verified", version: world.stagedVersion } as const),
    running:
      running === null
        ? ({ kind: "absent" } as const)
        : ({
            kind: "verified",
            version: running,
            owner: "host-home-bound",
          } as const),
  };
  return {
    evidence,
    fingerprint: JSON.stringify(evidence),
    installIdentity:
      installed === null
        ? null
        : {
            installId: world.installId,
            installedAt: world.installedAt,
            archiveSha256: "a".repeat(64),
            version: installed,
          },
    stageFingerprint: world.stageId,
  };
}

function fakeRegistry(): RegistryClient {
  const entryFor = (version: string) => ({
    version,
    releasedAt: "2026-01-01T00:00:00.000Z",
    releaseNotesUrl: `https://example.invalid/${version}`,
    yanked: false,
    deprecationReason: null,
    requiredCliVersion: null,
    minimumEpoch: null,
    platforms: {
      "darwin-arm64": {
        available: true,
        unavailableReason: null,
        url: `https://example.invalid/${version}.tar.gz`,
        sizeBytes: 1,
        sha256: "b".repeat(64),
        signatureUrl: `https://example.invalid/${version}.tar.gz.minisig`,
        signatureAlgorithm: "minisign" as const,
        publicKeyId: "test-key",
      },
    },
  });
  return {
    fetchManifest: async () => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-01-01T00:00:00.000Z",
      latest: world.latest,
      versions: [entryFor(world.latest)],
    }),
    resolveAsset: async (versionRequest: string) => {
      const entry = entryFor(versionRequest);
      return { entry, asset: entry.platforms["darwin-arm64"] };
    },
    downloadAndVerify: async () => {
      throw new Error("the transfer actuator is mocked; this must not run");
    },
  };
}

/**
 * A registry every method of which throws. Passing `null` would fall back to
 * the REAL default client - which on a networked machine succeeds, making any
 * "the registry is unreachable" claim vacuous (and firing a real network call
 * from a unit test). This is what makes "an `activate` never reaches the
 * registry" an assertion rather than a hope.
 */
function unreachableRegistry(): RegistryClient {
  const refuse = (): never => {
    throw new Error("the registry must not be reached on this path");
  };
  return {
    fetchManifest: async () => refuse(),
    resolveAsset: async () => refuse(),
    downloadAndVerify: async () => refuse(),
  };
}

function fakeLogger(): ILogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface RunOverrides {
  readonly versionRequest?: string | null;
  readonly allowDowngrade?: boolean;
  readonly force?: boolean;
  readonly ackNonce?: string | null;
  /**
   * RAW, exactly as argv delivers it - `HostUpdateRunArgs.intent` is a
   * `string`, and refusing an illegal value is the run's own job (Plan D16).
   * A union here would make the illegal-value exit unreachable from a test.
   */
  readonly intent?: string | null;
  readonly expectAttempt?: string | null;
  readonly registryClient?: RegistryClient | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (info: ProgressInfo) => void;
}

let logger: ILogger;

function runArgs(overrides: RunOverrides): HostUpdateRunArgs {
  return {
    environment: ENVIRONMENT,
    logger,
    onProgress: overrides.onProgress ?? ((): void => {}),
    versionRequest: overrides.versionRequest ?? null,
    allowDowngrade: overrides.allowDowngrade ?? false,
    force: overrides.force ?? false,
    ackNonce: overrides.ackNonce ?? null,
    intent: overrides.intent ?? null,
    expectAttempt: overrides.expectAttempt ?? null,
    registryClient:
      overrides.registryClient === undefined
        ? fakeRegistry()
        : overrides.registryClient,
    // The evidence loop's real budget is 45s; the fixture's world flips in
    // one actuator call, so a short budget keeps the deadline arm fast
    // without changing which branch runs.
    verifyBudgetMs: 200,
    verifyPollIntervalMs: 5,
  };
}

function runUpdate(overrides: RunOverrides) {
  return runHostUpdate(runArgs(overrides), overrides.env ?? {});
}

/**
 * The distinct phase transitions this process wrote, in order.
 *
 * The executor's TERMINAL completion write is deliberately absent: it lands
 * through the completion session rather than `commitExecutorAttemptMutation`,
 * and the record on disk is the pin for it. Everything the claim and the
 * writer produce is here.
 */
function phaseTrace(): readonly string[] {
  return mocks.writes.filter(
    (phase, index) => index === 0 || mocks.writes[index - 1] !== phase,
  );
}

async function readRecord(): Promise<HostUpdateAttemptRecord | null> {
  const read = await readUpdateAttemptRecord(currentHome.value);
  return read.kind === "valid" ? read.value : null;
}

/** The record as it must exist for a pin that is about to read its fields. */
async function requireRecord(): Promise<HostUpdateAttemptRecord> {
  const record = await readRecord();
  if (record === null) throw new Error("expected an attempt record on disk");
  return record;
}

/**
 * Drop the `claim` baseline from the record on disk, producing the
 * pre-D19 shape a park written by an older CLI has. Written through the real
 * decoder's own JSON form rather than hand-rolled, so the result is a record
 * the reader accepts for the same reason a real one is.
 */
async function stripClaimFromRecordOnDisk(): Promise<void> {
  await editRecordOnDisk((parsed) => {
    delete parsed.claim;
  });
}

/**
 * Rewrite the claim BASELINE on the parked record.
 *
 * Needed because some baselines cannot be minted by any legal run: a park
 * whose target is BELOW its baseline and whose `allowDowngrade` is `false` is
 * one, since the plan refuses to produce a downgrade without the flag. The
 * selector must still refuse it - a record is durable, and the consent test
 * has to hold for whatever a record says rather than for whatever this build
 * happens to be able to write.
 */
async function patchClaimOnDisk(
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  await editRecordOnDisk((parsed) => {
    parsed.claim = { ...(parsed.claim as Record<string, unknown>), ...patch };
  });
}

async function editRecordOnDisk(
  edit: (parsed: Record<string, unknown>) => void,
): Promise<void> {
  const path = updateAttemptRecordPath(currentHome.value);
  const parsed: Record<string, unknown> = JSON.parse(
    await readFile(path, "utf8"),
  );
  edit(parsed);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * A `CommandContext` for the pins that drive the SHELL rather than the run.
 *
 * The shell owns the human summary and the `--json` payload, and neither is
 * reachable from `runHostUpdate`: a legacy assertion about what an operator
 * reads has to go through `buildHostUpdateCommand` or it is not pinned at all.
 */
function shellContext(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: ENVIRONMENT,
      logger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function busyError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_BUSY,
    message: "host update: the host is busy.",
    details: { environment: ENVIRONMENT },
    exitCode: 1,
  });
}

interface ApplyMockOptions {
  readonly onProgress: (info: ProgressInfo) => void;
  readonly hooks: {
    readonly beforeSwapCommit: () => Promise<void>;
    readonly afterSwap: () => Promise<void>;
  };
  /**
   * Production passes NONE - the mirror is record-driven, and this hook fires
   * BEFORE the cooperative stop, so a denial there must still park from
   * `preparing`. The fixture invokes it when it is present precisely so that
   * an implementation which DID write `applying` here would be observable.
   */
  readonly onWillCommitStaged:
    | ((stagedVersion: string) => Promise<void>)
    | undefined;
  readonly expectedStageFingerprint: string | null;
  readonly force: boolean;
}

/** The apply outcome shape `projectApplied` reads. */
function appliedOutcome(previousVersion: string, version: string) {
  return {
    outcome: "applied" as const,
    record: installRecordOf(version),
    previous: installRecordOf(previousVersion),
    runningActivated: true,
    installGeneration: `id:${world.installId}`,
    serviceLifecycle: {
      priorServiceState: "running" as const,
      stoppedBeforeSwap: true,
      postSwapAction: "restart" as const,
    },
    postSwapError: null,
  };
}

const progress = (stage: string, percent: number | null): ProgressInfo => ({
  stage,
  message: null,
  percent,
  bytes: percent === null ? null : percent,
  totalBytes: percent === null ? null : 100,
  workUnits: null,
});

/**
 * Re-arms every default. `resetAllMocks` wipes implementations, so this runs
 * per test rather than once.
 *
 * The marker primitives are wired to `mocks.disk` - one holder modelling the
 * file - rather than given independent canned answers: a
 * `readUpdateProgressMarker` that always answered `null` would make the entry
 * mirror see an empty path and republish over its own live record, a write
 * this run did not intend. A test that needs a FOREIGN writer or a lost CAS
 * still overrides an individual mock on top of this wiring.
 */
function armWorld(): void {
  mocks.disk.current = null;
  mocks.deadWriterIds = new Set<string>();
  mocks.writes.length = 0;
  mocks.refuseFailedWrites = false;
  mocks.ackWrites.length = 0;
  mocks.transferStageIds.length = 0;

  mocks.readUpdateProgressMarker.mockImplementation(
    async () => mocks.disk.current,
  );
  // The real rule shape: a `failed` has no writer by construction, and an
  // `updating` is live unless the test declared its writer dead.
  mocks.updateProgressRecordHasLiveWriter.mockImplementation(
    (record: HostUpdateProgress) =>
      record.state !== "failed" &&
      (record.writerId === null || !mocks.deadWriterIds.has(record.writerId)),
  );
  mocks.replaceUpdateProgressMarkerIfUnchanged.mockImplementation(
    async (
      _environment: string,
      expected: HostUpdateProgress,
      next: HostUpdateProgress,
    ) => {
      if (
        mocks.disk.current !== null &&
        sameProgressLocal(mocks.disk.current, expected)
      ) {
        mocks.disk.current = next;
        return "replaced";
      }
      return "changed";
    },
  );
  mocks.deleteUpdateProgressMarkerIfUnchanged.mockImplementation(
    async (_environment: string, expected: HostUpdateProgress) => {
      if (mocks.disk.current === null) return "absent";
      if (sameProgressLocal(mocks.disk.current, expected)) {
        mocks.disk.current = null;
        return "cleared";
      }
      return "changed";
    },
  );
  mocks.createUpdateProgressMarkerIfAbsent.mockImplementation(
    async (_environment: string, next: HostUpdateProgress) => {
      if (mocks.disk.current !== null) return "exists";
      mocks.disk.current = next;
      return "created";
    },
  );

  mocks.readHostPidMetadata.mockImplementation(async () =>
    world.runningVersion === null ? null : pidMetadata(world.runningVersion),
  );
  mocks.identityVerdict.mockResolvedValue("current");
  mocks.assertHostNotBusy.mockResolvedValue(undefined);
  mocks.observeAttemptRecoveryEvidence.mockImplementation(async () =>
    observationOfWorld(),
  );

  // The transfer: verified bytes on disk and an unbuilt tree at
  // `beforeExtract`, a staged record after it.
  mocks.downloadAndStageHostInSegment.mockImplementation(
    async (options: {
      readonly versionRequest: string | null;
      readonly onProgress: (info: ProgressInfo) => void;
      readonly beforeExtract: () => Promise<void>;
    }) => {
      const target = options.versionRequest ?? world.latest;
      options.onProgress(progress("download", 50));
      await options.beforeExtract();
      await seedStaged(target);
      if (world.stageId !== null) mocks.transferStageIds.push(world.stageId);
      // The real outcome shape, so an arm that reads it (the apply binding
      // reports it in its refusal details) sees what production would give it.
      return {
        outcome: "promoted" as const,
        stagedVersion: target,
        installedVersion: world.installedVersion,
      };
    },
  );

  // The apply: the two barriers in production order, with `service-stop` and
  // `swap` on the progress stream exactly where `commitInstallFromSource`
  // emits them.
  mocks.applyHostWithAttempt.mockImplementation(
    async (
      _capability: unknown,
      _contenderOptions: unknown,
      options: ApplyMockOptions,
    ) => {
      const target = world.stagedVersion;
      if (target === null) return { outcome: "no-op" as const };
      // The REAL refusal, modelled (`installer/apply.ts`): a non-null expected
      // fingerprint that does not name the stage actually on disk is a
      // replaced handoff, and the installer answers
      // `stage-fingerprint-mismatch` rather than committing it. Without this
      // the fixture ignored `expectedStageFingerprint` entirely, so which
      // fingerprint the runner chose to pass had no observable consequence
      // and either choice could be inverted with every test still green.
      if (
        options.expectedStageFingerprint !== null &&
        options.expectedStageFingerprint !== world.stageId
      ) {
        return {
          outcome: "stage-fingerprint-mismatch" as const,
          installedVersion: world.installedVersion ?? target,
          expectedStageFingerprint: options.expectedStageFingerprint,
          actualStageFingerprint: world.stageId,
        };
      }
      const previous = world.installedVersion ?? target;
      // Production passes none; the fixture fires it when present so an
      // implementation that wrote a phase here would be observable.
      await options.onWillCommitStaged?.(target);
      options.onProgress(progress("service-stop", null));
      await options.hooks.beforeSwapCommit();
      options.onProgress(progress("swap", null));
      await seedInstalled(target);
      await seedStaged(null);
      world.runningVersion = target;
      await options.hooks.afterSwap();
      return appliedOutcome(previous, target);
    },
  );

  mocks.installHostDowngradeInSegment.mockImplementation(
    async (input: {
      readonly version: string;
      readonly onProgress: (info: ProgressInfo) => void;
      readonly beforeExtract: () => Promise<void>;
      readonly hooks: ApplyMockOptions["hooks"];
    }) => {
      const previous = world.installedVersion ?? input.version;
      await input.beforeExtract();
      input.onProgress(progress("service-stop", null));
      await input.hooks.beforeSwapCommit();
      input.onProgress(progress("swap", null));
      await seedInstalled(input.version);
      world.runningVersion = input.version;
      await input.hooks.afterSwap();
      return appliedOutcome(previous, input.version);
    },
  );

  // Models the facade's boundary: the capability check passed and the
  // actuator is about to stop the host, so `onAuthorityVerified` fires before
  // the (mock) stop returns. A test that needs the CHECK to fail rejects
  // WITHOUT calling it.
  mocks.stopHostForRestartWithAttempt.mockImplementation(
    async (
      _capability: unknown,
      _contenderOptions: unknown,
      _controller: unknown,
      _label: unknown,
      _options: unknown,
      onAuthorityVerified: (() => void) | null,
    ) => {
      onAuthorityVerified?.();
      world.runningVersion = null;
      return { forcedRecycle: false };
    },
  );
  mocks.relaunchHostAfterRestartWithAttempt.mockImplementation(async () => {
    world.runningVersion = world.installedVersion;
  });
}

/** The comparator the mocked module hands production, reused by the fixture. */
function sameProgressLocal(
  a: HostUpdateProgress,
  b: HostUpdateProgress,
): boolean {
  return (
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error &&
    a.writerId === b.writerId
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  const root = await mkdtemp(join(tmpdir(), "update-run-test-"));
  roots.push(root);
  currentHome.value = join(root, "host-home");
  await mkdir(currentHome.value, { recursive: true });
  world.installedVersion = null;
  world.installId = "install-seed";
  world.installedAt = "2026-01-01T00:00:00.000Z";
  world.runtimeVersion = null;
  world.stagedVersion = null;
  world.stageId = null;
  world.stageSerial = 0;
  world.runningVersion = null;
  world.latest = "2.0.0";
  logger = fakeLogger();
  armWorld();
});

afterEach(async () => {
  currentHome.value = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------

describe("runHostUpdate - the install intent's arms", () => {
  // The other pins that used to live here have a legacy ancestor in
  // `commands/__tests__/host-update.test.ts`'s `buildHostUpdateCommand
  // composite` or `update-progress marker (T16)` blocks and have moved to
  // `ported: buildHostUpdateCommand composite` / `ported: update-progress
  // marker (T16)` below, under their legacy titles, so a legacy row's
  // coverage is never split across two describes. This pin has no legacy
  // ancestor (D19 is new behaviour) and stays.
  it("the claim baseline carries the plan's install identity, encoded the way every other writer encodes it, and the park refreshes its stage fingerprint", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    // Park it before the apply so the claim is readable on disk.
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    const record = await requireRecord();
    expect(record.claim).toEqual({
      // Minted at the `start` from the plan's identity - and byte-comparable
      // with the generation an installer attests, because both go through
      // `encodeInstallGeneration`.
      installedVersion: "1.0.0",
      installGeneration: installGenerationNow(),
      allowDowngrade: false,
      // Refreshed AT THE PARK: the transfer ran under this claim, so the
      // stage the resume will find is this run's own - the id THIS transfer
      // minted, which (stage ids being independent per staging) is not the id
      // any other staging of 2.0.0 would have produced.
      stageFingerprint: world.stageId,
    });
  });

  it("a transfer whose promotion is DISCARDED never applies the unrelated stage it left standing", async () => {
    await seedInstalled("1.0.0");
    // A stage for a HIGHER version was simply already there - no interleaving,
    // no competing writer. `decideHostDownloadPromotion` answers
    // `discard {not-strictly-newer}` for the 2.0.0 candidate and keeps it.
    await seedStaged("3.0.0");
    world.runningVersion = "1.0.0";
    world.latest = "2.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: {
        readonly onProgress: (info: ProgressInfo) => void;
        readonly beforeExtract: () => Promise<void>;
      }) => {
        options.onProgress(progress("download", 50));
        await options.beforeExtract();
        return {
          outcome: "discarded" as const,
          reason: "not-strictly-newer" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(
      runUpdate({ ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      details: {
        targetVersion: "2.0.0",
        stagedVersion: "3.0.0",
        // The transfer's own account of what it did. A `discarded` outcome is
        // not an error - the policy was right to keep the newer stage, and
        // wrong only if this attempt then applied it.
        transferOutcome: "discarded",
        transferReason: "not-strictly-newer",
      },
    });

    // The apply is never reached. A `null` expected fingerprint means
    // "whatever is staged", and whatever is staged here is a version this
    // claim never named: 3.0.0 would be installed under a claim for 2.0.0,
    // and the verification would then fail for the wrong reason.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(world.installedVersion).toBe("1.0.0");
    const record = await requireRecord();
    expect(record.targetVersion).toBe("2.0.0");
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    // Terminal, never a refusal - the same family as the identity
    // re-validation, and for the same reason.
    expect(record.execution).toBe("terminal");
    // The claim was durable before the refusal, so the dispatcher hears the
    // attempt rather than a `no-attempt`.
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: record.attemptId,
    });
    // The coarse marker names the CLAIM's target, not the bytes on disk.
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });
});

describe("runHostUpdate - the activation-debt arm, decided under the lock", () => {
  // The other pins that used to live here have a legacy ancestor in
  // `commands/__tests__/host-update.test.ts`'s `— activation debt
  // (installed-up-to-date short-circuit)` block and have moved to
  // `ported: activation debt (installed-up-to-date short-circuit)` below,
  // under their legacy titles. This pin has no legacy ancestor (D5's
  // continuation model) and stays; it also satisfies that legacy block's
  // "the host is busy: assertHostNotBusy rejects, the run PARKS - its own
  // updating marker is withdrawn, nothing is stamped failed, and restart
  // never runs" row, since the assertions here already cover the marker
  // withdrawal on this exact park.
  it("the debt start is born with continuation=activate, so a busy gate has a legal park", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("waiting-to-activate");
    expect(record.continuation).toBe("activate");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.writes).not.toContain("failed");
    expect(mocks.disk.current).toBeNull();
  });
});

describe("runHostUpdate - bound intents", () => {
  /** Park an upgrade at `waiting-for-work` and return its attempt id. */
  async function parkUpgrade(target: string): Promise<string> {
    world.latest = target;
    mocks.applyHostWithAttempt.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    mocks.writes.length = 0;
    // The park is the fixture, not the subject: its own actuator calls must
    // not be counted against the resume under test.
    mocks.downloadAndStageHostInSegment.mockClear();
    mocks.applyHostWithAttempt.mockClear();
    mocks.transferStageIds.length = 0;
    return record.attemptId;
  }

  it("continue on an upgrade park resumes from the stage already on disk and completes", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    expect(world.stagedVersion).toBe("2.0.0");

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
    });

    // The park's own bytes: no second transfer, and no registry resolution.
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(phaseTrace()).toEqual([
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    expect(outcome.legacy.version).toBe("2.0.0");
  });

  it("continue names an attempt that is gone: released refused-attempt-gone, nothing claimed", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: "attempt-that-never-existed",
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    expect(outcome.releasedReason).toBe("refused-attempt-gone");
    expect(await readRecord()).toBeNull();
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-attempt-gone",
    });
  });

  it("activate on a record that is not a waiting-to-activate park refuses rather than starting anything", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");

    const outcome = await runUpdate({
      intent: "activate",
      expectAttempt: attemptId,
    });

    expect(outcome.releasedReason).toBe("refused-attempt-gone");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect((await requireRecord()).phase).toBe("waiting-for-work");
  });

  it("activate resumes a waiting-to-activate park and completes, with the registry unreachable", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "activate",
      expectAttempt: parked.attemptId,
      // An `activate` must STRUCTURALLY never reach the registry: its plan
      // request carries no version to resolve.
      registryClient: unreachableRegistry(),
    });

    // `preparing` is the resume claim's own initial phase.
    expect(phaseTrace()).toEqual(["preparing", "restarting", "verifying"]);
    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("continue on a waiting-to-activate park completes with the registry unreachable too", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    // An activation park has no stage, and needs none: there is nothing to
    // transfer, only a host to restart.
    expect(world.stagedVersion).toBeNull();
    mocks.writes.length = 0;

    // `continue` is the reconciler's generic "carry on with this attempt", so
    // it meets activation parks as well as apply parks. Deriving the advisory
    // transfer need from stage PRESENCE alone made it resolve an asset here -
    // every idle reconciler tick reaching the registry to fetch bytes that
    // this arm will never use, and failing outright when the host is offline.
    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: parked.attemptId,
      versionRequest: "2.0.0",
      registryClient: unreachableRegistry(),
    });

    expect(outcome.releasedReason).toBeNull();
    expect(phaseTrace()).toEqual(["preparing", "restarting", "verifying"]);
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
  });

  it("a claim-less waiting-to-activate park is unverifiable: activate refuses and never restarts", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    await stripClaimFromRecordOnDisk();
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "activate",
      expectAttempt: parked.attemptId,
      registryClient: unreachableRegistry(),
    });

    // Version ordering cannot establish an earlier authorization, and an
    // activation park's target EQUALS the installed version by construction:
    // there is nothing an ordering test could even compare.
    expect(outcome.releasedReason).toBe("refused-unverifiable");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it("a downgrade park resumed by continue without claim.allowDowngrade is refused, and resumes with it", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.installHostDowngradeInSegment.mockRejectedValueOnce(busyError());
    await expect(
      runUpdate({ versionRequest: "1.0.0", allowDowngrade: true }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-for-work");
    expect(parked.claim).toMatchObject({ allowDowngrade: true });
    mocks.writes.length = 0;

    // The bound `continue` arrives with NO `--allow-downgrade`: 07 and the
    // reconciler never pass it, and the consent is the PARK's own claim.
    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: parked.attemptId,
      versionRequest: "1.0.0",
    });

    // No stage was kept, so the resume re-downloads through the downgrade
    // installer - announced as `downloading` first.
    expect(phaseTrace()).toEqual([
      "preparing",
      "downloading",
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    expect(outcome.legacy.version).toBe("1.0.0");
  });

  it("a downgrade park whose claim WITHHELD consent is refused, and nothing is downloaded or applied", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.installHostDowngradeInSegment.mockRejectedValueOnce(busyError());
    await expect(
      runUpdate({ versionRequest: "1.0.0", allowDowngrade: true }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
    const parked = await requireRecord();
    // No legal run can MINT this baseline - the plan will not produce a
    // downgrade without the flag - but a record is durable and may have been
    // written by anything. The consent test has to hold for what the record
    // SAYS, which is the difference between reading `allowDowngrade` and
    // reading the version ordering with an `||` that never fires.
    await patchClaimOnDisk({ allowDowngrade: false });
    mocks.writes.length = 0;
    mocks.installHostDowngradeInSegment.mockClear();

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: parked.attemptId,
      versionRequest: "1.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    expect(outcome.releasedReason).toBe("refused-unverifiable");
    // Released, not terminalized: an unconsented downgrade park is not a
    // claim this run may finish, and it is not this run's to destroy either.
    expect((await requireRecord()).phase).toBe("waiting-for-work");
    expect(mocks.installHostDowngradeInSegment).not.toHaveBeenCalled();
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-unverifiable",
    });
  });

  it("a claim-less downgrade park is refused: consent cannot be re-derived from version ordering", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.installHostDowngradeInSegment.mockRejectedValueOnce(busyError());
    await expect(
      runUpdate({ versionRequest: "1.0.0", allowDowngrade: true }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
    const parked = await requireRecord();
    await stripClaimFromRecordOnDisk();
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: parked.attemptId,
      versionRequest: "1.0.0",
    });

    expect(outcome.releasedReason).toBe("refused-unverifiable");
    expect(mocks.installHostDowngradeInSegment).toHaveBeenCalledTimes(1);
  });

  it("a park whose stage another actor consumed is TERMINALIZED failed{install-changed}, not released", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");

    // `host apply --no-service` lands the very target while the park waits:
    // a NEW installId, installed AT the target. The selector's ordering test
    // reads the PARK's baseline (1.0.0), not the live record - reading the
    // live record here would release `refused-unverifiable` before the claim
    // and the reconciler would re-spawn the refusal every idle tick.
    world.installId = "install-consumed";
    await seedInstalled("2.0.0");
    await seedStaged(null);

    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    // No bytes touched: the re-validation runs before the first actuator.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    // The claim was durable, so the ACK names it rather than a refusal.
    const ack = await readAck("nonce-abcdefgh");
    expect(ack).toMatchObject({ kind: "claimed", attemptId });
  });

  it("the same consumed-stage park is terminalized by a plain `install` too, with no bound intent", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    world.installId = "install-consumed";
    await seedInstalled("2.0.0");
    await seedStaged(null);
    mocks.ackWrites.length = 0;

    // A plain `install` whose plan target EQUALS the park's admits exactly
    // one action - a RESUME of that attempt - so it meets the same gate. The
    // twin matters because a bound intent is not the only way here: 07 and
    // the reconciler pass one, but a person typing `traycer host update`, and
    // the desktop's own idle sweep, do not.
    //
    // What this pin discriminates is the SELECTION, not the arm: if a plain
    // `install` started a fresh attempt over the park instead of resuming it,
    // the terminalization would never run and the park would be superseded
    // silently. It does NOT discriminate which arm then runs - both the
    // resumed-apply arm and the activation arm re-validate the install
    // identity first, and either would report the same failure.
    await expect(
      runUpdate({ ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    });

    const record = await requireRecord();
    expect(record.attemptId).toBe(attemptId);
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId,
    });
  });

  it("after the terminalization a plain host update starts the debt arm and completes", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    world.installId = "install-consumed";
    await seedInstalled("2.0.0");
    await seedStaged(null);
    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
      }),
    ).rejects.toThrow();
    mocks.writes.length = 0;

    // The next plain run meets a TERMINAL record and starts over - here on
    // the debt arm, because 2.0.0 is installed and 1.0.0 is still serving.
    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBeNull();
    expect(outcome.legacy.version).toBe("2.0.0");
    // A TERMINAL record needs no supersede: the `start` simply creates the
    // next attempt over it.
    expect(phaseTrace()).toEqual(["preparing", "restarting", "verifying"]);
  });

  // The parked twin of the legacy "the marker target follows the version
  // `applyHost` is committing" pin (host-update.test.ts:3791). The executor's
  // answer is NOT the legacy re-point: the claim's target is fixed for the
  // life of the attempt, so a stage that is not it produces a refusal and the
  // marker keeps naming the target that was actually authorized.
  it("a resumed park whose stage another actor REPLACED with a higher version refuses rather than re-pointing at it", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    // Another actor stages 3.0.0 while the park waits.
    await seedStaged("3.0.0");
    const stagedBefore = world.stageId;
    // The REAL promote-time policy runs here - nothing about the transfer is
    // forced. That matters, because the intuition that a higher stage
    // protects itself is FALSE for this call: the resume passes an EXPLICIT
    // `2.0.0`, and for an explicit request the settled policy is
    // replace-any-STAGE (D6), so `decideHostDownloadPromotion` answers
    // `promote` and the transfer would overwrite 3.0.0 with 2.0.0 and then
    // apply it. Asserted, not assumed, so this pin cannot drift back into
    // modelling a discard the real path never produces.
    const { decideHostDownloadPromotion } = await vi.importActual<
      typeof import("../../installer/download-stage")
    >("../../installer/download-stage");
    expect(
      decideHostDownloadPromotion({
        candidateVersion: "2.0.0",
        installedVersion: "1.0.0",
        stagedVersion: "3.0.0",
        stagedStageId: stagedBefore,
        explicitVersionRequested: true,
        automatic: false,
      }),
    ).toEqual({ kind: "promote" });

    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      details: {
        targetVersion: "2.0.0",
        stagedVersion: "3.0.0",
        // No transfer ran at all, which is the whole point: a transfer here
        // would have destroyed the very stage the mismatch is about.
        transferOutcome: null,
      },
    });

    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(world.installedVersion).toBe("1.0.0");
    // 3.0.0 is still on disk, byte for byte the stage this run found.
    expect(world.stagedVersion).toBe("3.0.0");
    expect(world.stageId).toBe(stagedBefore);
    const record = await requireRecord();
    expect(record.attemptId).toBe(attemptId);
    expect(record.targetVersion).toBe("2.0.0");
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    // The whole point of the deletion's replacement: 2.0.0, never 3.0.0.
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId,
    });
  });

  it("a resumed park whose stage was replaced AT THE SAME VERSION is refused by the claim's fingerprint", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    const claimed = (await requireRecord()).claim?.stageFingerprint ?? null;
    // Another actor re-stages the SAME version. Nothing about the version
    // distinguishes these bytes from the ones the park authorized - only the
    // stage id does, which is exactly why the claim carries one.
    await seedStaged("2.0.0");
    expect(world.stageId).not.toBe(claimed);

    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.UNEXPECTED });

    // The refusal is the INSTALLER's, reached because the runner passed the
    // CLAIM's fingerprint and not the one it just read off disk.
    expect(mocks.applyHostWithAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectedStageFingerprint: claimed }),
    );
    expect(world.installedVersion).toBe("1.0.0");
  });

  it("a resume that re-downloads applies with the fingerprint of the stage IT placed, not the claim's", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    const claimed = (await requireRecord()).claim?.stageFingerprint ?? null;
    // The stage is GONE - a stage sweep, an uninstall/reinstall - so this
    // resume legitimately re-downloads, and the bytes it places are ITS OWN.
    await seedStaged(null);

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
    });

    expect(outcome.legacy.version).toBe("2.0.0");
    // The transfer minted a NEW id, so pinning the apply to the claim's - the
    // fingerprint of bytes that no longer exist - would refuse the very stage
    // this run just placed.
    const applied = mocks.applyHostWithAttempt.mock.calls[0]?.[2];
    expect(applied?.expectedStageFingerprint).not.toBe(claimed);
    expect(applied?.expectedStageFingerprint).toBe(mocks.transferStageIds[0]);
  });

  it("an activation park whose install was REMATERIALIZED at the same version is terminalized before any restart", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    // Same VERSION, new install: `host install --force` re-landed 2.0.0 while
    // the park waited. Version equality alone cannot see this, so a baseline
    // that compared versions only would activate bytes it never authorized.
    world.installId = "install-rematerialized";
    world.installedAt = "2026-02-02T00:00:00.000Z";
    await seedInstalled("2.0.0");
    mocks.writes.length = 0;
    mocks.ackWrites.length = 0;

    await expect(
      runUpdate({
        intent: "activate",
        expectAttempt: parked.attemptId,
        versionRequest: "2.0.0",
        registryClient: unreachableRegistry(),
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    });

    const record = await requireRecord();
    expect(record.attemptId).toBe(parked.attemptId);
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    // Before the FIRST actuator: the re-validation runs under the lock and
    // the host is never stopped for bytes this claim did not authorize.
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.relaunchHostAfterRestartWithAttempt).not.toHaveBeenCalled();
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: parked.attemptId,
    });
  });

  it("the same rematerialized activation park is terminalized by a plain same-target `install` too", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    world.installId = "install-rematerialized";
    world.installedAt = "2026-02-02T00:00:00.000Z";
    await seedInstalled("2.0.0");
    mocks.writes.length = 0;

    // No bound intent at all: a plain `install` whose plan target equals the
    // park's runs the park's CONTINUATION, so it meets the same gate. The
    // twin matters because 07 and the reconciler are not the only callers.
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    });

    const record = await requireRecord();
    expect(record.attemptId).toBe(parked.attemptId);
    expect(record.error).toMatchObject({
      code: "install-changed",
      phase: "preparing",
    });
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
  });
});

describe("runHostUpdate - the writer's own contract", () => {
  it("a download tick blocked behind a phase barrier never lands after it", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: {
        readonly versionRequest: string | null;
        readonly onProgress: (info: ProgressInfo) => void;
        readonly beforeExtract: () => Promise<void>;
      }) => {
        // Two ticks straddling the barrier: the first is coalesced into the
        // queue, the barrier DISCARDS it, and the phase it writes is what the
        // record must say next.
        options.onProgress(progress("download", 10));
        options.onProgress(progress("download", 90));
        await options.beforeExtract();
        await seedStaged(options.versionRequest ?? world.latest);
      },
    );

    await runUpdate({});

    // Whatever ticks landed, none of them landed AFTER `preparing`: a
    // `downloading` write following the barrier would show up here.
    const afterPreparing = mocks.writes.slice(
      mocks.writes.indexOf("preparing"),
    );
    expect(afterPreparing).not.toContain("downloading");
  });

  it("a failed record write stops the next actuator instead of letting the run continue", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    // The apply's `beforeSwapCommit` barrier is the last write before the
    // swap. Make the record refuse it by moving the held identity out from
    // under the writer: another writer's `start` supersedes this attempt.
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        await rm(updateAttemptRecordPath(currentHome.value), { force: true });
        await options.hooks.beforeSwapCommit();
        throw new Error("the swap must not run after a refused write");
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    });
    expect(mocks.relaunchHostAfterRestartWithAttempt).not.toHaveBeenCalled();
  });

  it("an interrupted attempt for A followed by a request for B completes A's recovery, then starts B", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkInterrupted();

    // The world says A actually landed: installed AND running at 2.0.0. The
    // recovery terminalizes it `complete`, then `afterRecovery: "reselect"`
    // runs the selector again for the newly-requested 3.0.0.
    world.latest = "3.0.0";
    const outcome = await runUpdate({ ackNonce: "nonce-abcdefgh" });

    expect(outcome.legacy.version).toBe("3.0.0");
    // The RECOVERY's terminal `complete` for A lands before B's first write:
    // the reselect is what turns "A is finished" into "and B may now start",
    // and `afterRecovery: "report"` would stop at the release instead.
    expect(phaseTrace()).toEqual([
      "recovered:complete",
      "downloading",
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    const record = await requireRecord();
    expect(record.attemptId).not.toBe(attemptId);
    expect(record.targetVersion).toBe("3.0.0");
    expect(record.phase).toBe("complete");
    // B's claim is what the dispatcher hears about - not A's recovery.
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: record.attemptId,
    });
  });

  /**
   * Leave an ACTIVE, unheld record behind - a crashed run's shape, which is
   * the ONLY shape the recovery arm reconciles.
   *
   * `refuseFailedWrites` is what makes it that shape: an ordinary throw is
   * still terminalized by `runArm`'s failure writer, so a seed built from one
   * is a `failed` record the next run simply starts over from - no recovery
   * runs, and every claim about recovery the test then makes is vacuous.
   * Refusing the `failed` write models the process actually dying, which is
   * the only way the record stays `active`.
   */
  async function parkInterrupted(): Promise<string> {
    world.latest = "2.0.0";
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        await seedInstalled("2.0.0");
        await seedStaged(null);
        world.runningVersion = "2.0.0";
        await options.hooks.afterSwap();
        // The process "dies" at `restarting`, before the verification loop.
        throw new AbortSignalError();
      },
    );
    mocks.refuseFailedWrites = true;
    await expect(runUpdate({})).rejects.toThrow("simulated crash");
    mocks.refuseFailedWrites = false;
    const record = await requireRecord();
    expect(record.phase).toBe("restarting");
    expect(record.execution).toBe("active");
    mocks.writes.length = 0;
    mocks.ackWrites.length = 0;
    return record.attemptId;
  }
});

/** A throw that is not a `CliError`, so its code is `unexpected`, not a CLI one. */
class AbortSignalError extends Error {
  constructor() {
    super("simulated crash");
    this.name = "AbortSignalError";
  }
}

describe("runHostUpdate - the dispatch ACK and the trigger", () => {
  it("stamps `claimed` from the executor's acknowledgement boundary on a run that claims", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ ackNonce: "nonce-abcdefgh" });

    const record = await requireRecord();
    const ack = await readAck("nonce-abcdefgh");
    expect(ack).toMatchObject({
      kind: "claimed",
      attemptId: record.attemptId,
      generation: record.generation,
    });
  });

  it("stamps `no-attempt {nothing-to-do}` on a release", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    await runUpdate({ ackNonce: "nonce-abcdefgh" });

    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "nothing-to-do",
    });
  });

  it("maps a pre-claim throw that is NOT a CliError to `refused-unexpected`", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    // A bare `Error` out of the advisory plan, before any claim exists.
    const registry = fakeRegistry();
    const failing: RegistryClient = {
      ...registry,
      fetchManifest: async () => {
        throw new Error("disk on fire");
      },
    };

    await expect(
      runUpdate({ ackNonce: "nonce-abcdefgh", registryClient: failing }),
    ).rejects.toThrow("disk on fire");

    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-unexpected",
    });
  });

  it("reads the trigger from the environment, and treats an unknown value as manual", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(
      runUpdate({ env: { TRAYCER_HOST_UPDATE_TRIGGER: "automatic" } }),
    ).rejects.toThrow();
    expect((await requireRecord()).trigger).toBe("automatic");

    await rm(updateAttemptRecordPath(currentHome.value), { force: true });
    await expect(
      runUpdate({ env: { TRAYCER_HOST_UPDATE_TRIGGER: "from-the-future" } }),
    ).rejects.toThrow();
    // Provenance this build cannot interpret: `manual` is the honest floor,
    // never an invented value on a durable record.
    expect((await requireRecord()).trigger).toBe("manual");
  });

  it("never reads the intent from the environment: TRAYCER_HOST_UPDATE_INTENT is ignored", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";

    // With an env fallback this would run `activate` and refuse (no park);
    // as a plain `install` it runs the debt arm and completes.
    const outcome = await runUpdate({
      env: { TRAYCER_HOST_UPDATE_INTENT: "activate" },
    });

    expect(outcome.releasedReason).toBeNull();
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
  });

  // EXACTLY ONCE, per exit, asserted on the SEQUENCE and not on the file. The
  // file only ever shows the LAST stamp, so a run that announced its true
  // answer and then overwrote it with a downstream consequence is
  // indistinguishable there from one that only ever gave the consequence -
  // and those are very different answers to the host that is waiting.
  //
  // Three of the four below were the review's probes. Each used to produce two
  // stamps (or, for the illegal intent, none at all).

  it("a run that claims stamps exactly one ACK", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ ackNonce: "nonce-abcdefgh" });

    expect(mocks.ackWrites).toEqual(["claimed"]);
  });

  it("a release stamps exactly one ACK", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    await runUpdate({ ackNonce: "nonce-abcdefgh" });

    expect(mocks.ackWrites).toEqual(["nothing-to-do"]);
  });

  it("a REJECTED segment reports the segment's own reason, not the error it then throws", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const cohort = await import("../update-executor-cohort");
    const spy = vi
      .spyOn(cohort, "decideUpdateExecutorCohort")
      .mockReturnValue({ kind: "shadow", reason: "disabled" });
    try {
      await expect(
        runUpdate({ ackNonce: "nonce-abcdefgh" }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
      });

      // "the cohort refused this claim", never "something was already
      // active" - the thrown code is a CONSEQUENCE of the reason, and a
      // second stamp would replace the cause with its own effect.
      expect(mocks.ackWrites).toEqual(["cohort-disabled"]);
      await expectAck("nonce-abcdefgh", {
        kind: "no-attempt",
        reason: "cohort-disabled",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a release whose projection cannot backfill keeps the RELEASE's reason", async () => {
    // No install at all: the bound intent names an attempt that is gone, so
    // the segment releases `refused-attempt-gone` - and then the projection's
    // own install-record read throws `E_HOST_NOT_INSTALLED` on the way out.
    await expect(
      runUpdate({
        intent: "activate",
        expectAttempt: "gone-attempt",
        versionRequest: "2.0.0",
        registryClient: unreachableRegistry(),
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_INSTALLED });

    expect(mocks.ackWrites).toEqual(["refused-attempt-gone"]);
  });

  it("an ILLEGAL --intent value stamps a refusal - the parse is inside the run, after the stamper", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    // `install` is a real intent inside the run, but not a BOUND one: it is
    // what the ABSENCE of the option means. Validating this in the command
    // body - before the stamper existed - stamped nothing at all, leaving the
    // dispatching host to time out for no reason.
    await expect(
      runUpdate({
        intent: "install",
        expectAttempt: "attempt-1",
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(mocks.ackWrites).toEqual(["refused-e-invalid-argument"]);
    // Nothing was read or written before the parse.
    expect(await readRecord()).toBeNull();
    expect(mocks.disk.current).toBeNull();
  });

  it("the same refusal through the SHELL stamps once - the shell adds no exit of its own", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        versionRequest: null,
        ackNonce: "nonce-abcdefgh",
        intent: "activate",
        expectAttempt: null,
      })(shellContext()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(mocks.ackWrites).toEqual(["refused-e-invalid-argument"]);
  });

  // An EXPLICITLY EMPTY target, through the real program.
  //
  // These two go through argv rather than calling the run directly, because
  // the failure they guard against is a refusal thrown at the REGISTRATION -
  // where this check used to live, and where it stamped nothing at all.
  // Commander ACCEPTS `--release=`: it is a well-formed option with an empty
  // value, not the unknown-option exit an old parser takes, so nothing about
  // the parse rescues it. A run dispatched with a nonce would have waited to
  // its deadline and reported `dispatch-indeterminate` for a refusal this CLI
  // knew before it read anything.
  it.each([
    [
      "--release=",
      ["host", "update", "--release=", "--ack-nonce", "nonce-abcdefgh"],
    ],
    [
      "--version=",
      ["host", "update", "--version=", "--ack-nonce", "nonce-abcdefgh"],
    ],
  ])(
    "an explicitly empty target (%s) refuses through the real program AND stamps its refusal",
    async (_name, argv) => {
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      const program = buildProgram();
      program.exitOverride();
      for (const group of program.commands) {
        group.exitOverride();
        for (const leaf of group.commands) leaf.exitOverride();
      }

      await expect(
        program.parseAsync(argv as string[], { from: "user" }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

      expect(mocks.ackWrites).toEqual(["refused-e-invalid-argument"]);
      // Refused before anything was read or written, exactly as the
      // registration-time check was.
      expect(await readRecord()).toBeNull();
      expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    },
  );
});

describe("runHostUpdate - the coarse marker mirror", () => {
  // The other pins that used to live here have a legacy ancestor in
  // `commands/__tests__/host-update.test.ts`'s `update-progress marker
  // (T16)` or `— reassertMarkerUnderLock under the lock` blocks and have
  // moved to `ported: update-progress marker (T16)` / `ported:
  // reassertMarkerUnderLock under the lock` below, under their legacy
  // titles. This pin restates an invariant (Scope, "mirrorMarker never
  // writes blind") rather than porting one legacy row and stays.
  it("never mirrors a park as `updating`: the park arm withdraws own and leaves the path empty", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toThrow();

    expect(mocks.disk.current).toBeNull();
    expect((await requireRecord()).phase).toBe("waiting-for-work");
  });
});

describe("ported: buildHostUpdateCommand composite", () => {
  // Legacy block `buildHostUpdateCommand composite` (host-update.test.ts,
  // 16 tests): "short-circuits with no apply call when already at latest…"
  // and "downloads, promotes, then applies end to end" are the SAME on-disk
  // scenario as `ported: update-progress marker (T16)`'s "never writes a
  // marker for an already-at-latest run that applies nothing" and "marks
  // the update in flight before applying and clears the marker once the
  // host probes healthy" respectively - ported once there, rather than
  // pinned twice. "propagates a non-busy applyHost error unchanged, without
  // reading the staged record" is the same scenario as that block's "leaves
  // a failed marker carrying the cause when the apply half throws". "reuses
  // an existing stage…", "uses the owned downgrade installer…" and "keeps
  // an explicit lower target on the monotonic stage path…" are ALSO merged
  // into the pins below. "reports a no-op summary when applyHost itself
  // finds nothing staged after a discarded download, backfilling from a
  // locked re-read" is DELETED: the reconcile-discard race between a
  // pre-lock download and the apply cannot occur on the executor - the
  // transfer runs under the claim.
  //
  // Legacy block `busy park + early marker` (host-update.test.ts, 6 tests,
  // 0 deleted) needs no pins of its own: "already-staged short-circuit then
  // apply…" and "--force on the apply arm is unchanged…" are the same
  // scenarios as this block's "reuses an existing stage…" and "forwards
  // --force to applyHost" below; "writes the updating marker from
  // onWillDownload strictly before the download resolves…" ports only by
  // its second half (own record written once, `complete` deletes exactly
  // it), already covered by `ported: update-progress marker (T16)`'s "marks
  // the update in flight…"; "a transport failure that happens AFTER the
  // hook fired stamps failed and does not delete" and "a failure BEFORE the
  // hook fires writes no marker of any kind" (which, on the executor, now
  // DOES stamp - the entry mirror has already taken the marker over by the
  // time any actuator runs, so there is no marker-less "before the hook"
  // window left) are both the same shape as that block's "a pre-disruption
  // failure over this run's own record still stamps `failed`…"; "apply-arm
  // busy park…" is the extended "busy: re-throws E_HOST_BUSY…" pin below.

  it("throws E_HOST_NOT_INSTALLED if the install record vanishes between the short-circuit read and the locked backfill", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    // The plan reads the record, then it is gone before the selector's own
    // read under the lock, driven from the pid read the plan's activation
    // reading performs.
    mocks.readHostPidMetadata.mockImplementationOnce(async () => {
      await deleteHostInstallRecord(ENVIRONMENT);
      world.installedVersion = null;
      return pidMetadata("2.0.0");
    });

    await expect(
      runUpdate({ ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_INSTALLED });

    expect(await readRecord()).toBeNull();
    expect(mocks.disk.current).toBeNull();
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-e-host-not-installed",
    });
    // EXACTLY one ACK, and it is the refusal. Mapping the missing record to
    // `nothing-to-do` would stamp that FIRST and then overwrite it with the
    // refusal from the throw path - leaving the file byte-identical while the
    // dispatching host had already been told there was nothing to do.
    expect(mocks.ackWrites).toEqual(["refused-e-host-not-installed"]);
  });

  it("calls downloadAndStageHost with the explicit-incomparable policy (automatic: false) so a local-* install proceeds (D6 parity)", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({});

    expect(mocks.downloadAndStageHostInSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: ENVIRONMENT,
        versionRequest: null,
        automatic: false,
        onProgress: expect.any(Function),
        onWillDownload: null,
        beforeExtract: expect.any(Function),
      }),
      expect.anything(),
      expect.anything(),
    );
    // Unlike the legacy shell (`ownAttempt: null` - no attempt record existed
    // to exempt), the executor's transfer IS the attempt this run claimed, so
    // `ownAttempt` names THAT identity: this run is the very attempt the
    // promote-time guard would otherwise yield to, while a foreign nonterminal
    // record still wins (Plan D6). Asserted against the record on disk rather
    // than `expect.anything()`, which would pass for any non-null value.
    const record = await requireRecord();
    const call = mocks.downloadAndStageHostInSegment.mock.calls[0][0];
    expect(call.ownAttempt).toEqual({
      attemptId: record.attemptId,
      generation: record.generation,
      sequence: expect.any(Number),
    });
  });

  it("forwards an explicit version request to downloadAndStageHost", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ versionRequest: "2.1.0" });

    expect(mocks.downloadAndStageHostInSegment).toHaveBeenCalledWith(
      expect.objectContaining({ versionRequest: "2.1.0", automatic: false }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses the owned downgrade installer for an explicit lower target and keeps the normal progress and health flow", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    const outcome = await runUpdate({
      versionRequest: "1.0.0",
      allowDowngrade: true,
    });

    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(mocks.installHostDowngradeInSegment).toHaveBeenCalledTimes(1);
    expect(outcome.legacy.version).toBe("1.0.0");
    expect((await requireRecord()).phase).toBe("complete");
    expect(mocks.writes.length).toBeGreaterThan(0);
  });

  it("keeps an explicit lower target on the monotonic stage path unless downgrade is explicitly enabled", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    const outcome = await runUpdate({ versionRequest: "1.0.0" });

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.installHostDowngradeInSegment).not.toHaveBeenCalled();
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
  });

  it("keeps a null version request for latest semantics", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ versionRequest: null });

    expect(mocks.downloadAndStageHostInSegment).toHaveBeenCalledWith(
      expect.objectContaining({ versionRequest: null, automatic: false }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reuses an existing stage (already-staged short-circuit) and still applies it, projecting the legacy shape from the applied record", async () => {
    await seedInstalled("1.0.0");
    await seedStaged("2.0.0");
    world.runningVersion = "1.0.0";

    const outcome = await runUpdate({});

    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    // No `downloading`: the claim is born at `preparing` on this arm.
    expect(phaseTrace()).toEqual([
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(outcome.legacy.previousVersion).toBe("1.0.0");
    expect(outcome.legacy.serviceLifecycle).toEqual({
      priorServiceState: "running",
      stoppedBeforeSwap: true,
      postSwapAction: "restart",
      postSwapError: null,
    });
    // `busy park + early marker`'s "already-staged short-circuit then apply:
    // the marker is still written exactly once": the ENTRY mirror takes the
    // path over once and every later active phase is a no-op, so a run that
    // began on an empty path creates exactly one record.
    expect(mocks.createUpdateProgressMarkerIfAbsent).toHaveBeenCalledTimes(1);
    // ...and "cleared conditionally", the half the port dropped: the clear
    // names EXACTLY the record this run created, so a third updater's marker
    // written in between is left alone rather than deleted.
    expect(mocks.deleteUpdateProgressMarkerIfUnchanged).toHaveBeenCalledWith(
      ENVIRONMENT,
      mocks.createUpdateProgressMarkerIfAbsent.mock.calls[0]?.[1],
    );
  });

  it("forwards --force to applyHost", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ force: true });

    expect(mocks.applyHostWithAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ force: true }),
    );
  });

  it("reports the postSwapError warning without throwing (no-rollback contract), nested under serviceLifecycle like the legacy shape", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        const previous = world.installedVersion ?? "1.0.0";
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        options.onProgress(progress("swap", null));
        await seedInstalled("2.0.0");
        await seedStaged(null);
        world.runningVersion = "2.0.0";
        await options.hooks.afterSwap();
        return {
          ...appliedOutcome(previous, "2.0.0"),
          postSwapError: "service failed to start",
        };
      },
    );

    const outcome = await runUpdate({});

    expect(outcome.legacy.serviceLifecycle.postSwapError).toBe(
      "service failed to start",
    );
  });

  it("busy: re-throws E_HOST_BUSY with the staged version attached to details, stage kept", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "2.0.0" },
    });
    // The stage is kept, never discarded on a park.
    expect(world.stagedVersion).toBe("2.0.0");
    // Also satisfies `busy park + early marker`'s "apply-arm busy park:
    // withdraws its own updating marker, never stamps failed, names the
    // staged version in the message, and skips the health probe": the park
    // withdraws own and leaves the path EMPTY, and the evidence loop never
    // runs for a park.
    expect(mocks.disk.current).toBeNull();
    expect(mocks.observeAttemptRecoveryEvidence).not.toHaveBeenCalled();
  });

  it("busy: reads the staged version from the park write made under the lock, never a post-lock read", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "2.0.0" },
    });

    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    // The park write itself carries the staged fingerprint the busy error
    // names - read once, inside the same lock span the busy decision was
    // made in, never a later re-read that could disagree with it.
    expect(record.claim).toMatchObject({ stageFingerprint: world.stageId });
  });

  it("propagates E_HOST_NOT_INSTALLED thrown by downloadAndStageHost's own precondition", async () => {
    await seedInstalled(null);

    await expect(
      runUpdate({ versionRequest: "2.0.0", ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_INSTALLED });

    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-e-host-not-installed",
    });
  });

  // The OPERATOR-VISIBLE half of this block, restored.
  //
  // The legacy composite tests asserted the human summary alongside the JSON;
  // the ports above check the runner payload only, which is why deleting the
  // shell's whole `humanSummary` - the service-convergence warning included -
  // left the suite green. That string exists nowhere but
  // `buildHostUpdateCommand`, so these four drive the shell, and between them
  // they cover every branch of it.
  //
  // The shell hard-codes `registryClient: null`, i.e. the DEFAULT client; the
  // `../../registry` mock at the top of this file is what keeps that off the
  // network.

  it("the shell's summary for an ordinary upgrade names both versions", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: null,
      expectAttempt: null,
    })(shellContext());

    expect(result.human).toBe("updated host 1.0.0 → 2.0.0");
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      version: "2.0.0",
      previousVersion: "1.0.0",
    });
  });

  it("the shell's summary for an already-at-latest run is the no-op line, and nothing is applied", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: null,
      expectAttempt: null,
    })(shellContext());

    expect(result.human).toBe("host already at 2.0.0 (no-op)");
    expect(result.exitCode).toBe(0);
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
  });

  it("the shell reports the postSwapError as a service-convergence warning, and still exits 0", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        const previous = world.installedVersion ?? "1.0.0";
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        options.onProgress(progress("swap", null));
        await seedInstalled("2.0.0");
        await seedStaged(null);
        world.runningVersion = "2.0.0";
        await options.hooks.afterSwap();
        return {
          ...appliedOutcome(previous, "2.0.0"),
          postSwapError: "service failed to start",
        };
      },
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: null,
      expectAttempt: null,
    })(shellContext());

    // The no-rollback contract: the bytes ARE installed, so this is a warning
    // on a successful update and not a failure.
    expect(result.human).toBe(
      "updated host to 2.0.0; service did not converge: service failed to start",
    );
    expect(result.exitCode).toBe(0);
  });

  it("the shell's summary for a release names the reason the dispatcher was given", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    await stripClaimFromRecordOnDisk();

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.0.0",
      ackNonce: null,
      intent: "activate",
      expectAttempt: parked.attemptId,
    })(shellContext());

    expect(result.human).toBe(
      "host update did not claim an attempt (refused-unverifiable); host stays at 2.0.0",
    );
    expect(result.exitCode).toBe(0);
  });
});

// Legacy block `— stage consumed by another actor while waiting`
// (host-update.test.ts, 4 tests): ALL FOUR are deleted - the in-run race
// between a pre-lock download and another actor's `host apply --no-service`
// cannot occur on the executor, since the transfer runs under the claim. Its
// parked form - a park whose stage another actor consumed - is the
// consumed-stage `failed {install-changed}` pin already in `runHostUpdate -
// bound intents` ("a park whose stage another actor consumed is
// TERMINALIZED failed{install-changed}, not released").

describe("ported: update-progress marker (T16)", () => {
  // Legacy block `update-progress marker (T16)` (host-update.test.ts, 23
  // tests): "pre-lock claim defers to a live writer's marker" and "a
  // deferred claim is retried after the download" are DELETED - the
  // executor has no pre-lock phase, so nothing is ever deferred under the
  // lock. Every other row's legacy "deferred claim" has exactly ONE
  // executor analogue, used throughout this block: `createUpdateProgress
  // MarkerIfAbsent` mocked to answer `"failed"` once at the entry mirror,
  // leaving the run with no record of its own for the whole run.

  it("marks the update in flight before applying and clears the marker once the host probes healthy", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    const outcome = await runUpdate({});

    expect(phaseTrace()).toEqual([
      "downloading",
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    expect(outcome.releasedReason).toBeNull();
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(outcome.legacy.previousVersion).toBe("1.0.0");
    const record = await requireRecord();
    expect(record.phase).toBe("complete");
    expect(record.execution).toBe("terminal");
    // The mirror announced the target once and withdrew it at `complete`.
    // Also satisfies the composite block's "downloads, promotes, then
    // applies end to end" - the same on-disk scenario.
    expect(mocks.disk.current).toBeNull();
    // The POSITIVE publication, restored from the legacy row: an `updating`
    // naming the target was published BEFORE the apply, and the final clear
    // is conditional on exactly that record.
    const own = mocks.createUpdateProgressMarkerIfAbsent.mock.calls[0]?.[1];
    expect(own).toMatchObject({
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
    });
    expect(
      mocks.createUpdateProgressMarkerIfAbsent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.applyHostWithAttempt.mock.invocationCallOrder[0]);
    expect(mocks.deleteUpdateProgressMarkerIfUnchanged).toHaveBeenCalledWith(
      ENVIRONMENT,
      own,
    );
  });

  // The COMPLETION's compare-and-swap, on a run that actually completes.
  //
  // The legacy activation-debt row this maps from ("debt cleared while
  // waiting and a THIRD updater has since written its own marker", ported
  // below under its own title) seeds an already-activated host and never
  // enters an attempt at all, so it exercises `clearStaleFailedMarker` and
  // never reaches `createMarkerMirror.complete`. This is the cell it was
  // meant to protect: a real upgrade, a real own marker, and a foreign one
  // that lands between them.
  it("a THIRD updater's marker written before the completion is left alone - the clear names the ORIGINAL own record", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const thirdUpdater: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "third-updater",
    };
    // The first evidence read is inside the verification loop: past the apply,
    // so this run's own `updating` is long since published, and before the
    // completion write that clears it.
    mocks.observeAttemptRecoveryEvidence.mockImplementationOnce(async () => {
      mocks.disk.current = thirdUpdater;
      return observationOfWorld();
    });

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("complete");
    // The delete is asked with the record this run WROTE, not with whatever
    // the path holds now - a re-read would delete a marker belonging to an
    // updater whose work is still to come.
    const own = mocks.createUpdateProgressMarkerIfAbsent.mock.calls[0]?.[1];
    expect(own).toMatchObject({ state: "updating", targetVersion: "2.0.0" });
    expect(mocks.deleteUpdateProgressMarkerIfUnchanged).toHaveBeenCalledWith(
      ENVIRONMENT,
      own,
    );
    expect(mocks.disk.current).toEqual(thirdUpdater);
    expect(logger.info).toHaveBeenCalledWith(
      "Host update left the progress marker in place - another updater owns it now",
      { environment: ENVIRONMENT },
    );
  });

  it("the final clear could not be written: the update still succeeds, and the CLI logs why an `updating` outlives it", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.deleteUpdateProgressMarkerIfUnchanged.mockResolvedValueOnce("failed");

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    expect(logger.info).toHaveBeenCalledWith(
      "Host update could not clear its progress marker; it stays until the next update supersedes it",
      { environment: ENVIRONMENT },
    );
  });

  it("leaves a failed marker (and refuses success) when the applied host never becomes healthy", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        const previous = world.installedVersion ?? "1.0.0";
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        await seedInstalled("2.0.0");
        await seedStaged(null);
        world.runningVersion = "1.0.0";
        await options.hooks.afterSwap();
        return appliedOutcome(previous, "2.0.0");
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      code: "verify-timeout",
      phase: "verifying",
    });
    expect(mocks.disk.current).toMatchObject({ state: "failed" });
  });

  it("leaves a failed marker carrying the cause when the apply half throws", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: "boom",
        details: {},
        exitCode: 1,
      }),
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "boom",
    });

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({ code: CLI_ERROR_CODES.UNEXPECTED });
    // Also satisfies the composite block's "propagates a non-busy applyHost
    // error unchanged, without reading the staged record" - the same
    // scenario under the record model.
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("never writes a marker for an already-at-latest run that applies nothing", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    // Also satisfies the composite block's "short-circuits with no apply
    // call when already at latest, backfilling the legacy shape from a
    // locked install-record read" and the activation-debt block's "running
    // already equal to the install record" - the same up-to-date scenario.
    expect(outcome.legacy).toEqual({
      version: "2.0.0",
      installedAt: world.installedAt,
      executablePath: "/tmp/traycer-host",
      source: { kind: "registry", value: "2.0.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "test-key",
      sizeBytes: 1,
      previousVersion: "2.0.0",
      serviceLifecycle: {
        priorServiceState: "not-installed",
        stoppedBeforeSwap: false,
        postSwapAction: "none",
        postSwapError: null,
      },
    });
    expect(await readRecord()).toBeNull();
    expect(mocks.disk.current).toBeNull();
    expect(mocks.writes).toEqual([]);
    // The legacy row's NO-APPLY half, restored: "applies nothing" is the
    // claim in the title, and no marker assertion implies it.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(mocks.createUpdateProgressMarkerIfAbsent).not.toHaveBeenCalled();
  });

  it("keeps the update working when the marker write itself fails", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.readUpdateProgressMarker.mockRejectedValue(new Error("marker gone"));
    mocks.createUpdateProgressMarkerIfAbsent.mockRejectedValue(
      new Error("marker gone"),
    );

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("a lost download after a deferred claim lands its failure into the path the other writer has since cleared", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a lost download after a deferred claim stamps nothing over the other writer's still-live marker", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockImplementationOnce(
      async () => "failed",
    );
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      // A third updater's own entry mirror lands after the I/O failure.
      mocks.disk.current = {
        state: "updating",
        error: null,
        targetVersion: "1.7.0",
        updatedAt: "2026-01-02T00:00:00.000Z",
        writerId: "third-updater",
      };
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      targetVersion: "1.7.0",
    });
  });

  it("a lost download after a deferred claim stamps nothing when the running host is OBSERVED at the announced target", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      // An out-of-band actor delivered the very target this run announced.
      await seedInstalled("2.0.0");
      world.runningVersion = "2.0.0";
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toBeNull();
  });

  it("a lost download after a deferred claim still stamps when the running host is observed at an OLDER version", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a lost download after a deferred claim still stamps when the observed-state read itself fails - unreadable is not observed", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    // `targetObservedRunning`'s own read, not the plan's - the plan finds
    // real work (an upgrade), so this is the only call site reached.
    mocks.readHostPidMetadata.mockRejectedValueOnce(
      new Error("EACCES: permission denied"),
    );
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a deferred run that disturbed the host and failed lands its failure into an empty path", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        throw new Error("commit failed");
      },
    );

    await expect(runUpdate({})).rejects.toThrow("commit failed");

    // Disturbance is NOT consulted in the `ours === null` arm - the stamp
    // lands into the empty path exactly as an undisturbed failure would.
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
      error: "commit failed",
    });
  });

  it("a marker-less run whose apply succeeds but whose host never becomes healthy lands its failure into an empty path - `markUpdateFailed`'s `ours === null` arm, the health-probe call site", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        const previous = world.installedVersion ?? "1.0.0";
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        await seedInstalled("2.0.0");
        await seedStaged(null);
        world.runningVersion = "1.0.0";
        await options.hooks.afterSwap();
        return appliedOutcome(previous, "2.0.0");
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  // The verification DEADLINE is the one failure that must be reported
  // whatever the coarse observation says: it is disturbed by construction -
  // the bytes are committed and the host was restarted - and it fires
  // precisely because the host did not come back healthy at the target. The
  // suppressions below it read `pid.json`, which a host that is up but not yet
  // answering already fills in AT the target, so reusing them here withholds
  // the only signal a 1.2.x host ever shows for a failed update.
  it("a marker-less verification timeout stamps even when pid.json already identifies the target", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    // The apply lands and `pid.json` comes back at 2.0.0, but the health RPC
    // never answers, so the evidence loop's `running` stays UNREADABLE and the
    // deadline fires.
    mocks.observeAttemptRecoveryEvidence.mockImplementation(async () => {
      const observation = observationOfWorld();
      return {
        ...observation,
        evidence: {
          ...observation.evidence,
          running: { kind: "unreadable" as const },
        },
      };
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    // `targetObservedRunning` answers YES here - this is exactly the cell the
    // generic `ours === null` suppression got wrong.
    expect(world.runningVersion).toBe("2.0.0");
    expect((await requireRecord()).error).toMatchObject({
      code: "verify-timeout",
    });
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
    // Ownership protection is NOT relaxed with the observation: the stamp is
    // still a create into a path that read EMPTY.
    expect(mocks.createUpdateProgressMarkerIfAbsent).toHaveBeenLastCalledWith(
      ENVIRONMENT,
      expect.objectContaining({ state: "failed", targetVersion: "2.0.0" }),
    );
  });

  it("the same verification timeout WITH an own marker stamps over it by CAS", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.observeAttemptRecoveryEvidence.mockImplementation(async () => {
      const observation = observationOfWorld();
      return {
        ...observation,
        evidence: {
          ...observation.evidence,
          running: { kind: "unreadable" as const },
        },
      };
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    // The CONTROL for the pin above: this arm already stamps, because a
    // verification timeout is always past the stop and `disturbed` alone
    // defeats the observation check. It is here to show the special case did
    // not change the own-marker arm, and that the stamp is still a
    // compare-and-swap over exactly the record this run wrote - not a blind
    // write that the unconditional flag might have licensed.
    const own = mocks.createUpdateProgressMarkerIfAbsent.mock.calls[0]?.[1];
    expect(own).toMatchObject({ state: "updating", targetVersion: "2.0.0" });
    expect(mocks.replaceUpdateProgressMarkerIfUnchanged).toHaveBeenCalledWith(
      ENVIRONMENT,
      own,
      expect.objectContaining({ state: "failed", targetVersion: "2.0.0" }),
    );
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a stale record is replaced by the pre-lock claim", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    // The entry mirror replaced the stale record and withdrew its OWN one
    // at `complete` - the stale record is never retained.
    expect(mocks.disk.current).toBeNull();
  });

  it("a stale `failed` replaced by the pre-lock claim is NOT put back when the run parks - own is withdrawn and the path is left empty", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toThrow();

    expect(mocks.disk.current).toBeNull();
  });

  it("a dead writer's `updating` replaced by the pre-lock claim is not re-planted by a busy park", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.deadWriterIds.add("424242-dead");
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "424242-dead",
    };
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toThrow();

    expect(mocks.disk.current).toBeNull();
  });

  it("a retry whose download fails again stamps the NEW failure over its own record - the earlier `failed` is not restored", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.deadWriterIds.add("dead-writer");
    mocks.disk.current = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("download failed again: ECONNRESET");
    });

    await expect(runUpdate({})).rejects.toThrow(
      "download failed again: ECONNRESET",
    );

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      error: "download failed again: ECONNRESET",
      targetVersion: "2.0.0",
    });
  });

  it("a pre-disruption failure over this run's own record is WITHDRAWN when the running host is OBSERVED at the announced target", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      // An out-of-band actor delivered the very target this run announced.
      await seedInstalled("2.0.0");
      world.runningVersion = "2.0.0";
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toBeNull();
    // The RECORD still says this run failed: it is the truth about THIS run,
    // while the marker is the host's coarse state.
    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({ code: "unexpected" });
  });

  it("a pre-disruption failure over this run's own record still stamps `failed` when the observed version is OLDER", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a failure AFTER disruption stamps `failed` over this run's own record even when the observed version matches the target - past the stop, whatever the host serves is reported", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        // An out-of-band actor lands the announced target WHILE this run's
        // own stop is already in flight - but the stop disturbed the host
        // first, so the withdrawal check must not apply.
        await seedInstalled("2.0.0");
        world.runningVersion = "2.0.0";
        throw new Error("commit failed");
      },
    );

    await expect(runUpdate({})).rejects.toThrow("commit failed");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
      error: "commit failed",
    });
  });

  it("the observed-match comparator ignores build metadata: 2.0.0+build.7 satisfies an announced 2.0.0", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      await seedInstalled("2.0.0+build.7");
      world.runningVersion = "2.0.0+build.7";
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toBeNull();
  });
});

describe("ported: activation debt (installed-up-to-date short-circuit)", () => {
  // Legacy block `— activation debt (installed-up-to-date short-circuit)`
  // (host-update.test.ts, 28 tests): "the record moved under the lock but
  // the marker is no longer ours: the re-point is refused, and the final
  // clear still targets the ORIGINAL marker" is DELETED - no re-point
  // exists on the executor: the record's target is fixed at the claim and
  // the debt arm's target is read under the lock BEFORE the claim.
  // "running already equal to the install record: old no-op contract, no
  // restart, no marker" and "the host is busy: assertHostNotBusy rejects,
  // the run PARKS…" are the same on-disk scenarios as `ported: update-
  // progress marker (T16)`'s "never writes a marker for an already-at-latest
  // run…" and `runHostUpdate - the activation-debt arm, decided under the
  // lock`'s "the debt start is born with continuation=activate…"
  // respectively - not pinned a third time here.

  it("running behind the install record: activates, writes the updating marker, restarts under the busy gate, probes health, and clears the marker", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    world.latest = "2.0.0";

    const outcome = await runUpdate({});

    expect(mocks.assertHostNotBusy).toHaveBeenCalledTimes(1);
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(phaseTrace()).toEqual(["preparing", "restarting", "verifying"]);
    expect(outcome.legacy.previousVersion).toBe("1.0.0");
    expect(outcome.legacy.version).toBe("2.0.0");
    // The updating marker was written (entry mirror) and cleared at
    // `complete`.
    expect(mocks.disk.current).toBeNull();
  });

  it("debt cleared while waiting for the contender lock: no restart, no record is written, exit 0", async () => {
    await seedInstalled("2.0.0");
    // FIVE pid reads happen on this path, and the count is the fixture:
    // the plan's `readActivationState` takes the first (a debt), and the
    // selector's own read under the lock takes the second. The legacy took
    // one read before the lock and one under it; a `mockResolvedValueOnce`
    // copied from it would land on the wrong read.
    world.runningVersion = "1.0.0";
    mocks.readHostPidMetadata
      .mockImplementationOnce(async () => pidMetadata("1.0.0"))
      .mockImplementation(async () => pidMetadata("2.0.0"));

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(await readRecord()).toBeNull();
    expect(mocks.writes).toEqual([]);
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
  });

  it("debt cleared under the lock while the health probe would FAIL: no probe, no failed marker, no marker is written, exit 0", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.readHostPidMetadata
      .mockImplementationOnce(async () => pidMetadata("1.0.0"))
      .mockImplementation(async () => pidMetadata("2.0.0"));
    // The evidence loop's observation would fail the target if it ran at
    // all - it never does, because the debt cleared under the lock before
    // any actuator ran.
    mocks.observeAttemptRecoveryEvidence.mockRejectedValue(
      new Error("the evidence loop must not run for a cleared debt"),
    );

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.observeAttemptRecoveryEvidence).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
  });

  it("debt cleared while waiting and a THIRD updater has since written its own marker: the clear is asked with exactly the marker this run wrote, and a `changed` answer leaves the third updater's marker alone", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    const staleFailed: HostUpdateProgress = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };
    const thirdUpdater: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "third-updater",
    };
    mocks.disk.current = staleFailed;
    mocks.readUpdateProgressMarker.mockImplementationOnce(async () => {
      // A third updater lands its own live marker in the gap between this
      // no-op's read and its conditional clear.
      mocks.disk.current = thirdUpdater;
      return staleFailed;
    });

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toEqual(thirdUpdater);
  });

  it("this run FAILS while a third updater's marker has replaced ours: the failure is not stamped over the other updater's live marker", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    const thirdUpdater: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "third-updater",
    };
    mocks.stopHostForRestartWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        _controller: unknown,
        _label: unknown,
        _options: unknown,
        onAuthorityVerified: (() => void) | null,
      ) => {
        onAuthorityVerified?.();
        // A third updater lands its own live marker before this run's
        // failure reaches the compare-and-swap.
        mocks.disk.current = thirdUpdater;
        throw new Error("stop failed");
      },
    );

    await expect(runUpdate({})).rejects.toThrow("stop failed");

    expect(mocks.disk.current).toEqual(thirdUpdater);
  });

  it("the install record moves while waiting for the lock: the restart activates the record as read UNDER the lock and the marker is re-pointed at it", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    // The plan sees 2.0.0; the record is re-materialized at 3.0.0 before the
    // selector's own read. The `start` names the under-lock version, and so
    // does the marker from its very first write - nothing re-points on the
    // executor (the record's target is fixed at the claim), which is why
    // this run reaches `complete` at 3.0.0 with no `install-changed`.
    mocks.readHostPidMetadata.mockImplementationOnce(async () => {
      world.latest = "2.0.0";
      return pidMetadata("1.0.0");
    });
    let moved = false;
    mocks.identityVerdict.mockImplementation(async () => {
      if (!moved) {
        moved = true;
        world.installId = "install-moved";
        await seedInstalled("3.0.0");
      }
      return "current";
    });

    const outcome = await runUpdate({});

    const record = await requireRecord();
    expect(record.targetVersion).toBe("3.0.0");
    expect(record.phase).toBe("complete");
    expect(record.error).toBeNull();
    expect(outcome.legacy.version).toBe("3.0.0");
    // The marker names the under-lock version from its FIRST write - it is
    // never re-pointed, because the record's target was fixed at the claim
    // and the debt arm read that target under the lock before it.
    expect(mocks.createUpdateProgressMarkerIfAbsent).toHaveBeenCalledWith(
      ENVIRONMENT,
      expect.objectContaining({ state: "updating", targetVersion: "3.0.0" }),
    );
  });

  it("the running host VANISHES under the lock (pid gone, not replaced): relaunched through the stop → relaunch pair, busy gate not asked, health probed, reported as the update", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.readHostPidMetadata
      .mockImplementationOnce(async () => pidMetadata("1.0.0"))
      .mockImplementation(async () => null);

    const outcome = await runUpdate({});

    // The only pin that sees the gate on the `no-live-host` reading: a host
    // that is GONE has no live work to protect.
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    // Nothing was running to name, so the plan's last-seen running version is
    // the best fact about "before".
    expect(outcome.legacy.previousVersion).toBe("1.0.0");
  });

  it("no work owed and the running host is OBSERVED at the installed version: a stale `failed` marker is cleared", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toBeNull();
  });

  it("the stale-failure clear could not be written: left alone, logged, no throw", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };
    mocks.deleteUpdateProgressMarkerIfUnchanged.mockResolvedValueOnce("failed");

    await runUpdate({});

    expect(logger.info).toHaveBeenCalledWith(
      "Host update left the progress marker alone - the stale-failure clear could not be written",
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("pid.json names a RECYCLED pid (identity verdict `mismatch`): not a live host - no debt, no restart, and a `failed` marker is NOT cleared", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.identityVerdict.mockResolvedValue("mismatch");
    const stale: HostUpdateProgress = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };
    mocks.disk.current = stale;

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBe(stale);
  });

  it("identity verdict `indeterminate` (a pid.json that predates the stamp): the host is KEPT - debt is still detected and activated", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.identityVerdict.mockResolvedValue("indeterminate");

    await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
  });

  it("no work owed but the host is DOWN: a `failed` marker is left alone - it may still be exactly true", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = null;
    const stale: HostUpdateProgress = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };
    mocks.disk.current = stale;

    const outcome = await runUpdate({});

    // The clear is gated on the PLAN's reading being `activated`, and this
    // one was `no-live-host`: a host that is DOWN is the service manager's
    // problem, and the marker may still be describing something real.
    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toBe(stale);
  });

  it("no work owed and an `updating` marker (another updater in flight): left alone", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    const liveThirdUpdater: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };
    mocks.disk.current = liveThirdUpdater;

    await runUpdate({});

    expect(mocks.disk.current).toBe(liveThirdUpdater);
  });

  it("debt cleared under the lock on a BUSY host: still the no-op - the busy gate is never consulted and no failed marker is written", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.readHostPidMetadata
      .mockImplementationOnce(async () => pidMetadata("1.0.0"))
      .mockImplementation(async () => pidMetadata("2.0.0"));
    mocks.assertHostNotBusy.mockRejectedValue(busyError());

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
  });

  it("pid record present but the process is dead: no debt, old no-op contract", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.identityVerdict.mockResolvedValue("dead");

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(outcome.releasedReason).toBe("nothing-to-do");
  });

  it("an incomparable running version (e.g. a local-* build): no debt, old no-op contract", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "local-abc123";

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(outcome.releasedReason).toBe("nothing-to-do");
  });

  it("downgrade-shaped debt (running AHEAD of the install record) still activates - either direction of inequality counts", async () => {
    await seedInstalled("1.9.0");
    world.runningVersion = "2.0.0";
    world.latest = "1.9.0";

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(outcome.legacy.previousVersion).toBe("2.0.0");
    expect(outcome.legacy.version).toBe("1.9.0");
  });

  it("--force skips the busy assertion but still restarts", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";

    await runUpdate({ force: true });

    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.stopHostForRestartWithAttempt.mock.calls[0][4]).toEqual({
      force: true,
    });
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
  });

  it("the record carries a runtime stamp: debt is decided by runtime-stamp EQUALITY, not by SemVer on the catalog version", async () => {
    world.runtimeVersion = "2.0.1";
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.1";

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(outcome.releasedReason).toBe("nothing-to-do");
  });

  it("the record carries a runtime stamp the running host does not match: debt, even when the catalog versions would compare equal", async () => {
    world.runtimeVersion = "2.0.0";
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0-rc.3";

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(outcome.legacy.previousVersion).toBe("2.0.0-rc.3");
  });

  it("a non-SemVer runtime stamp (staging.<epoch>.<sha>) that MATCHES the running host: activated, not foreign - the stale failed marker is cleared and nothing restarts", async () => {
    world.runtimeVersion = "staging.1783550586518.bb8c937d9";
    await seedInstalled("2.0.0");
    world.runningVersion = "staging.1783550586518.bb8c937d9";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    };

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toBeNull();
  });

  it("a non-SemVer runtime stamp the running host does NOT match: debt, activated - a staging host is never 'foreign'", async () => {
    world.runtimeVersion = "staging.1783550586518.bb8c937d9";
    await seedInstalled("2.0.0");
    world.runningVersion = "staging.1783540000000.0a1b2c3d4";

    const outcome = await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(outcome.legacy.previousVersion).toBe(
      "staging.1783540000000.0a1b2c3d4",
    );
  });

  it("a park whose withdrawal cannot land reports the I/O failure, not a withdrawal", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValue(busyError());
    mocks.deleteUpdateProgressMarkerIfUnchanged.mockResolvedValueOnce("failed");

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; its progress marker could not be withdrawn and stays until the next update supersedes it",
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("a park whose withdrawal finds the path already empty says so - not that another updater owns it", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValue(busyError());
    mocks.deleteUpdateProgressMarkerIfUnchanged.mockResolvedValueOnce("absent");

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; found no progress marker to withdraw",
      expect.objectContaining({ outcome: "absent" }),
    );
  });

  it("the health probe fails after activation: rejects the health-check error, marks the marker failed, and never clears it", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    // Applied but never observed healthy at the target.
    mocks.observeAttemptRecoveryEvidence.mockImplementation(async () => ({
      ...observationOfWorld(),
      evidence: {
        ...observationOfWorld().evidence,
        running: { kind: "absent" as const },
      },
    }));

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({ code: "verify-timeout" });
    expect(mocks.disk.current).toMatchObject({ state: "failed" });
  });
});

describe("ported: reassertMarkerUnderLock under the lock", () => {
  // Legacy block `— reassertMarkerUnderLock under the lock`
  // (host-update.test.ts, 18 tests): "marker withdrawn while waiting:
  // republished under the lock before the apply" and "under the lock, the
  // marker target follows the version applyHost is committing, not the
  // pre-lock download target" are DELETED - no own marker exists before the
  // lock to be withdrawn or re-pointed on the executor (the record's target
  // is fixed at the claim, and the staged arms re-validate the stage
  // FINGERPRINT instead). "downgrade arm passes onBeforeCommit and it
  // re-asserts" is DELETED - no re-assert hook exists; the downgrade arm's
  // `disturbed` is fed by the same progress stream as every other arm.
  // "a takeover of a stale record under the lock does not restore it on a
  // busy park" is the same scenario as `ported: update-progress marker
  // (T16)`'s "a stale `failed` replaced by the pre-lock claim is NOT put
  // back when the run parks…" - not pinned twice. "a park before the hook
  // never touches the marker beyond this run's own record" has no distinct
  // executor analogue from "busy park after a takeover…" below: the
  // executor's entry mirror always runs before the first actuator (there is
  // no separate "before the hook" moment to distinguish), so the same pin
  // covers both.

  it("another updater's marker on disk under the lock: taken over (the lock holder owns the marker)", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    // The lock holder took the marker over and withdrew its OWN one at
    // `complete` - the foreign record is gone, replaced, never restored,
    // because this run did real, completed work.
    expect(mocks.disk.current).toBeNull();
  });

  it("busy park after a takeover: the displaced record is RESTORED, and no `failed` stamp lands", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const foreign: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.disk.current = foreign;
    mocks.applyHostWithAttempt.mockRejectedValue(busyError());

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    // The park RESTORES the displaced record - it did no disruptive work
    // after all.
    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      targetVersion: "2.0.0",
      writerId: "foreign-writer",
    });
    // The final state above is ALSO what a run that never took the marker
    // over would leave, so on its own it does not distinguish "took it and
    // put it back" from "left it alone". These are the two writes, in order,
    // each conditional on exactly what it expected to find.
    const swaps = mocks.replaceUpdateProgressMarkerIfUnchanged.mock.calls;
    expect(swaps).toHaveLength(2);
    // 1. the TAKEOVER, under the lock: the lock holder owns the marker.
    expect(swaps[0]?.[1]).toEqual(foreign);
    const own = swaps[0]?.[2];
    expect(own).toMatchObject({
      state: "updating",
      targetVersion: "2.0.0",
      writerId: "test-writer",
    });
    // 2. the RESTORE: this run's own record back to the VERY record it
    // displaced - not a reconstruction of it, and never a blind write.
    expect(swaps[1]?.[1]).toEqual(own);
    expect(swaps[1]?.[2]).toEqual(foreign);
  });

  it("a failure after a takeover but before the host is disturbed restores the displaced record", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.applyHostWithAttempt.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      }),
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      targetVersion: "2.0.0",
      writerId: "foreign-writer",
    });
  });

  it("a takeover of a LIVE foreign record is not restored if that writer dies before the park re-checks it", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "1.5.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.applyHostWithAttempt.mockImplementation(async () => {
      // The displaced writer had the whole stop attempt to die in.
      mocks.deadWriterIds.add("foreign-writer");
      throw busyError();
    });

    await expect(runUpdate({})).rejects.toThrow();

    // Re-planting a dead writer's `updating` is exactly what the restore-time
    // liveness re-read exists to prevent - 1.2.x hosts suppress nothing.
    expect(mocks.disk.current).toBeNull();
  });

  it("a failure after a takeover of a LIVE foreign record stamps `failed` if that writer dies before the restore re-checks it", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "will-die-writer",
    };
    mocks.applyHostWithAttempt.mockImplementation(async () => {
      // The takeover already read this writer as live; it dies here, before
      // the failure's own restore re-check.
      mocks.deadWriterIds.add("will-die-writer");
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      });
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("a failure after the host was disturbed stamps `failed` over the taken-over record", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "could not stop the service",
          details: null,
          exitCode: 1,
        });
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("the activation arm counts as disturbing the host from the stop's authority check on", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.stopHostForRestartWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        _controller: unknown,
        _label: unknown,
        _options: unknown,
        onAuthorityVerified: (() => void) | null,
      ) => {
        onAuthorityVerified?.();
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "could not stop the service",
          details: null,
          exitCode: 1,
        });
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    // The boundary fired before the stop rejected, so this is a `failed`
    // stamp, never a restore.
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("the activation arm's stop refused by its capability check, before the actuator, restores a live writer's taken-over record", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    // The check failed WITHOUT calling the boundary callback - the actuator
    // never ran.
    mocks.stopHostForRestartWithAttempt.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "mutation capability refused",
        details: null,
        exitCode: 1,
      }),
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    // Undisturbed: the foreign record is restored, never stamped `failed`.
    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      targetVersion: "2.0.0",
      writerId: "foreign-writer",
    });
  });

  it("empty path, but a marker lands between the read and the republish → the create refuses, the next iteration reads it and takes it over", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.createUpdateProgressMarkerIfAbsent.mockImplementationOnce(
      async () => {
        mocks.disk.current = foreignRecord;
        return "exists";
      },
    );

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    // The loop's next iteration read the record the refused create just
    // observed, and took it over - the run completed and withdrew its own.
    expect(mocks.disk.current).toBeNull();
  });

  it("the create fails → nothing changes, the update continues", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");

    const outcome = await runUpdate({});

    // The apply still runs to completion - a failed create is advisory
    // state, never a reason to abort or throw.
    expect(outcome.legacy.version).toBe("2.0.0");
  });

  it("an I/O-failed CAS is not retried: the replace reports 'failed', so the run stops trying on the FIRST attempt", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.replaceUpdateProgressMarkerIfUnchanged.mockResolvedValue("failed");

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    expect(mocks.replaceUpdateProgressMarkerIfUnchanged).toHaveBeenCalledTimes(
      1,
    );
  });

  it("a 'changed' replace re-reads and takes over the record a newer updater actually landed", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    const newerRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:01.000Z",
      writerId: "newer-writer",
    };
    mocks.disk.current = foreignRecord;
    mocks.replaceUpdateProgressMarkerIfUnchanged.mockImplementationOnce(
      async () => {
        mocks.disk.current = newerRecord;
        return "changed";
      },
    );

    const outcome = await runUpdate({});

    expect(outcome.legacy.version).toBe("2.0.0");
    expect(mocks.replaceUpdateProgressMarkerIfUnchanged).toHaveBeenCalledTimes(
      2,
    );
    // The run completed and withdrew its own (adopted from the second
    // attempt) - neither foreign record survives.
    expect(mocks.disk.current).toBeNull();
  });

  it("a live-writer restore that loses the CAS reports it was not restored, not silence", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.applyHostWithAttempt.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      }),
    );
    // The takeover itself lands (first replace call); the restore attempt -
    // the second - loses its own CAS to a newer write.
    mocks.replaceUpdateProgressMarkerIfUnchanged
      .mockImplementationOnce(
        async (
          _environment: string,
          _expected: HostUpdateProgress,
          next: HostUpdateProgress,
        ) => {
          mocks.disk.current = next;
          return "replaced";
        },
      )
      .mockResolvedValueOnce("changed");

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was not restored - another updater owns it now",
      expect.objectContaining({ outcome: "changed" }),
    );
  });
});

describe("ported: host update explicit downgrade failure", () => {
  // Legacy file `host-update-downgrade-command-failure.test.ts`
  // (`host update explicit downgrade failure`, 2 tests): both ported
  // through `runHostUpdate`'s downgrade arm.
  //
  // `host-update-downgrade.test.ts`'s `installHostDowngrade` block (5
  // tests) is NOT ported here: it tests `installHostDowngrade` directly,
  // one layer below this command, and stays exactly where it is (kept, per
  // the fate table) - it is unaffected by this ticket beyond the ticket-03
  // rename its own diff already carries (`onBeforeCommit` →
  // `hooks.beforeSwapCommit`).

  it("leaves a failed marker for the downgrade target and never claims host health", async () => {
    await seedInstalled("1.3.0-rc.1");
    world.runningVersion = "1.3.0-rc.1";
    mocks.installHostDowngradeInSegment.mockRejectedValue(
      new Error("downgrade commit failed"),
    );

    await expect(
      runUpdate({ versionRequest: "1.2.0", allowDowngrade: true }),
    ).rejects.toThrow("downgrade commit failed");

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      message: "downgrade commit failed",
    });
    // The fixture's host is not observed at the downgrade target - never
    // claims host health.
    expect(mocks.observeAttemptRecoveryEvidence).not.toHaveBeenCalled();
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "1.2.0",
    });
  });

  it("HOST_BUSY from installHostDowngrade parks: deletes the written updating marker and never stamps failed", async () => {
    await seedInstalled("1.3.0-rc.1");
    world.runningVersion = "1.3.0-rc.1";
    mocks.installHostDowngradeInSegment.mockRejectedValue(busyError());

    await expect(
      runUpdate({ versionRequest: "1.2.0", allowDowngrade: true }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    expect(mocks.writes).not.toContain("failed");
    expect(mocks.disk.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------

async function readAck(nonce: string): Promise<unknown> {
  const decoded = decodeUpdateDispatchAck(
    await readFile(updateDispatchAckPath(currentHome.value), "utf8"),
  );
  expect(decoded.kind).toBe("valid");
  if (decoded.kind !== "valid") throw new Error("unreachable");
  expect(decoded.ack.nonce).toBe(nonce);
  return decoded.ack.result;
}

async function expectAck(nonce: string, result: unknown): Promise<void> {
  expect(await readAck(nonce)).toEqual(result);
}

// The Acceptance cells with NO legacy ancestor: the executor added the record,
// the bound intents and the recovery hand-off, and none of them has a pin in
// the legacy suite to port.
describe("acceptance: cells with no legacy ancestor", () => {
  /** An upgrade parked at `waiting-for-work`; returns its attempt id. */
  async function parkUpgradeAt(target: string): Promise<string> {
    world.latest = target;
    mocks.applyHostWithAttempt.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    mocks.writes.length = 0;
    mocks.downloadAndStageHostInSegment.mockClear();
    mocks.applyHostWithAttempt.mockClear();
    mocks.transferStageIds.length = 0;
    return record.attemptId;
  }

  /**
   * A crash at `restarting`: the bytes are committed and the install record
   * has MOVED to the target, but the host is still serving the old version
   * and the process dies before the completion write. Exactly the shape
   * `update-verify`'s recovery arm exists to reconcile.
   */
  async function crashAtRestarting(
    target: string,
  ): Promise<HostUpdateAttemptRecord> {
    world.latest = target;
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        const previous = world.installedVersion ?? target;
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        await seedInstalled(target);
        await seedStaged(null);
        await options.hooks.afterSwap();
        // The host has NOT come back at the target yet, and the process dies
        // here - before the evidence loop and before the completion write.
        throw new AbortSignalError();
      },
    );
    mocks.refuseFailedWrites = true;
    await expect(runUpdate({})).rejects.toThrow("simulated crash");
    mocks.refuseFailedWrites = false;
    const record = await requireRecord();
    expect(record.phase).toBe("restarting");
    expect(record.execution).toBe("active");
    mocks.writes.length = 0;
    return record;
  }

  it("a failure BEFORE any claim writes no marker of any kind - the negative sits at the PLAN now", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const failing: RegistryClient = {
      ...fakeRegistry(),
      fetchManifest: async () => {
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
          message: "host update: the registry is unreachable",
          details: { environment: ENVIRONMENT },
          exitCode: 1,
        });
      },
    };

    await expect(
      runUpdate({ registryClient: failing, ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE });

    // Nothing was claimed, so the entry mirror never ran: no record, no
    // marker, and the ACK carries the mapped refusal reason. The IN-SEGMENT
    // counterpart - a transfer that fails after the claim - stamps `failed`
    // instead, which is the ported "a pre-disruption failure … still stamps"
    // pin above.
    expect(await readRecord()).toBeNull();
    expect(mocks.disk.current).toBeNull();
    expect(mocks.createUpdateProgressMarkerIfAbsent).not.toHaveBeenCalled();
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-e-registry-unavailable",
    });
  });

  it("busy at the cooperative stop parks from `preparing`, never from `applying`", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        // Fires BEFORE the cooperative stop. Production passes no hook here,
        // so nothing is written and the park below is legal.
        await options.onWillCommitStaged?.("2.0.0");
        throw busyError();
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    // `applying`'s legal successors exclude `waiting-for-work`, and the
    // phase-transition check runs before the continuation-order check - so a
    // run that had written `applying` before the stop could not park at all,
    // and this trace is what proves it did not.
    expect(phaseTrace()).toEqual([
      "downloading",
      "preparing",
      "waiting-for-work",
    ]);
  });

  it("a crash before the completion write is finished by a same-target retry, on the SAME attempt", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The host did come back, out of band, at the target.
    world.runningVersion = "2.0.0";

    const outcome = await runUpdate({ ackNonce: "nonce-abcdefgh" });

    // Recovery terminalizes the interrupted attempt `complete` from the
    // evidence, and the reselect that follows finds nothing left to do. A
    // no-op decided BEFORE the record was consulted would release here and
    // leave the active record behind forever.
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("complete");
    expect(record.execution).toBe("terminal");
    // The release reports the RECOVERY's own outcome rather than a generic
    // `nothing-to-do`: a reselect after a terminalizing recovery carries
    // `recovered-complete`, and the dispatching host reads exactly that.
    expect(outcome.releasedReason).toBe("recovered-complete");
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "recovered-complete",
    });
  });

  it("a waiting-to-activate park written by the REAL update-verify recovery is resumed by `activate` and completes", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The seed's baseline names the PRE-apply install record; the live one is
    // the target now. Only the refresh the recovery park writes makes them
    // equal, which is what this pin exists to prove end to end.
    expect(crashed.claim).toMatchObject({ installedVersion: "1.0.0" });

    const report = await verifyHostUpdateAttempt(ENVIRONMENT, {
      attemptId: crashed.attemptId,
      generation: crashed.generation,
      sequence: crashed.sequence,
      targetVersion: "2.0.0",
    });
    expect(report).toMatchObject({
      outcome: "resumed",
      continuation: "activate",
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    expect(parked.claim).toMatchObject({ installedVersion: "2.0.0" });
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "activate",
      expectAttempt: crashed.attemptId,
      registryClient: unreachableRegistry(),
    });

    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("the same sequence from a CLAIM-LESS seed: the park stays claim-less and `activate` answers refused-unverifiable", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The pre-D19 shape. A refresh may not grant an authorization nobody
    // issued, so the park must come back claim-less too (01's ignore rule).
    await stripClaimFromRecordOnDisk();

    await verifyHostUpdateAttempt(ENVIRONMENT, {
      attemptId: crashed.attemptId,
      generation: crashed.generation,
      sequence: crashed.sequence,
      targetVersion: "2.0.0",
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    expect(parked.claim).toBeUndefined();
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "activate",
      expectAttempt: crashed.attemptId,
      registryClient: unreachableRegistry(),
    });

    expect(outcome.releasedReason).toBe("refused-unverifiable");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it("`continue` on an UPGRADE park with no claim succeeds - an upgrade needs no consent", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgradeAt("2.0.0");
    await stripClaimFromRecordOnDisk();

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
    });

    // The ordering operand here IS the live install record - there is no
    // baseline to consent with - and 2.0.0 is strictly above it.
    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("`install` with a no-op plan and a park for ANOTHER target releases nothing-to-do and leaves the park untouched", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await parkUpgradeAt("3.0.0");
    // The host is now at 2.0.0 by another route, and this run names 2.0.0.
    world.installId = "install-elsewhere";
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    const before = await requireRecord();

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    expect(outcome.releasedReason).toBe("nothing-to-do");
    // Compared whole: a park is left for its own continuation, and a plain
    // up-to-date run supersedes neither it nor an interrupted record.
    expect(await requireRecord()).toEqual(before);
  });

  it("argv beats a conflicting TRAYCER_HOST_UPDATE_INTENT in the environment", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgradeAt("2.0.0");

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
      env: { TRAYCER_HOST_UPDATE_INTENT: "activate" },
    });

    // `activate` on a `waiting-for-work` park refuses; `continue` resumes it.
    // Reading the env at all would answer `refused-attempt-gone` here.
    expect(outcome.releasedReason).toBeNull();
    expect(outcome.legacy.version).toBe("2.0.0");
  });
});
