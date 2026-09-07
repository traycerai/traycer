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
  updateProgressRecordHasProvenLiveWriter: vi.fn(),
  readHostPidMetadata: vi.fn(),
  // The seam a test needs to change the world in the gap BETWEEN two lock
  // spans. Called with the reason of the mutation lock that is about to be
  // acquired, and a no-op by default, so every existing pin is unaffected.
  // Nothing else can reach that window: the common re-validation and the
  // arm's own re-read are consecutive statements with no other mocked call
  // between them, which is exactly why a pin that injected its race at an
  // EARLIER seam could pass while the arm's own check did nothing (cold
  // review B, C5).
  beforeAttemptMutation: vi.fn(),
  // This run's own writer-start stamp, as `ownProcessStartIdentity` supplies
  // it in production.
  writerStartIdentity: "test-writer-start:1",
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
  // Refuses the executor's TERMINAL completion write, and only that one (Q11).
  // A different seam from `refuseFailedWrites` above: the completion travels
  // through the revocable `ExecutorCompletionSession`, not through
  // `commitExecutorAttemptMutation`, so nothing else can reach it. Both refusal
  // kinds are offered because the ticket's whole claim is that they must be
  // INDISTINGUISHABLE on disk, and a pin cannot assert that from one of them.
  refuseCompletion: null as "rejected" | "durability-unverified" | null,
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
    // The TERMINAL completion seam, wrapped rather than replaced: the real
    // segment runs, holds the real lock and revokes the real session; only the
    // one `complete` call the flag names is answered with a refusal instead of
    // a commit. Nothing downstream of the refusal is simulated - production
    // takes its own arm from the returned `kind`, and the record on disk is
    // whatever the run genuinely left there.
    withUpdateExecutorCompletionSegment: async <T>(
      options: import("@traycer-clients/shared/host-update/contender").WithUpdateExecutorCompletionSegmentOptions,
      run: (
        capability: import("@traycer-clients/shared/host-update").UpdateMutationCapability,
        context: import("@traycer-clients/shared/host-update/contender").UpdateContenderExecutionContext,
        completion: import("@traycer-clients/shared/host-update/contender").ExecutorCompletionSession,
      ) => Promise<T>,
    ): Promise<
      import("@traycer-clients/shared/host-update/contender").UpdateContenderOutcome<T>
    > =>
      actual.withUpdateExecutorCompletionSegment(
        options,
        (capability, context, completion) =>
          run(capability, context, {
            revoke: () => completion.revoke(),
            complete: async (observation) => {
              const refusal = mocks.refuseCompletion;
              if (refusal === null) return completion.complete(observation);
              mocks.writes.push(`completion-refused:${refusal}`);
              return refusal === "rejected"
                ? {
                    kind: "rejected",
                    reason: "record-fail-closed",
                    canonical: { kind: "absent" },
                  }
                : {
                    kind: "durability-unverified",
                    cause: "post-write-roundtrip-mismatch",
                    canonical: {
                      kind: "unreadable",
                      cause: "post-write-roundtrip-mismatch",
                    },
                  };
            },
          }),
      ),
  };
});

vi.mock("../update-progress-marker", () => ({
  readUpdateProgressMarker: mocks.readUpdateProgressMarker,
  replaceUpdateProgressMarkerIfUnchanged:
    mocks.replaceUpdateProgressMarkerIfUnchanged,
  deleteUpdateProgressMarkerIfUnchanged:
    mocks.deleteUpdateProgressMarkerIfUnchanged,
  createUpdateProgressMarkerIfAbsent: mocks.createUpdateProgressMarkerIfAbsent,
  updateProgressRecordHasProvenLiveWriter:
    mocks.updateProgressRecordHasProvenLiveWriter,
  // The REAL identity comparison, against this suite's own writer id. Every
  // marker `progressRecord` below builds is one THIS run wrote, so it must
  // read as ours - otherwise the detective half would see a foreign updater
  // in every test that publishes a marker, which is all of them. A test that
  // wants a foreign marker seeds a different `writerId` (or `null`, which is
  // a marker from a CLI predating the field).
  updateProgressRecordWrittenByThisProcess: (
    record: import("../update-progress-marker").HostUpdateProgress,
  ): boolean => record.writerId === "test-writer",
  progressRecord: (fields: {
    state: "updating" | "failed";
    error: string | null;
    targetVersion: string;
  }): import("../update-progress-marker").HostUpdateProgress => ({
    ...fields,
    updatedAt: new Date().toISOString(),
    writerId: "test-writer",
    // BOTH stamps, as the real `progressRecord` writes them from
    // `ownProcessStartIdentity` (#1752 round 13). It matters that this run's
    // own records carry the identity: the host daemon suppresses an
    // `updating` marker whose stamp does not match the live pid's, and a
    // record written with a NULL stamp falls back to pid-only fail-open -
    // which pins "Updating..." on screen forever once that pid is recycled
    // (#1763 / internal #5536). Records that model an OLDER CLI's marker are
    // seeded by the tests that need them, with an explicit null.
    writerStartIdentity: mocks.writerStartIdentity,
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
// The REAL contender, with one seam in front of it. Every lock this file
// exercises is the real cross-process CLI lock on a real sandbox path - that
// is what makes the settlement's mutual exclusion pinnable at all - and the
// only thing added is a hook that runs immediately before the acquisition,
// named by the lock's reason.
vi.mock("../update-contender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../update-contender")>();
  return {
    ...actual,
    withCliAttemptMutation: async <T>(
      capability: Parameters<typeof actual.withCliAttemptMutation<T>>[0],
      options: Parameters<typeof actual.withCliAttemptMutation<T>>[1],
      run: Parameters<typeof actual.withCliAttemptMutation<T>>[2],
    ): Promise<T> => {
      await mocks.beforeAttemptMutation(options.reason);
      return actual.withCliAttemptMutation(capability, options, run);
    },
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
import {
  runHostUpdate,
  verifyBudgetFor,
  type HostUpdateRunArgs,
} from "../update-run";
import { LAUNCHD_THROTTLE_INTERVAL_SECONDS } from "../../service/platforms/macos";
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
import type {
  AttemptRecoveryEvidenceObservation,
  RunningEvidenceDiagnosis,
} from "../update-recovery-evidence";
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
  /**
   * The running leg's DIAGNOSIS, which production computes from the pid record
   * and the identity verdict. Settable here so a verify-timeout pin can drive
   * the exact cause it wants to see rendered (E13).
   */
  runningDiagnosis: "pid-metadata-absent" as RunningEvidenceDiagnosis,
  /**
   * The host's own refusal words, when the diagnosis above is a refusal (Q19).
   * Production carries these OUT of the token deliberately - the token is a
   * closed set of fixed strings, this is host-reported text - and the world
   * models the same split rather than deriving one from the other.
   */
  runningRefusal: null as string | null,
  /**
   * Whether the running leg COMPARED the #1763 start stamp. `true` is the
   * shipped world every pre-Q1 row models - a stamped host, identity checked -
   * so leaving it alone keeps those rows meaning what they meant. Q1's rows
   * set it false to model a host too old to carry the stamp.
   */
  identityCompared: true,
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
    processStartIdentityRead: "absent",
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
    runningDiagnosis:
      running === null ? world.runningDiagnosis : ("classified" as const),
    // Q19: the host's own refusal words, present only when the world declares
    // a refusal reading. Every other observation carries `null`, exactly as
    // production does.
    runningRefusal: running === null ? world.runningRefusal : null,
    // Tracks the running leg, exactly as production does: a leg that read
    // nothing compared nothing. Every existing row models a stamped host, so
    // a verified leg here reports a real identity comparison; the Q1 rows
    // override `identityCompared` on the world.
    identityCompared: running === null ? false : world.identityCompared,
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
    | null
    | undefined;
  readonly expectedStageFingerprint: string | null;
  /**
   * The ONE version binding (ticket 08 decision 2): production always passes
   * the CLAIM's target here, explicit request or not, because the claim is the
   * authorization. `null` is the shape `host apply` and `host install` pass.
   */
  readonly expectedStagedVersion: string | null;
  /** The actuator-reported disruption boundary. */
  readonly onWillDisruptHost: (() => void) | null;
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

/**
 * The same applied outcome, carrying the installer's post-swap service-start
 * error (Q6 / Mac item 6). A sibling rather than a parameter on
 * `appliedOutcome` so no existing caller changes, and so the one thing this
 * fixture varies is named at its call site.
 */
function appliedOutcomeWithStartError(
  previousVersion: string,
  version: string,
  postSwapError: string,
) {
  return { ...appliedOutcome(previousVersion, version), postSwapError };
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
  mocks.refuseCompletion = null;
  mocks.ackWrites.length = 0;
  mocks.transferStageIds.length = 0;

  mocks.readUpdateProgressMarker.mockImplementation(
    async () => mocks.disk.current,
  );
  // The real rule shape: a `failed` has no writer by construction, and an
  // `updating` is live unless the test declared its writer dead.
  mocks.updateProgressRecordHasProvenLiveWriter.mockImplementation(
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
  // A no-op by default: the seam exists, and nothing happens in it.
  mocks.beforeAttemptMutation.mockResolvedValue(undefined);
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
      // PRODUCTION ORDER, and it matters (cold review B, C3): `installer/
      // apply.ts` tests the pinned fingerprint FIRST, then the absent stage,
      // then the version. The fixture used to answer `no-op` for an absent
      // stage before looking at the fingerprint, so a consumed stage under a
      // pinned resume - the case every one of the settlement's answers exists
      // for - reached the settlement in the tests and `stage-fingerprint-
      // mismatch {actualStageFingerprint: null}` in production. Three pins
      // asserted answers the real boundary never produced.
      if (
        options.expectedStageFingerprint !== null &&
        options.expectedStageFingerprint !== world.stageId
      ) {
        return {
          outcome: "stage-fingerprint-mismatch" as const,
          installedVersion: world.installedVersion ?? target ?? "0.0.0",
          expectedStageFingerprint: options.expectedStageFingerprint,
          actualStageFingerprint: world.stageId,
        };
      }
      if (target === null) return { outcome: "no-op" as const };
      // The ONE version binding, modelled (`installer/apply.ts`, #1752 round
      // 10): an explicit `expectedStagedVersion` that does not name the stage
      // actually on disk is refused BEFORE the busy gate and before
      // `onWillCommitStaged`, having consumed and announced nothing.
      if (
        options.expectedStagedVersion !== null &&
        options.expectedStagedVersion !== target
      ) {
        return {
          outcome: "stage-version-mismatch" as const,
          installedVersion: world.installedVersion ?? target,
          expectedStagedVersion: options.expectedStagedVersion,
          actualStagedVersion: target,
        };
      }
      const previous = world.installedVersion ?? target;
      // Production passes none; the fixture fires it when present so an
      // implementation that wrote a phase here would be observable.
      await options.onWillCommitStaged?.(target);
      options.onProgress(progress("service-stop", null));
      // The disruption boundary where PRODUCTION reports it: the label above
      // is emitted by `commitInstallFromSource` before the lifecycle runs its
      // status and authority checks, and this callback fires inside the
      // lifecycle once those checks have passed and the stop is about to be
      // issued. A fixture that emitted only the label modelled a world in
      // which every refusal looked like a disruption (cold review B, C2).
      options.onWillDisruptHost?.();
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
      readonly onWillDisruptHost: () => void;
      readonly beforeExtract: () => Promise<void>;
      readonly hooks: ApplyMockOptions["hooks"];
    }) => {
      const previous = world.installedVersion ?? input.version;
      await input.beforeExtract();
      // The under-lock no-op (#1752 round 14): another actor installed the
      // requested version while this run staged its private source. Decided
      // before the busy gate and before every barrier, and the private source
      // is discarded - so nothing below this line runs.
      if (world.installedVersion === input.version) {
        return {
          outcome: "no-op" as const,
          installedVersion: input.version,
        };
      }
      input.onProgress(progress("service-stop", null));
      // Same seam as the apply mock: the label precedes the lifecycle's
      // checks, this callback follows them (cold review B, C2).
      input.onWillDisruptHost();
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
  world.runningDiagnosis = "pid-metadata-absent";
  world.runningRefusal = null;
  // Reset with the rest of the world. A Q1 row that leaves this false would
  // silently hand every LATER test a host with no start stamp, and they would
  // still pass - the fallback verifies - while no longer testing the identity
  // path they were written for.
  world.identityCompared = true;
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

    // The apply IS reached now, and REFUSES - ticket 08 decision 2 collapsed
    // the two version bindings into one, the installer's. It is fed the
    // CLAIM's target, decides before the busy gate and before
    // `onWillCommitStaged`, and consumes nothing: 3.0.0 stays staged and
    // 1.0.0 stays installed. What must never happen is the apply COMMITTING
    // 3.0.0 under a claim for 2.0.0, and that is what these assertions pin.
    // Falsification: pass `expectedStagedVersion: null` from `applyArm` and
    // the fixture installs 3.0.0, then fails verification for 2.0.0 - the
    // wrong error, over a host that was moved.
    expect(mocks.applyHostWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.applyHostWithAttempt.mock.calls[0][2]).toMatchObject({
      expectedStagedVersion: "2.0.0",
    });
    expect(world.stagedVersion).toBe("3.0.0");
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

  it("continue whose stage another actor consumed, installed AND activated: superseded, exit 0, nothing restarted (D-47b)", async () => {
    // The corner where the world is right and only the RECORD stands in the
    // way. A `resume-apply` continuation may not write `complete` before it
    // has written `applying`, and this resume never applied - the stage was
    // taken under its own lock. That is a record-shape limit, not a missing
    // verification: the run READ the live host serving 2.0.0 under that lock,
    // which is the same evidence the delivered-and-running arm exits 0 on. A
    // non-zero exit for a host running exactly what was asked would be a lie
    // in the other direction from the RCA's finding 3.
    // Falsification (the ablation): throw from the delivered arm instead and
    // this reports a failure over a host that is exactly right.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");
    mocks.applyHostWithAttempt.mockImplementationOnce(async () => {
      // Another actor consumed the stage under the lock, committed it, and
      // restarted the host onto it.
      await seedInstalled("2.0.0");
      world.runningVersion = "2.0.0";
      await seedStaged(null);
      return { outcome: "no-op" as const };
    });

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
    });

    expect(outcome.legacy.version).toBe("2.0.0");
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.execution).toBe("terminal");
    expect(record.continuation).toBeNull();
    expect(record.error).toBeNull();
    expect(mocks.writes).not.toContain("failed");
    expect(mocks.disk.current).toBeNull();
    // Never claimed as verified: the trace stops where the record's own rule
    // stops it, and the exit code does not pretend otherwise.
    expect(phaseTrace()).not.toContain("verifying");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
  });

  it("Q10: continue takes the target from the RECORD, with no --version at all", async () => {
    // Linux E6L recovery matrix. `--intent continue --expect-attempt <id>`
    // without `--version` exited 1 `E_INVALID_ARGUMENT` from plan resolution,
    // before any record was read - demanding a target the named attempt
    // already carries, three lines above the `parkNeedsTransfer` read that
    // opens the very same file.
    // Falsification (the ablation): restore the `versionRequest === null`
    // throw at the head of the `continue` arm and this reddens.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: null,
    });

    // Resumed the park's own work, at the park's own target.
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(phaseTrace()).toEqual([
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ]);
    // Still the park's bytes: deriving the target must not turn a resume into
    // a fresh resolution.
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
  });

  it("Q10: an explicit --version that disagrees with the attempt is a NAMED refusal", async () => {
    // Checked rather than trusted. Preferring either value silently would
    // resume work under a confirmation made for the other version.
    // Falsification (the ablation): return `bound.targetVersion` without the
    // comparison and this reddens.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkUpgrade("2.0.0");

    const failure = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "3.0.0",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      details: { attemptId, targetVersion: "2.0.0", versionRequest: "3.0.0" },
    });
    // Named on both sides, so the reader can tell which one they got wrong.
    const message = (failure as { message: string }).message;
    expect(message).toContain("3.0.0");
    expect(message).toContain(attemptId);
    expect(message).toContain("2.0.0");
    // Refused BEFORE anything was claimed: the park is untouched.
    const record = await readRecord();
    expect(record?.attemptId).toBe(attemptId);
    expect(record?.execution).toBe("parked");
  });

  it("Q10: a missing record with no --version says WHICH attempt is gone", async () => {
    // The third case. There is genuinely no target to derive - no record, no
    // argument - so it stays `E_INVALID_ARGUMENT`, but it now names the
    // attempt instead of demanding a flag that would not have helped.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

    const failure = await runUpdate({
      intent: "continue",
      expectAttempt: "attempt-that-never-existed",
      versionRequest: null,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      details: { expectAttempt: "attempt-that-never-existed" },
    });
    expect((failure as { message: string }).message).toContain(
      "attempt-that-never-existed",
    );
    expect(await readRecord()).toBeNull();
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

  it("Q3: a bound activate on a park whose target is ALREADY RUNNING settles without restarting", async () => {
    // The reconciler dispatches exactly this when an out-of-band restart
    // brought the host up on the placed bytes. Its whole close depends on
    // `writer.supersede()` being legal from the resumed park's phase - a fact
    // owned by the shared transition table, which no host-side pin can reach.
    // If that transition ever becomes illegal the dispatch throws, the park
    // survives untouched, and the level-triggered reconciler re-dispatches
    // every tick forever. Routed here rather than through the dispatch side
    // because this file is where the transition table is exercised.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    mocks.writes.length = 0;
    mocks.assertHostNotBusy.mockClear();
    mocks.stopHostForRestartWithAttempt.mockClear();
    mocks.relaunchHostAfterRestartWithAttempt.mockClear();

    // The out-of-band restart: the host came back up on the placed bytes.
    world.runningVersion = "2.0.0";

    await runUpdate({
      intent: "activate",
      expectAttempt: parked.attemptId,
      registryClient: unreachableRegistry(),
    });

    // The dispatch is EVIDENCE, not a disruption: `activationArm`'s under-lock
    // reading is `activated`, so it returns before the gate, the stop and the
    // relaunch, and settles instead.
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.relaunchHostAfterRestartWithAttempt).not.toHaveBeenCalled();

    const record = await requireRecord();
    expect(record.execution).toBe("terminal");
    // `superseded`, NOT `complete`: `canReachVerifying` admits an `activate`
    // continuation only from `restarting`/`verifying`, and this route wrote
    // neither - so the settlement takes `writer.supersede()`. Nothing may pin
    // `complete` for this close.
    expect(record.phase).toBe("superseded");
    expect(phaseTrace()).toEqual(["preparing", "superseded"]);
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

  it("Q12: the downgrade arm records the generation ITS swap wrote, not the one it replaced", async () => {
    // The downgrade arm is the second of the two arms that actually swap, and
    // it was the one Q12 left unwatched. Found by ablating each `restarting`
    // writer INDIVIDUALLY rather than all three together: nulling this site
    // alone left the whole 163-test suite green, so two thirds of the change
    // had no pin behind it.
    //
    // Downgrade is the sharpest case for the property, because here the two
    // versions cannot be confused for one another by accident. The claim is
    // taken against 2.0.0, the swap installs 1.0.0, and the baseline must end
    // up describing what the swap wrote. Before Q12 it kept saying 2.0.0 - an
    // account of the install this attempt had just deleted.
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    await runUpdate({ versionRequest: "1.0.0", allowDowngrade: true });

    const record = await requireRecord();
    expect(record.claim).toMatchObject({ installedVersion: "1.0.0" });
    // Consent is COPIED across a refresh, never restated from it - the
    // refresh shape cannot even carry `allowDowngrade`. A downgrade whose
    // record came back without consent would be a park nothing could resume.
    expect(record.claim).toMatchObject({ allowDowngrade: true });
  });

  it("REFUSES an explicit lower target without consent, and takes the owned installer with it", async () => {
    // This pin used to read "keeps an explicit lower target on the monotonic
    // stage path" and assert a `nothing-to-do` release - exit 0 for a request
    // that delivered nothing, which is the answer #1752 round 14 removed.
    // The refusal happens at the PLAN, before any claim, so no attempt record
    // and no marker are created and there is nothing to withdraw.
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";

    await expect(
      runUpdate({ versionRequest: "1.0.0", ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      details: { installedVersion: "2.0.0", targetVersion: "1.0.0" },
    });
    expect(mocks.installHostDowngradeInSegment).not.toHaveBeenCalled();
    expect(mocks.downloadAndStageHostInSegment).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
    expect(await readRecord()).toBeNull();
    // The dispatcher still hears an answer - the refusal is thrown INSIDE the
    // run, on the far side of the settlement.
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "no-attempt",
    });

    // With consent the owned installer takes it: the shared monotonic stage
    // would refuse to promote a candidate that is not strictly newer, which
    // is exactly why this arm exists.
    mocks.installHostDowngradeInSegment.mockClear();
    await runUpdate({ versionRequest: "1.0.0", allowDowngrade: true });
    expect(mocks.installHostDowngradeInSegment).toHaveBeenCalledTimes(1);
    expect(world.installedVersion).toBe("1.0.0");
    // Falsification: drop `explicitOtherArtifact` from `resolveUpdatePlan` and
    // the first half resolves `no-op` again, exit 0, nothing delivered.
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

    // The sentence names the RUNNING host, not the installed version (Q5
    // defect 3). Here they DIFFER - 2.0.0 is installed, 1.0.0 is serving -
    // which is what makes this pin able to tell them apart at all: the old
    // wording said "host stays at 2.0.0" over a host that was serving 1.0.0.
    expect(result.human).toBe(
      "host update did not claim an attempt (refused-unverifiable); the running host is 1.0.0",
    );
    expect(result.human).not.toContain("2.0.0");
    // A host IS running, so the release is still a truthful exit 0.
    expect(result.exitCode).toBe(0);
  });

  it("Q5 defect 3: a bound verb that declines while NO host is running says so, and does not exit 0", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.assertHostNotBusy.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const parked = await requireRecord();
    await stripClaimFromRecordOnDisk();
    // The host is GONE - the E6L shape. Nothing is serving the bytes the
    // release is about to report on.
    world.runningVersion = null;

    await expect(
      runUpdate({
        intent: "activate",
        expectAttempt: parked.attemptId,
        versionRequest: "2.0.0",
        registryClient: unreachableRegistry(),
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      details: { reason: "refused-unverifiable", intent: "activate" },
    });

    // The refusal is still reported to the dispatcher as the release it was -
    // the exit code is about the machine, not about the claim.
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-unverifiable",
    });
    // ...and nothing was touched on the way out.
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect((await requireRecord()).phase).toBe("waiting-to-activate");
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
      writerStartIdentity: null,
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

  it("ticket 07 detective half: a marker that turns FOREIGN after ours landed aborts the update", async () => {
    // The transition, which is the whole point. Ours lands at the entry
    // mirror; a lock-blind pre-1.3.0 CLI then replaces it while this segment
    // is still running; the next record write observes the swap and aborts.
    //
    // This is what a claim-boundary check could not do. At the claim there is
    // one sample, and one sample cannot separate "a stale marker nobody is
    // driving" - the common case the entry takeover exists to absorb - from
    // "somebody else is mutating this host right now". Only the mirror sees
    // both halves, because only it knows its own write landed.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    // The FIRST read is the entry mirror's takeover, which must land - a
    // takeover that never landed is the I/O-failed-CAS case, and its foreign
    // marker is evidence of our failed write rather than of another actor.
    // Every read after it is the detective's, and by then a lock-blind
    // updater owns the path.
    //
    // `writerId: null` on purpose: that is a CLI old enough to predate the
    // field, which is exactly the actor the fence exists to detect, and it
    // must read as foreign rather than as "unknown, assume ours".
    let reads = 0;
    mocks.readUpdateProgressMarker.mockImplementation(async () => {
      reads += 1;
      if (reads <= 1) return mocks.disk.current;
      return {
        state: "updating" as const,
        error: null,
        targetVersion: "9.9.9",
        updatedAt: new Date().toISOString(),
        writerId: null,
        writerStartIdentity: null,
      };
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_CONCURRENT_LEGACY_UPDATER,
    });
  });

  it("...and the executor's OWN mirror writes never abort, however many it makes", async () => {
    // The twin, and the one that decides whether the fence is shippable: the
    // executor mirrors its own writes onto this marker on every record write,
    // so a detective half that cannot tell its own marker from a stranger's
    // aborts every healthy update. `updateProgressRecordWrittenByThisProcess`
    // is identity, not equality with a remembered value, so a marker this run
    // rewrote several times still reads as ours.
    //
    // No mock overrides here on purpose: the default world already publishes
    // this run's marker and rewrites it, which is precisely the traffic the
    // withdrawn claim-boundary wiring mistook for a concurrent updater.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";

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
        writerStartIdentity: null,
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

  it("Q6: the same is true when the failure is named `service-start-failed`", async () => {
    // The twin of the pin above, and the reason it exists: Q6 splits the
    // record's error code out of `verify-timeout`, and `failed()` keys its
    // UNCONDITIONAL stamp on that exact string. Extending the message without
    // extending the predicate would have silently made this failure
    // SUPPRESSIBLE - by the very `pid.json` reading the comment above explains
    // is not evidence of health - which is a behaviour change hiding inside
    // what reads as an observability improvement.
    // Falsification (the ablation): drop `|| code === "service-start-failed"`
    // from `unconditional` and this reddens on the marker never being written,
    // while the `verify-timeout` pin above stays green.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
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
        await options.hooks.afterSwap();
        world.runningVersion = "2.0.0";
        return appliedOutcomeWithStartError(
          previous,
          "2.0.0",
          "E_SERVICE_CONTROL_FAILED",
        );
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    // Same cell as the pin above: `targetObservedRunning` answers YES.
    expect(world.runningVersion).toBe("2.0.0");
    expect((await requireRecord()).error).toMatchObject({
      code: "service-start-failed",
    });
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
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

  // -------------------------------------------------------------------------
  // Q11: a refused COMPLETION write over a verified-healthy host.
  //
  // These four pins guard one rule with two halves. The rule: the CLI never
  // stamps `failed` over a host it has just verified healthy at the target.
  // The halves: the record is left untouched (so the GUI's "record at a
  // verify-side phase + dead executor + running === target" reading survives to
  // render "finalizing"), and the two refusal kinds leave disk IDENTICAL (so
  // one user-visible situation cannot produce two renderings).
  //
  // The exit is still non-zero under its own code: the attempt did not durably
  // conclude, and a script polling the record must not read this run as done.
  // -------------------------------------------------------------------------
  it.each([
    { refusal: "rejected" as const },
    { refusal: "durability-unverified" as const },
  ])(
    "Q11: a $refusal completion write leaves the record alone and exits non-zero",
    async ({ refusal }) => {
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      mocks.refuseCompletion = refusal;

      await expect(runUpdate({})).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED,
        exitCode: 1,
        // The refusal kind is reported, and it is the ONLY thing that differs
        // between these two rows. Everything asserted below is identical.
        details: {
          environment: ENVIRONMENT,
          version: "2.0.0",
          outcome: refusal,
        },
      });

      // The update itself WORKED - that is the whole premise, and the reason
      // stamping a failure would be a lie rather than a pessimism.
      expect(world.installedVersion).toBe("2.0.0");
      expect(world.runningVersion).toBe("2.0.0");

      // ...and the record still says `verifying`, with no error at all. Not
      // `failed`, not `complete`, and not a terminal of any kind: exactly what
      // the verify loop's last write left, which is what the GUI reads.
      const record = await requireRecord();
      expect(record.phase).toBe("verifying");
      expect(record.error).toBeNull();

      // The MARKER is untouched too - neither stamped `failed` (which would
      // render red at a glance) nor cleared (which would claim a conclusion
      // this run could not write). The next run takes it over.
      expect(mocks.disk.current).toMatchObject({
        state: "updating",
        targetVersion: "2.0.0",
      });
      expect(
        mocks.replaceUpdateProgressMarkerIfUnchanged,
      ).not.toHaveBeenCalledWith(
        ENVIRONMENT,
        expect.anything(),
        expect.objectContaining({ state: "failed" }),
      );
      expect(
        mocks.deleteUpdateProgressMarkerIfUnchanged,
      ).not.toHaveBeenCalled();
    },
  );

  it("Q11: the message names the version the host is running, not a failure", async () => {
    // Split from the pins above because it is a different KIND of claim: those
    // assert what is on disk, this asserts what the operator reads. The
    // sentence has to say the update is done and the bookkeeping is not,
    // because the exit code is non-zero and a non-zero exit with a silent
    // message is read as "the update failed".
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.refuseCompletion = "rejected";

    // ONE run, both claims off the same error. Asserting them in two runs was
    // this pin's first shape and it failed instructively: the SECOND run
    // reconciled the record left by the first and exited 0, which is the
    // behaviour the next pin now covers deliberately.
    const err = await runUpdate({}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED,
      message: expect.stringContaining(
        "2.0.0 is installed and the host is running it",
      ),
    });
    expect(err).toMatchObject({
      message: expect.stringContaining("the next run will conclude the record"),
    });
  });

  it("Q11: the NEXT run concludes the record it could not", async () => {
    // The citation the ticket asks for, executed rather than argued: the arm
    // promises "the next run will conclude the record", and a promise a caller
    // reads in a message is worth exactly as much as the pin behind it.
    //
    // The concluding path is `decideAttemptRecovery`'s `terminalize-complete`
    // (installed AT the target AND running bound to this home), NOT the
    // `activate` continuation - which is why the record ends `complete` rather
    // than `superseded`, and why this run exits 0 having touched nothing.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.refuseCompletion = "durability-unverified";
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED,
    });
    expect((await requireRecord()).phase).toBe("verifying");

    // The next run, over the record the first one left, with the write medium
    // working again. The first run's process is gone - it exited non-zero -
    // so its marker's writer is dead, as `crashAtRestarting` declares for the
    // same reason.
    mocks.deadWriterIds.add("test-writer");
    mocks.refuseCompletion = null;
    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("recovered-complete");
    const concluded = await requireRecord();
    expect(concluded.phase).toBe("complete");
    expect(concluded.execution).toBe("terminal");
    // ...and the MARKER the first run left is cleared with it (Q16). This is
    // the half that does not come for free: a run that reconciles and releases
    // never enters `runArm`, so the mirror's `complete()` - which is what
    // clears the marker on the executed path - never runs. Before Q16 this
    // assertion read `{state: "updating"}`, which is a Desktop card saying an
    // update is in flight beside a record that says `complete`.
    expect(mocks.disk.current).toBeNull();
  });

  it("Q11: the arm's silence survives `runArm`'s catch one frame up", async () => {
    // Pinned as its own case at the round's request, because it is the thing
    // that would have undone the ruling and nothing about the throw site shows
    // it. `runArm` catches every error and does:
    //
    //     if (!writer.settled) await writeFailure(writer, err, ...)
    //
    // `writer.settled` is FALSE here - the write that was refused belonged to
    // the executor's completion session, not to the writer - so the generic
    // path stamped `failed` at `phase: "verifying"` immediately after the arm
    // had carefully declined to. The record ended up in exactly the state the
    // ruling exists to prevent, one frame above the code that prevents it.
    //
    // Falsification: remove `writeFailure`'s early return on
    // `HOST_UPDATE_RECORD_NOT_CONCLUDED` and this reddens on the phase, with
    // `error.code` coming back as the CLI error code itself.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.refuseCompletion = "rejected";

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("verifying");
    expect(record.execution).toBe("active");
    expect(record.error).toBeNull();
    // The trace is the direct evidence: no `failed` write was even attempted.
    expect(phaseTrace()).not.toContain("failed");
  });

  it("Q11 control: a GENUINE verification timeout still stamps `failed`", async () => {
    // The falsification the pins above cannot perform on themselves. The Q11
    // rule is a carve-out, and a carve-out written one predicate too wide
    // silences the real failure it sits next to - the one case whose whole
    // purpose is to be loud, and the only signal a 1.2.x host ever shows for a
    // broken update.
    //
    // Falsification (the ablation, run): drop `writer.fail` from the
    // health-failure arm and this reddens alone, all four Q11 pins above
    // staying green.
    //
    // What does NOT falsify it is worth recording, because it was the first
    // ablation tried and it came back green: widening `writeFailure`'s Q11 arm
    // to return on ANY CliError changes nothing here. The health arm stamps at
    // its own throw site, before the error ever reaches `writeFailure`, so that
    // guard is not what keeps this failure loud.
    //
    // That widening is not unpinned, though - it just is not pinned HERE. Run
    // whole, this file reddens on 17 other pins under it (the marker-cause
    // stamps, the displaced-writer restores, the D-46 supersede/stamp split).
    // Recorded so the next editor looks there rather than concluding from this
    // comment that the arm's narrowness is free to change.
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

    expect((await requireRecord()).error).toMatchObject({
      code: "verify-timeout",
    });
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
        // The ACTUATOR's report, not the label: the label alone no longer
        // marks disruption (cold review B, C2), and this pin is about what
        // happens PAST a real stop.
        options.onWillDisruptHost?.();
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

  it("build metadata is artifact identity: a host observed at 2.0.0+build.7 does NOT satisfy an announced 2.0.0 - the lost download is stamped, not withdrawn", async () => {
    // This pin is the INVERSE of the one ticket 04 ported from #1752 round 8
    // ("the observed-match comparator ignores build metadata"). Rounds 14-15
    // deleted that rule: `2.0.0+build.7` is another artifact than `2.0.0`, and
    // a run for one that finds the other running was not delivered - its
    // failure stands. The withdrawal exists to withhold a failure another
    // actor CONTRADICTED, and this reading contradicts nothing.
    // Falsification: put `compareHostVersions` back into
    // `targetObservedRunning` and the marker is withdrawn again.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      await seedInstalled("2.0.0+build.7");
      world.runningVersion = "2.0.0+build.7";
      throw new Error("transfer lost");
    });

    await expect(runUpdate({})).rejects.toThrow("transfer lost");

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("the SAME artifact observed running - record 2.0.0 for an announced 2.0.0 - is withdrawn (control)", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      await seedInstalled("2.0.0");
      world.runningVersion = "2.0.0";
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
      writerStartIdentity: null,
    };
    const thirdUpdater: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "third-updater",
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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

  it("no work owed and the running host is OBSERVED at the installed version: a `failed` marker NAMING that version is cleared", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      // NAMES the observed version. `clearStaleFailedMarker` applies the same
      // string rule the host's `isStaleUpdateProgress` does: a `failed` is
      // stale when the version it names IS the one now running.
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
      writerStartIdentity: null,
    };

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toBeNull();
  });

  it("no work owed: a `failed` marker naming a target OTHER than the observed running version is LEFT ALONE", async () => {
    // It may still be exactly true - nothing here contradicts it - and the
    // rule that would clear it is the artifact-identity one, not "any failure
    // over a healthy host". Falsification: drop the target comparison in
    // `clearStaleFailedMarker` and this marker is deleted.
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
      writerStartIdentity: null,
    };

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "1.9.0",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Host update left the failed progress marker alone - it names a target the running host has not been observed at",
      expect.objectContaining({
        failedTargetVersion: "1.9.0",
        observedInstalledVersion: "2.0.0",
      }),
    );
  });

  it("a `failed` marker naming 2.0.0+foo over a host observed at 2.0.0+bar is NOT stale - build metadata is artifact identity for this rule too", async () => {
    await seedInstalled("2.0.0+bar");
    world.runningVersion = "2.0.0+bar";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "2.0.0+foo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
      writerStartIdentity: null,
    };

    await runUpdate({});

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0+foo",
    });
  });

  it("the stale-failure clear could not be written: left alone, logged, no throw", async () => {
    await seedInstalled("2.0.0");
    world.runningVersion = "2.0.0";
    mocks.disk.current = {
      state: "failed",
      error: "an older run failed",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      // BOTH stamps, on every record this run writes (#1763 contract): the
      // host daemon suppresses an `updating` whose `writerStartIdentity` does
      // not match the live pid's, and a NULL stamp there falls back to
      // pid-only fail-open - which pins "Updating..." on screen forever once
      // that pid is recycled onto something else.
      writerId: "test-writer",
      writerStartIdentity: mocks.writerStartIdentity,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
    };
    mocks.applyHostWithAttempt.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        // Past the actuator's own report: the stop was ISSUED and then
        // failed, which is this run's doing and stamps. Contrast the pin
        // below, where the refusal comes BEFORE this callback.
        options.onWillDisruptHost?.();
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
      writerStartIdentity: null,
    };
    const newerRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:01.000Z",
      writerId: "newer-writer",
      writerStartIdentity: null,
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
      writerStartIdentity: null,
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
    return crashAtRestartingWithSwapRead(target, "readable");
  }

  /**
   * The same crash, parameterized on ONE thing: whether the install record can
   * be read at `afterSwap`.
   *
   * `"readable"` is the ordinary shape and what every existing caller wants -
   * Q12's refresh lands, so the `restarting` record's claim baseline names the
   * SWAPPED install.
   *
   * `"unreadable"` blacks the record out across the hook and restores it
   * immediately after, which is the fail-open branch of Q12:
   * `generationWrittenBySwap` returns `null`, `refreshedClaimBaseline` carries
   * the PRIOR baseline, and the record is written at `restarting` still naming
   * the pre-swap install. It uses the production reader rather than a mock -
   * the file genuinely is not there for the duration of the call - so what is
   * exercised is the real `readHostInstallRecord === null` path.
   *
   * The record written back afterwards is byte-identical (`installRecordOf` is
   * deterministic in `world`), which is what makes this a READ failure rather
   * than a different install: the swap's own record is what ends up on disk,
   * exactly as it would be if the read had merely blipped.
   */
  async function crashAtRestartingWithSwapRead(
    target: string,
    swapRead: "readable" | "unreadable",
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
        if (swapRead === "unreadable") {
          // The file only - `world.installedVersion` stays at the target,
          // because the SWAP happened. What failed is the read.
          await deleteHostInstallRecord(ENVIRONMENT);
          await options.hooks.afterSwap();
          await writeHostInstallRecord(ENVIRONMENT, installRecordOf(target));
        } else {
          await options.hooks.afterSwap();
        }
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
    // The writer this run left behind is DEAD - that is what "crashed" means,
    // and the marker it published names it. Declaring it closes a fidelity gap
    // the helper had: every run in this file writes `writerId: "test-writer"`
    // from one live process, so without this a crashed run's marker still
    // probes as its author's live work, and no pin about what a LATER run may
    // do to that marker can mean anything. Production reads a dead pid here.
    mocks.deadWriterIds.add("test-writer");
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

  it("Q24: a no-op plan at an ACTIVE record's own target resumes it, never releases", async () => {
    // The ORDERING in `selectClaim` is the whole load-bearing fact, and nothing
    // pinned it. Same-target equality is tested BEFORE the `isNoOpPlan`
    // release, and that order is what lets the host reconciler's Q17 dispatch
    // (`8d8a10d197`) work at all: it dispatches `--version <running>`, which
    // resolves to a NO-OP plan carrying that `targetVersion`, precisely so an
    // interrupted attempt at that version gets resumed rather than abandoned.
    //
    // Swapping the two `if`s reads as tidying - "check the cheap release
    // first" - and would make every Q17 dispatch release `nothing-to-do`
    // forever. Q17's latch would NOT contain that regression: a silent no-op
    // leaves the record unmoved, so the latch stays armed and the reconciler
    // re-dispatches into the same release, which is a defect that looks like
    // quiet.
    // Falsification (the ablation, run): swap the `record.targetVersion ===
    // planTargetVersion(...)` block with the `isNoOpPlan` block and this
    // reddens on the release reason and on the untouched record.
    //
    // Honest scope, because the ticket was filed as "nothing pins this" and
    // that turned out to be half true. The swap also reddens SIX other pins in
    // this file - the crash-recovery pair, Q16's three, and Q5's - because they
    // all need a crashed record to be resumed. So the ordering was not
    // unpinned; it was UNNAMED. What this row adds is a failure that says which
    // line moved and why it matters, instead of six that say a recovery stopped
    // working. Given the swap reads as tidying, that difference is the whole
    // value here, and it is worth less than closing a hole would have been.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The reconciler's world: the target IS installed (the crashed run placed
    // it) and it is the newest thing there is, so the plan this run resolves is
    // a no-op naming 2.0.0 - the same version the active record targets.
    world.latest = "2.0.0";
    // The host is NOT serving it, which is why there is anything left to do.
    world.runningVersion = null;

    const outcome = await runUpdate({ versionRequest: "2.0.0" }).then(
      (value) => value,
      () => null,
    );

    // A release would have answered `nothing-to-do` and left the record exactly
    // as the crash left it. Either of those is the regression.
    expect(outcome?.releasedReason ?? null).not.toBe("nothing-to-do");
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).not.toBe("restarting");
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
    // Q16, on the PRE-EXISTING recovery path rather than on Q11's: the marker
    // the crashed run published is cleared along with the record it described.
    // This pin is the reason Q16 is not a Q11 detail - the defect predates that
    // arm and is reachable by any interrupted update, which is also why it is
    // asserted here on the oldest recovery pin in the file.
    expect(mocks.disk.current).toBeNull();
  });

  // ---- Q16: the marker a concluded recovery leaves behind -------------------
  //
  // A run that recovers and RELEASES never enters `runArm`, so the mirror's
  // `complete()` - the thing that clears the marker on the executed path -
  // never runs. The three pins below are the rule and its two refusals; the
  // positive case is asserted on both recovery pins above.
  it("Q16: an `updating` marker for ANOTHER target survives the clear", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await crashAtRestarting("2.0.0");
    world.runningVersion = "2.0.0";
    // A third updater's marker, published while this run was away, for work
    // that is still to come. It names 2.1.0 - NOT what is running - so nothing
    // this run observed contradicts it.
    //
    // Its writer is declared DEAD deliberately, which reads backwards until
    // you try it the other way: with a live writer the liveness guard refuses
    // the delete first and this pin passes no matter what the version test
    // does. The first version of this pin left it live and its ablation came
    // back GREEN - the assertion was true for a reason that had nothing to do
    // with what it claims to guard. Killing the writer strips that cover and
    // leaves the version test as the only thing standing between this marker
    // and deletion, which is what the pin is for.
    //
    // Falsification (run): drop the `targetVersion` test in
    // `clearConcludedUpdatingMarker` and this reddens, taking out the only
    // progress signal for someone else's whole download.
    mocks.deadWriterIds.add("third-updater");
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "third-updater",
      writerStartIdentity: null,
    };

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("recovered-complete");
    expect((await requireRecord()).phase).toBe("complete");
    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      targetVersion: "2.1.0",
    });
  });

  it("Q16: an `updating` marker whose writer is PROVEN live survives the clear", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await crashAtRestarting("2.0.0");
    world.runningVersion = "2.0.0";
    // The hard case, and the one the version test alone cannot catch: a third
    // updater republished THIS target and is alive on it. The CAS below proves
    // only that the bytes did not change between the read and the delete - it
    // says nothing about whose live work they are.
    // Falsification: drop the `updateProgressRecordHasProvenLiveWriter` guard
    // and this reddens while the two positive pins stay green.
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "live-third-updater",
      writerStartIdentity: mocks.writerStartIdentity,
    };

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("recovered-complete");
    expect(mocks.disk.current).toMatchObject({
      state: "updating",
      writerId: "live-third-updater",
    });
  });

  it("Q16: a marker whose writer liveness is UNKNOWN is deleted, not spared", async () => {
    // The row cold review B found missing, and the reason it matters is that
    // the docblock USED to claim the opposite. `hasProvenLiveWriter` is
    // `writerLiveness === "live"`, and `writerLiveness` answers `unknown` for a
    // null or unparseable writer id or a failed probe - so unknown ⇒ DELETE.
    // Without this row the only pinned liveness case was `alive-same`, dropping
    // the guard reddened one pin, and an editor trusting the old prose could
    // have tightened to `!hasLiveWriter` with nothing objecting.
    //
    // What makes deleting it correct is the VERSION test, not the liveness
    // one: this marker names the version the host is observed running, so
    // whoever owns it is working toward a version already being served.
    // Falsification (run): tighten the guard in the strict direction - spare
    // any marker carrying a writer id at all, rather than only a proven-live
    // one - and this reddens alone, the proven-live pin above staying green.
    // (The literal `!updateProgressRecordHasLiveWriter` swap review B named is
    // not runnable as written: neither this module nor the marker mock imports
    // that predicate. The mutation above is that change's effect on the one
    // case the two predicates disagree about, which is what the pin is for.)
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await crashAtRestarting("2.0.0");
    world.runningVersion = "2.0.0";
    // A writer id in a shape the pid extractor cannot parse: liveness is
    // neither `live` nor `dead`, it is UNKNOWN.
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "not-a-pid-shaped-writer-id",
      writerStartIdentity: null,
    };
    mocks.updateProgressRecordHasProvenLiveWriter.mockImplementation(
      (record: HostUpdateProgress) =>
        record.state !== "failed" &&
        record.writerId !== null &&
        mocks.deadWriterIds.has(`${record.writerId}:live`),
    );

    const outcome = await runUpdate({});

    expect(outcome.releasedReason).toBe("recovered-complete");
    expect(mocks.disk.current).toBeNull();
  });

  it("Q16: a `failed` marker is NOT this clear's business", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await crashAtRestarting("2.0.0");
    world.runningVersion = "2.0.0";
    // The stale-`failed` reconciliation is a separate arm with a separate rule
    // (it runs only on `nothing-to-do`), and widening this one to cover
    // `failed` would silently move that decision.
    // Falsification: relax `marker.state !== "updating"` to accept any state
    // and this reddens.
    mocks.disk.current = {
      state: "failed",
      error: "an earlier update failed",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-02T00:00:00.000Z",
      writerId: "earlier-updater",
      writerStartIdentity: null,
    };

    await runUpdate({});

    expect(mocks.disk.current).toMatchObject({ state: "failed" });
  });

  // ---- Q5 / Linux E6L: killed after the swap, host never came back ---------
  //
  // The same crash as the pin above, minus the one thing that made that pin
  // pass: the host does NOT come back out of band. So recovery cannot
  // terminalize `complete` from a running target; it hands back the `activate`
  // continuation instead, and the arm meets the identity re-validation with a
  // claim baseline that still names the PRE-swap install.
  //
  // On the real box that combination left the host DOWN with no self-heal:
  // every later `host update --version 1.4.3` refused
  // `E_HOST_INSTALL_RECORD_INVALID`, and only an `--allow-downgrade` reset
  // recovered it.

  it("Q5: killed at `restarting` with the host still DOWN - the recovery run activates the swapped bytes and completes, instead of calling this attempt's own swap a changed install", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The install is at the target because THIS attempt put it there.
    expect(world.installedVersion).toBe("2.0.0");
    // The second half of the field failure - a baseline still naming the
    // PRE-swap install - is no longer what this fixture produces. Q12
    // refreshes the baseline at `afterSwap`, so a crash at `restarting` now
    // leaves a record whose claim already names the swapped install, and this
    // pin reaches `revalidateInstallIdentity`'s primary equality check rather
    // than the forgiveness clause it was written to exercise.
    //
    // The assertion is updated rather than deleted because the value is the
    // premise the rest of the test rests on: what is asserted below is that
    // recovery ACTIVATES the swapped bytes instead of calling them a foreign
    // change, and that outcome must hold on both baselines. The pre-swap
    // baseline still occurs - a swap-time read that fails carries it through -
    // and it is pinned separately, by the Q12 fail-open test below. That test
    // is now the ONLY fixture in this file that reaches
    // `installedByThisAttempt`; this one no longer does.
    expect(crashed.claim).toMatchObject({ installedVersion: "2.0.0" });
    // The host is DOWN, which is the real wedge: `restarting` is written after
    // the cooperative stop, so a run killed there has already taken the old
    // host away and never brought the new one up. `crashAtRestarting` leaves
    // the pre-update host in the mock world, so this states the field shape
    // explicitly rather than inheriting a host the real box did not have.
    world.runningVersion = null;
    // The crash fixture's OWN apply is not the recovery run's, so it must not
    // be counted against the "nothing was re-applied" assertion below.
    mocks.applyHostWithAttempt.mockClear();
    mocks.assertHostNotBusy.mockClear();

    const outcome = await runUpdate({
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    // Completed on the SAME attempt - not terminalized, not superseded.
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("complete");
    expect(record.execution).toBe("terminal");
    expect(record.error).toBeNull();
    // ...and the host is UP on the target, which is the outcome the field
    // failure denied. The stop/relaunch is the activation arm's, reached only
    // because the re-validation let this attempt through.
    expect(world.runningVersion).toBe("2.0.0");
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(outcome.legacy.version).toBe("2.0.0");
    // A host that is GONE has no live work to protect, so the arm takes the
    // `no-live-host` reading and never consults the busy gate - the branch the
    // real box was on, and a different one from the `debt` reading an
    // out-of-band host that is still up would produce.
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    // No bytes were re-applied: the swap already happened, so this run only
    // activates what is on disk.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: crashed.attemptId,
    });
  });

  // ---- Q12's fail-open branch: the ONLY route left to the forgiveness clause
  //
  // This is the red-watch for `installedByThisAttempt`, and after Q12 it is the
  // only one the suite can have. Q12 refreshes the claim baseline at
  // `afterSwap`, so every other fixture in this file reaches
  // `revalidateInstallIdentity` with a baseline that already names the swapped
  // install and passes the PRIMARY equality check - the forgiveness clause is
  // never consulted, and deleting it would redden nothing.
  //
  // What keeps the clause alive is that Q12 fails OPEN.
  // `generationWrittenBySwap` returns `null` when `readHostInstallRecord`
  // cannot be read, `refreshedClaimBaseline` turns a null refresh into "carry
  // the prior baseline unchanged", and the record lands at `restarting` still
  // naming the PRE-swap install - indistinguishable on disk from a pre-Q12
  // write, as Q12's own docblock says. That record is not a transitional
  // artifact that ages out; it is what a read failure produces, for ever.
  //
  // Ablation, run rather than asserted: delete the three conditions in
  // `installedByThisAttempt` and the file answers 1 failed / 200 passed of
  // 201 - this test, and nothing else. That 200 is the number worth writing
  // down. It is the measurement of how invisible the clause has become, and
  // the reason someone reading only a green suite would delete it: before
  // this pin existed, that same deletion was green across the board.
  //
  // A SECOND ablation, because the per-site pins prove each swap arm records
  // SOMETHING and not WHAT it records. Give `generationWrittenBySwap` a
  // legal-but-wrong generation while keeping the correct version, and the
  // file answers 2 failed / 199 passed of 201. So the generation half is NOT
  // carried by the version half - it is load-bearing, in exactly two rows:
  // the Q5 recovery pair. The mechanism is worth knowing before touching
  // either: a wrong generation defeats the primary equality check, and the
  // refreshed VERSION then defeats this clause's third condition
  // (`baseline.installedVersion !== record.targetVersion`), so the recovery
  // falls through to `failed {install-changed}` - the original field wedge,
  // re-created from the other direction.
  //
  // Nulling the generation OUTRIGHT is not that experiment and cannot be:
  // `store.ts:538` requires a non-empty string, so a blank never reaches the
  // record. It answers 70 failed with every failure reading "the attempt
  // record refused a restarting write" - a schema refusal, not a claim about
  // what any test observes. Recorded so the cheap version of this ablation is
  // not mistaken for the informative one.

  it("Q12 fail-open: a swap-time read failure leaves the PRE-swap baseline, and the forgiveness clause still admits the recovery", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestartingWithSwapRead("2.0.0", "unreadable");

    // The swap DID happen - the install record on disk is the target's, and
    // byte-identical to the one the readable variant leaves behind.
    expect(world.installedVersion).toBe("2.0.0");
    const live = await readHostInstallRecord(ENVIRONMENT);
    expect(live?.version).toBe("2.0.0");

    // ...and the baseline did NOT move with it, because the refresh read
    // nothing. This is the assertion the whole test exists for: it is the
    // record shape Q12 cannot avoid producing, and the one the equality check
    // in `revalidateInstallIdentity` cannot satisfy.
    expect(crashed.claim).toMatchObject({ installedVersion: "1.0.0" });
    // Stated as the negative too, so the test cannot quietly become a
    // duplicate of the readable-variant pin if the fixture ever changes: the
    // baseline and the live record disagree, so the primary equality check in
    // `revalidateInstallIdentity` cannot be what admits this run.
    expect(crashed.claim?.installedVersion).not.toBe(live?.version);
    // FIXTURE-TRUE AND PRODUCTION-FALSE. Read this assertion as a statement
    // about the harness, never about the system: in the field a pre-swap
    // baseline's generation names the install the swap REPLACED and therefore
    // differs from the live one - the wedged Linux box had `id:4950d09a-...`
    // in the record against `id:f55134a3-...` on disk. Here they are equal
    // only because `installRecordOf` reuses one `world.installId` for every
    // version, so the fixture cannot express the difference that made Q12
    // worth writing.
    //
    // It is asserted rather than omitted, and asserted in the direction the
    // fixture actually behaves, so that it is DELIBERATELY SELF-INVALIDATING:
    // the day someone makes the harness mint a fresh id per swap - which is
    // the more faithful harness - this line goes red and lands them on this
    // comment, instead of a silently weaker fixture going unnoticed. It is a
    // marker for a known infidelity, not a property anyone should preserve.
    //
    // It does not weaken the pin. `matches` is a conjunction, version
    // inequality alone defeats it, and `installedByThisAttempt` reads no
    // generation at all.
    expect(crashed.claim?.installGeneration).toBe(
      live === null ? null : encodeInstallGeneration(live),
    );

    // The same host-down wedge as the Q5 pin above: `restarting` is written
    // after the cooperative stop, so the old host is already gone.
    world.runningVersion = null;
    mocks.applyHostWithAttempt.mockClear();

    const outcome = await runUpdate({
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    // ADMITTED, on the same attempt: not `failed {install-changed}`, not
    // superseded. Only `installedByThisAttempt` can produce this outcome from
    // the record above - the equality check has already said no.
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("complete");
    expect(record.execution).toBe("terminal");
    expect(record.error).toBeNull();
    expect(world.runningVersion).toBe("2.0.0");
    expect(outcome.legacy.version).toBe("2.0.0");
    // Activated, never re-applied: the bytes were already placed by the run
    // that crashed.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
  });

  it("Q5 defect 2: `--intent continue` on the wedged attempt RECOVERS it - a present record whose holder is dead is not `refused-attempt-gone`", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The exact id the verb will name is ON DISK, active, at `restarting`.
    // Calling that "attempt gone" was the defect: the reconciler and the
    // dispatching host both stop naming an attempt they are told is absent,
    // and on a CLI-only install nothing else ever runs the recovery.
    expect(crashed.phase).toBe("restarting");
    expect(crashed.execution).toBe("active");
    mocks.applyHostWithAttempt.mockClear();
    mocks.writes.length = 0;

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: crashed.attemptId,
      versionRequest: "2.0.0",
      registryClient: unreachableRegistry(),
      ackNonce: "nonce-abcdefgh",
    });

    // CLAIMED, not released: the ACK names the attempt rather than reporting
    // it gone, which is the half the dispatcher acts on.
    expect(outcome.releasedReason).toBeNull();
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: crashed.attemptId,
    });
    // ...and the record does not sit at `restarting` for ever.
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("complete");
    expect(record.execution).toBe("terminal");
    expect(world.runningVersion).toBe("2.0.0");
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
  });

  it("Q5 defect 2 control: `--intent continue` naming an attempt that really IS gone still answers refused-attempt-gone", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // The same host-down wedge as the pin above.
    world.runningVersion = null;
    mocks.writes.length = 0;

    // Same wedge, a DIFFERENT id. Record presence is what the fix keys on, so
    // the negative has to move exactly that fact and nothing else.
    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: `${crashed.attemptId}-not-this-one`,
        versionRequest: "2.0.0",
        registryClient: unreachableRegistry(),
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      // No host is running behind the wedge, so the release exits non-zero
      // (defect 3) - the reason it carries is still the gone one.
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      details: { reason: "refused-attempt-gone" },
    });
    await expectAck("nonce-abcdefgh", {
      kind: "no-attempt",
      reason: "refused-attempt-gone",
    });
    // The wedged record is left exactly as it was: a verb that named someone
    // else's attempt may not reconcile this one.
    //
    // Upheld on review, not surviving by accident. #1773's stale-attempt close
    // routes EVERY selector release through a terminalization, which would end
    // this record here. It was ruled gated instead - a release may close only a
    // record it could have named - because the reconciler dispatches bound
    // verbs from an id it read a tick earlier, so a record that moved in
    // between makes an automated actor destroy an attempt nobody named. The
    // bystander below is a live recovery target with bytes already swapped,
    // which is the opposite of the unreferenced debris that close exists for.
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("restarting");
  });

  it("Q5 defect 2 control: `--intent activate` carries its OWN action, so it cannot resume an apply the caller never named", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    world.latest = "2.0.0";
    // A wedge whose evidence offers `resume-apply`, not `activate`: the stage
    // is on disk and the install never moved.
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        throw new AbortSignalError();
      },
    );
    mocks.refuseFailedWrites = true;
    await expect(runUpdate({})).rejects.toThrow("simulated crash");
    mocks.refuseFailedWrites = false;
    const crashed = await requireRecord();
    expect(crashed.phase).toBe("applying");
    expect(world.stagedVersion).toBe("2.0.0");
    mocks.applyHostWithAttempt.mockClear();
    mocks.writes.length = 0;

    // `activate` claims with `action: "activate"`, so the core's own
    // `actionMayResume` refuses the `resume-apply` continuation recovery
    // derives. Claiming with `continue` here - the shape `resumeSelection`
    // uses - would have applied a stage this verb never named.
    await expect(
      runUpdate({
        intent: "activate",
        expectAttempt: crashed.attemptId,
        versionRequest: "2.0.0",
        registryClient: unreachableRegistry(),
        ackNonce: "nonce-abcdefgh",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    });
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(world.installedVersion).toBe("1.0.0");
  });

  it("Q5 control: an install moved to a THIRD version under an activation park is STILL the foreign change it always was", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // Park it through the real verifier, so the baseline is refreshed to the
    // target exactly as production leaves it.
    await verifyHostUpdateAttempt(ENVIRONMENT, {
      attemptId: crashed.attemptId,
      generation: crashed.generation,
      sequence: crashed.sequence,
      targetVersion: "2.0.0",
    });
    const parked = await requireRecord();
    expect(parked.phase).toBe("waiting-to-activate");
    expect(parked.claim).toMatchObject({ installedVersion: "2.0.0" });

    // A FOREIGN actor now installs something else entirely. The record still
    // carries the `activate` continuation, so this is the case that
    // discriminates the fix from "any activation continuation may proceed":
    // the install is neither the baseline nor this attempt's target.
    world.installId = "install-foreign";
    await seedInstalled("3.0.0");
    mocks.writes.length = 0;

    await expect(
      runUpdate({
        intent: "activate",
        expectAttempt: crashed.attemptId,
        registryClient: unreachableRegistry(),
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
    // Terminal and untouched bytes, exactly as before the fix.
    expect(record.execution).toBe("terminal");
    expect(world.installedVersion).toBe("3.0.0");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: crashed.attemptId,
    });
  });

  it("Q5 control: killed BEFORE the swap - the install is still at the baseline, and the resumed apply runs exactly as it did", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    world.latest = "2.0.0";
    // Dies after `applying` is written but BEFORE the swap: the stage is
    // still on disk and the install record has not moved, so nothing about
    // this attempt is "past the swap".
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        options.onProgress(progress("service-stop", null));
        await options.hooks.beforeSwapCommit();
        throw new AbortSignalError();
      },
    );
    mocks.refuseFailedWrites = true;
    await expect(runUpdate({})).rejects.toThrow("simulated crash");
    mocks.refuseFailedWrites = false;
    const crashed = await requireRecord();
    expect(crashed.phase).toBe("applying");
    expect(world.installedVersion).toBe("1.0.0");
    expect(world.stagedVersion).toBe("2.0.0");
    mocks.writes.length = 0;
    mocks.applyHostWithAttempt.mockClear();

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    // The stage is what recovery finds, so the continuation is `resume-apply`
    // and the apply genuinely re-runs. The identity re-validation passed on
    // its ORIGINAL arm - the baseline still equals the live record - which is
    // what makes this a control rather than a second copy of the pin above.
    expect(mocks.applyHostWithAttempt).toHaveBeenCalledTimes(1);
    const record = await requireRecord();
    expect(record.attemptId).toBe(crashed.attemptId);
    expect(record.phase).toBe("complete");
    expect(outcome.legacy.version).toBe("2.0.0");
  });

  it("a waiting-to-activate park written by the REAL update-verify recovery is resumed by `activate` and completes", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const crashed = await crashAtRestarting("2.0.0");
    // Q12 CHANGED THIS ASSERTION, and the change is the deliverable.
    //
    // It used to read `installedVersion: "1.0.0"` - the pre-apply install -
    // because nothing refreshed the baseline across `applying -> restarting`,
    // so a crash at `restarting` left a record whose claim described a world
    // the swap had already replaced. The old comment here said "only the
    // refresh the recovery park writes makes them equal", and that was
    // exactly the defect: the record spent the whole interval between the
    // swap and the recovery unable to say what its own swap had installed.
    //
    // The swap now writes it. So the baseline is already at the target at the
    // moment of the crash, before any recovery has run.
    //
    // Read as "the swap recorded what it installed", NOT as an invariant of
    // post-Q12 records: `generationWrittenBySwap` fails open, so an
    // unreadable install record at `afterSwap` still leaves a pre-swap
    // baseline here, indistinguishable from a pre-Q12 write. This fixture has
    // a readable record; that is why the assertion is safe to make.
    expect(crashed.claim).toMatchObject({ installedVersion: "2.0.0" });

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

// ---------------------------------------------------------------------------
// #1752 round 14, re-ported onto the executor (ticket 08)
// ---------------------------------------------------------------------------
//
// An explicit `host update <version>` restarts the host onto THAT version or
// refuses. Every arm that can deliver a version is held to the request, and a
// request another actor OUTGREW is superseded, not failed (D-46).
describe("ported: the explicit request's version binding (#1752 round 14)", () => {
  it("another actor committed a NEWER version under the lock: superseded, marker WITHDRAWN, no `failed` replace, and the ACK still says claimed", async () => {
    // The coordinator's D-46 trio, first row. The record ends `superseded` -
    // a non-failure terminal the GUI's live projection maps to `idle` and its
    // record leg drops - and this run's own `updating` marker is withdrawn by
    // CONDITIONAL delete. A `failed` here would name 2.0.0 over a host at
    // 3.0.0, and no stale rule clears a `failed` whose target is not running.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        // Another actor commits something NEWER during the transfer.
        await seedInstalled("3.0.0");
        world.runningVersion = "3.0.0";
        return {
          outcome: "discarded" as const,
          reason: "not-newer-than-installed" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(
      runUpdate({ versionRequest: "2.0.0", ackNonce: "nonce-abcdefgh" }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER });

    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.execution).toBe("terminal");
    expect(record.continuation).toBeNull();
    expect(record.error).toBeNull();
    // Withdrawn, not replaced: the path is empty and no `failed` was written.
    expect(mocks.disk.current).toBeNull();
    expect(mocks.refuseFailedWrites).toBe(false);
    expect(mocks.writes).not.toContain("failed");
    expect(mocks.deleteUpdateProgressMarkerIfUnchanged).toHaveBeenCalledTimes(
      1,
    );
    // Nothing was restarted.
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    // A claim happened, so the dispatching host hears the attempt - once.
    expect(mocks.ackWrites).toEqual(["claimed"]);
    expect(await readAck("nonce-abcdefgh")).toMatchObject({
      kind: "claimed",
      attemptId: record.attemptId,
    });
    // Falsification (the ablation): route `HOST_UPDATE_NOT_NEWER` to
    // `writer.fail` in `writeFailure` and the record reads `failed` with a
    // `failed` marker naming 2.0.0 standing over a host at 3.0.0.
  });

  it("the stage was consumed and the record another actor left is OLDER: E_UNEXPECTED, STAMPED - something did go wrong", async () => {
    // The consumed-stage arm, the second of the three that settle through
    // `settleDeliveredByAnotherActor`. A record BELOW the request is not the
    // request being outgrown - it is a changed handoff - so it takes the
    // stamped terminal, not the superseded one.
    await seedInstalled("1.5.0");
    world.runningVersion = "1.5.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        // Another actor consumed the stage and committed something OLDER.
        await seedInstalled("1.0.0");
        world.runningVersion = "1.0.0";
        await seedStaged(null);
        return {
          outcome: "promoted" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(runUpdate({ versionRequest: "2.0.0" })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("the stage was consumed and the record another actor left is NEWER: superseded, marker withdrawn - the same rule on the same closure", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        await seedInstalled("3.0.0");
        world.runningVersion = "3.0.0";
        await seedStaged(null);
        return {
          outcome: "promoted" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(runUpdate({ versionRequest: "2.0.0" })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
  });

  it("another actor committed the SAME STRING and it is RUNNING: the attempt completes, exit 0, nothing restarted", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        // The request DELIVERED, by someone else, and already serving.
        await seedInstalled("2.0.0");
        world.runningVersion = "2.0.0";
        return {
          outcome: "discarded" as const,
          reason: "not-newer-than-installed" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    expect(outcome.legacy.version).toBe("2.0.0");
    const record = await requireRecord();
    expect(record.phase).toBe("complete");
    // Verified independently through the ordinary evidence loop, never
    // assumed: the run reports success only for a host it observed at the
    // target.
    expect(phaseTrace()).toContain("verifying");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
  });

  it("another actor committed the SAME STRING but it is NOT running: superseded with the restart remedy, and the NEXT run pays the debt (D-47)", async () => {
    // The third answer. The request was DELIVERED - `install.json` names
    // exactly 2.0.0 - so nothing failed and the record must not carry an
    // `error` for a state whose only remedy is a restart. This attempt cannot
    // pay it itself: a `waiting-to-activate` park may be born only from an
    // `applying` write, and this segment never applied.
    // Falsification (the ablation): stamp `failed` here and the record reads
    // `failed {stage-missing}` with a `failed` marker standing over a host
    // whose install record is exactly what was asked for.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        // Committed by someone else - and NOT activated. The runtime stays at
        // 1.0.0, which is the durable debt the next run collects.
        await seedInstalled("2.0.0");
        return {
          outcome: "discarded" as const,
          reason: "not-newer-than-installed" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    const rejection = await runUpdate({
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    // Non-zero, and it names the remedy: exit 0 for "the host does not run
    // what you asked for" is the finding-3 class this ticket exists to remove.
    expect(rejection).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      exitCode: 1,
      details: { targetVersion: "2.0.0", runningVersion: "1.0.0" },
    });
    expect(String(rejection)).toMatch(/traycer host restart/);

    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.execution).toBe("terminal");
    expect(record.continuation).toBeNull();
    expect(record.error).toBeNull();
    expect(mocks.writes).not.toContain("failed");
    // Withdrawn by conditional delete, exactly as the not-newer arm does.
    expect(mocks.disk.current).toBeNull();
    expect(mocks.deleteUpdateProgressMarkerIfUnchanged).toHaveBeenCalledTimes(
      1,
    );
    // A claim happened, so the dispatching host hears the attempt - once - and
    // the GUI follows the record to idle rather than latching the exit.
    expect(mocks.ackWrites).toEqual(["claimed"]);
    // Nothing was disturbed on the way to that terminal.
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();

    // ...and the debt is durable: the next run meets the terminal record, sees
    // installed != running in its plan, and runs the activation arm that IS
    // born with `continuation: "activate"`.
    mocks.downloadAndStageHostInSegment.mockReset();
    const next = await runUpdate({ versionRequest: "2.0.0" });

    expect(next.legacy.version).toBe("2.0.0");
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("an IMPLICIT request is bound to nothing: another actor's different version is not refused", async () => {
    // The binding is the explicit request's alone. An implicit `latest` that
    // meets a record it did not ask for takes the ordinary route - here, the
    // apply's own version binding, which refuses a stage that is not this
    // claim's rather than the RECORD being wrong.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    world.latest = "2.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        await seedInstalled("3.0.0");
        world.runningVersion = "3.0.0";
        return {
          outcome: "discarded" as const,
          reason: "not-newer-than-installed" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(runUpdate({})).rejects.toMatchObject({
      // NOT `E_HOST_UPDATE_NOT_NEWER`: no request was made to outgrow.
      code: CLI_ERROR_CODES.UNEXPECTED,
    });
  });

  it("a DISCARDED explicit transfer that is not the delivery is refused with the discard's own reason, before any apply", async () => {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    await seedStaged("3.0.0");
    mocks.downloadAndStageHostInSegment.mockImplementation(
      async (options: { readonly beforeExtract: () => Promise<void> }) => {
        await options.beforeExtract();
        return {
          outcome: "discarded" as const,
          reason: "not-strictly-newer" as const,
          targetVersion: "2.0.0",
        };
      },
    );

    await expect(runUpdate({ versionRequest: "2.0.0" })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      details: { targetVersion: "2.0.0", reason: "not-strictly-newer" },
    });

    // Never reaches the apply: a run that has decided not to act does not open
    // a mutation lock to ask about a stage it must not commit.
    expect(mocks.applyHostWithAttempt).not.toHaveBeenCalled();
    expect(world.stagedVersion).toBe("3.0.0");
  });

  it("the EXPLICIT request's record MOVED above it between the plan and the debt read: the debt is LEFT and logged, the no-op, exit 0, no marker", async () => {
    // The pre-lock gate, and the only window it is reachable through: the plan
    // reads the install record, and `readActivationState` reads it AGAIN. The
    // manifest fetch sits between the two, so moving the record from inside it
    // reproduces exactly the race main's comment describes - the plan resolves
    // `no-op` for a record that IS the request, and the debt read then sees
    // one that is not.
    //
    // Nothing is claimed, announced or written: the debt is real and stays
    // owed to an implicit `host update` or a `host restart`.
    // Falsification: drop the `requested !== reading.installedVersion` gate in
    // `resolvePlan` and this run restarts the host onto 3.0.0 under a
    // confirmation, and a CLI-floor check, made for 2.0.0.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    const moving = fakeRegistry();
    const registryClient: RegistryClient = {
      ...moving,
      fetchManifest: async () => {
        const manifest = await moving.fetchManifest();
        await seedInstalled("3.0.0");
        return manifest;
      },
    };

    const outcome = await runUpdate({
      versionRequest: "2.0.0",
      registryClient,
    });

    expect(outcome.releasedReason).toBe("nothing-to-do");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.disk.current).toBeNull();
    expect(await readRecord()).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "Host update leaves the install record's activation debt: the explicit request names another version",
      expect.objectContaining({
        requestedVersion: "2.0.0",
        installedVersion: "3.0.0",
      }),
    );
  });

  it("catalog domain: another build of the record's release running (2.0.0+bar under a 2.0.0+foo record) is DEBT, not activated", async () => {
    // The comparator calls these equal - it ignores build metadata - and the
    // old reading therefore called the host activated and did nothing. The
    // committed artifact is not the one serving, so a restart is owed.
    // Falsification: compare with `compareHostVersions` in
    // `readActivationState`'s catalog branch and this reads `activated`.
    await seedInstalled("2.0.0+foo");
    world.runningVersion = "2.0.0+bar";

    await runUpdate({});

    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("ported: the activation arm's under-lock re-read (#1752 round 14)", () => {
  it("the record moved to a NEWER version while this run waited: refused BEFORE the busy gate and the stop, superseded, marker withdrawn", async () => {
    // `selectDebtStart` read the record as the request and claimed. The arm
    // re-reads under its OWN mutation lock - which the claim lock does not
    // span - and holds it to the request again, first, so a changed handoff
    // disturbs nothing and takes nothing over. The seam that moves the record
    // is the entry mirror's marker create, which runs after the claim and
    // before the arm.
    // Falsification: move the check below `assertHostNotBusy`, or delete it,
    // and the run restarts the host onto 3.0.0 under a request for 2.0.0.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockImplementationOnce(
      async (_environment: unknown, next: HostUpdateProgress) => {
        await seedInstalled("3.0.0");
        mocks.disk.current = next;
        return "created" as const;
      },
    );

    await expect(runUpdate({ versionRequest: "2.0.0" })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      details: {
        expectedInstalledVersion: "2.0.0",
        actualInstalledVersion: "3.0.0",
      },
    });

    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(mocks.disk.current).toBeNull();
  });

  it("an activation park names the stage waiting BESIDE the debt in its details and message (D6)", async () => {
    // A stage for a later version can be waiting while this park owes the
    // restart onto the one already installed; the operator is told which.
    // Falsification: return `busy` unchanged from `parkForActivation` and the
    // message loses the sentence and `details.stagedVersion` is gone.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    await seedStaged("4.0.0");
    mocks.assertHostNotBusy.mockRejectedValue(busyError());

    const rejection = await runUpdate({}).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "4.0.0" },
    });
    expect(String(rejection)).toMatch(/Host 4\.0\.0 stays staged/);
    const record = await requireRecord();
    expect(record.phase).toBe("waiting-to-activate");
  });
});

// The five findings cold review B raised against `f924514ec`, each pinned at
// the boundary the review's own probe used. Every one of these was GREEN
// before the fix: the defects live in windows the committed suite could not
// reach, which is the point of keeping the probes rather than paraphrasing
// them.
describe("fixup: cold review B", () => {
  /** A modern park with a PINNED stage fingerprint, as every resume has. */
  async function parkWithPinnedStage(target: string): Promise<string> {
    world.latest = target;
    mocks.applyHostWithAttempt.mockRejectedValueOnce(busyError());
    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    const record = await requireRecord();
    expect(record.phase).toBe("waiting-for-work");
    // The premise of C3: a resume is pinned, so the apply's fingerprint test
    // is the one that answers first when the stage is gone.
    expect(record.claim?.stageFingerprint).not.toBeNull();
    mocks.writes.length = 0;
    mocks.downloadAndStageHostInSegment.mockClear();
    mocks.applyHostWithAttempt.mockClear();
    mocks.ackWrites.length = 0;
    return record.attemptId;
  }

  /** The armed default, so a test can consume a stage and then delegate. */
  function applyFixture(): (
    capability: unknown,
    contenderOptions: unknown,
    options: ApplyMockOptions,
  ) => Promise<unknown> {
    const armed = mocks.applyHostWithAttempt.getMockImplementation();
    if (armed === undefined) throw new Error("the apply fixture is not armed");
    return armed;
  }

  it("C1: the settlement's observation and its projection are INSIDE the mutation lock", async () => {
    // The blocker. The reading and the record the success projected used to be
    // two unlocked reads, and a competing installer that took the real CLI
    // lock between them made `--version 2.0.0` exit 0 reporting 3.0.0.
    // Falsification (the ablation): take the observation outside the lock
    // again and `concurrentWriterAcquired` flips to true and `legacy.version`
    // reads 3.0.0 - a version nobody asked for, reported as success.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkWithPinnedStage("2.0.0");
    const locks = await import("../../store/cli-lock");
    let concurrentWriterAcquired = false;
    const delegate = applyFixture();
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        capability: unknown,
        contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        // Another actor consumed this park's stage under the apply's own lock
        // and committed it, so the settlement is reached legitimately.
        await seedInstalled("2.0.0");
        world.runningVersion = "2.0.0";
        await seedStaged(null);
        // ...and while the settlement's activation read is pending, a
        // CLI-lock-respecting writer tries to move the record again. It must
        // not get in: the settlement holds that lock now.
        mocks.readHostPidMetadata.mockImplementationOnce(async () => {
          const observed = pidMetadata("2.0.0");
          await locks
            .withCliLock(
              {
                environment: ENVIRONMENT,
                reason: "fixup-competing-install",
                waitMs: 0,
                pollIntervalMs: 10,
              },
              async () => {
                concurrentWriterAcquired = true;
                await seedInstalled("3.0.0");
                world.runningVersion = "3.0.0";
              },
            )
            .catch(() => undefined);
          return observed;
        });
        return delegate(capability, contenderOptions, options);
      },
    );

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    // Mutual exclusion, observed rather than assumed.
    expect(concurrentWriterAcquired).toBe(false);
    // The bound projection: the record the decision was made against, never a
    // later read.
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(world.installedVersion).toBe("2.0.0");
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
    expect(mocks.ackWrites).toEqual(["claimed"]);
  });

  it("C1: a record ALREADY moved above the request when the settlement takes its lock is the D-46 refusal, never a success", async () => {
    // The other half of the same rule: the lock closes the window, and a move
    // that happened BEFORE it is caught by the request binding inside it.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkWithPinnedStage("2.0.0");
    const delegate = applyFixture();
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        capability: unknown,
        contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        await seedInstalled("3.0.0");
        world.runningVersion = "3.0.0";
        await seedStaged(null);
        return delegate(capability, contenderOptions, options);
      },
    );

    await expect(
      runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
    });

    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
  });

  it("C1: the SUCCESS projects the record the settlement validated, not a later read", async () => {
    // The other half of the binding. The lock closes the window against
    // writers that RESPECT it (the pin above); this one models a writer that
    // does not - it moves `install.json` from inside the marker write the
    // supersede triggers, so the record on disk is 3.0.0 by the time the arm
    // returns. The projection must still name the record the decision was
    // made against, because that is the only record this run ever validated
    // against the request.
    // Falsification (the ablation): re-read the install record in the
    // `delivered-and-running` arm and this reports 3.0.0 for a request that
    // was about 2.0.0.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkWithPinnedStage("2.0.0");
    const delegate = applyFixture();
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        capability: unknown,
        contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        await seedInstalled("2.0.0");
        world.runningVersion = "2.0.0";
        await seedStaged(null);
        return delegate(capability, contenderOptions, options);
      },
    );
    let moved = false;
    const deleteMarker =
      mocks.deleteUpdateProgressMarkerIfUnchanged.getMockImplementation();
    if (deleteMarker === undefined) throw new Error("marker fixture not armed");
    mocks.deleteUpdateProgressMarkerIfUnchanged.mockImplementation(
      async (environment: string, expected: HostUpdateProgress) => {
        const outcome = await deleteMarker(environment, expected);
        if (!moved) {
          moved = true;
          await seedInstalled("3.0.0");
        }
        return outcome;
      },
    );

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
    });

    expect(moved).toBe(true);
    expect(world.installedVersion).toBe("3.0.0");
    expect(outcome.legacy.version).toBe("2.0.0");
    expect((await requireRecord()).phase).toBe("superseded");
  });

  it.each([
    ["apply", "1.0.0", false],
    ["downgrade", "3.0.0", true],
  ] as const)(
    "C2: a %s refusal BEFORE the actuator reports disruption restores the displaced writer instead of stamping over it",
    async (arm, installedVersion, allowDowngrade) => {
      // `commitInstallFromSource` emits `service-stop` before the lifecycle's
      // status and authority checks, so a refusal in those checks arrives with
      // the label printed and NOTHING stopped. Inferring disruption from the
      // label made this run steal a live writer's marker.
      // Falsification (the ablation): put the label rule back in `onProgress`
      // and both arms stamp `failed {2.0.0}` over the foreign `updating`.
      await seedInstalled(installedVersion);
      world.runningVersion = installedVersion;
      const foreign: HostUpdateProgress = {
        state: "updating",
        error: null,
        targetVersion: "4.0.0",
        updatedAt: "2026-01-01T00:00:00.000Z",
        writerId: "foreign-writer",
        writerStartIdentity: null,
      };
      mocks.disk.current = foreign;
      const refuse = async (input: {
        readonly onProgress: (info: ProgressInfo) => void;
      }): Promise<never> => {
        input.onProgress(progress("service-stop", null));
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "authority refused before controller.stop",
          details: null,
          exitCode: 1,
        });
      };
      if (arm === "apply") {
        mocks.applyHostWithAttempt.mockImplementation(
          async (
            _capability: unknown,
            _contenderOptions: unknown,
            options: ApplyMockOptions,
          ) => refuse(options),
        );
      } else {
        mocks.installHostDowngradeInSegment.mockImplementation(refuse);
      }

      await expect(
        runUpdate({ versionRequest: "2.0.0", allowDowngrade }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      });

      expect(mocks.disk.current).toEqual(foreign);
    },
  );

  it.each([
    ["D-46", "3.0.0", "3.0.0"],
    ["D-47", "2.0.0", "1.0.0"],
    ["D-47b", "2.0.0", "2.0.0"],
  ] as const)(
    "C3: a CONSUMED pinned stage reaches the settlement, not the fingerprint refusal: %s",
    async (label, installedVersion, runningVersion) => {
      // Every resume pins a fingerprint, and `installer/apply.ts` tests the
      // fingerprint BEFORE its no-stage answer - so an absent stage under a
      // resume is `stage-fingerprint-mismatch {actualStageFingerprint: null}`,
      // not `no-op`. All three settlement answers were unreachable in
      // production for the very case they were written for, and came out
      // `failed` / `E_UNEXPECTED` instead.
      // Falsification (the ablation): route a null actual fingerprint back to
      // the refusal and all three of these redden together.
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      const attemptId = await parkWithPinnedStage("2.0.0");
      const delegate = applyFixture();
      const outcomes: unknown[] = [];
      mocks.applyHostWithAttempt.mockImplementationOnce(
        async (
          capability: unknown,
          contenderOptions: unknown,
          options: ApplyMockOptions,
        ) => {
          await seedInstalled(installedVersion);
          world.runningVersion = runningVersion;
          await seedStaged(null);
          const outcome = await delegate(capability, contenderOptions, options);
          outcomes.push(outcome);
          return outcome;
        },
      );

      const settled = await runUpdate({
        intent: "continue",
        expectAttempt: attemptId,
        versionRequest: "2.0.0",
      }).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );

      // The fixture answered what production answers, and the arm still
      // reached the settlement.
      expect(outcomes).toEqual([
        {
          outcome: "stage-fingerprint-mismatch",
          installedVersion,
          expectedStageFingerprint: expect.any(String),
          actualStageFingerprint: null,
        },
      ]);
      const record = await requireRecord();
      expect(record.phase).toBe("superseded");
      expect(record.error).toBeNull();
      expect(mocks.disk.current).toBeNull();
      if (label === "D-47b") {
        expect(settled.error).toBeNull();
      } else {
        expect(settled.error).toMatchObject({
          code:
            label === "D-46"
              ? CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER
              : CLI_ERROR_CODES.HOST_NOT_RUNNING,
        });
      }
    },
  );

  it("C4: the debt clears between selection and the activation lock: no busy gate, no stop, exit 0", async () => {
    // A pending service-manager start finishing in the gap - no competing
    // installer needed. The arm re-read only `install.json`, so it gated and
    // restarted a host that was ALREADY serving the target, or parked
    // `waiting-to-activate` over it when the gate refused.
    // Falsification (the ablation): drop the arm's under-lock activation read
    // and branch on `selection.debtReading` again.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    // Armed to REFUSE, so consulting it at all is visible.
    mocks.assertHostNotBusy.mockRejectedValue(busyError());
    mocks.beforeAttemptMutation.mockImplementation((reason: string) => {
      if (reason === "host-update-activate") world.runningVersion = "2.0.0";
    });

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    expect(outcome.legacy.version).toBe("2.0.0");
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.relaunchHostAfterRestartWithAttempt).not.toHaveBeenCalled();
    // `superseded`, not `complete`: an `activate` continuation may verify only
    // once it has written the `restarting` that says the restart was its own,
    // and this segment restarted nothing. Someone else finished the work, so
    // the record says so and the run reports the truthful no-op.
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
  });

  it("#1763: every marker this run writes carries BOTH the writer id and the writer-start stamp", async () => {
    // The host daemon suppresses an `updating` marker whose
    // `writerStartIdentity` does not match the live pid's (internal #5536). A
    // record written with a NULL stamp falls back to pid-only fail-open, so
    // once that pid is recycled onto an unrelated process the banner says
    // "Updating..." forever. Both the entry mirror's create and the failure
    // stamp go through `progressRecord`, which stamps both.
    // Falsification: drop `writerStartIdentity` from `progressRecord` and
    // both assertions below go null.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.downloadAndStageHostInSegment.mockImplementation(async () => {
      throw new Error("download lost");
    });

    await expect(runUpdate({})).rejects.toThrow("download lost");

    const created = mocks.createUpdateProgressMarkerIfAbsent.mock.calls[0]?.[1];
    expect(created).toMatchObject({
      state: "updating",
      writerId: "test-writer",
      writerStartIdentity: mocks.writerStartIdentity,
    });
    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      writerId: "test-writer",
      writerStartIdentity: mocks.writerStartIdentity,
    });
  });

  it("D2: a FOREIGN runtime under the arm's lock is left alone - no gate, no stop, no relaunch (D-51)", async () => {
    // The cell C4 opened. The arm re-reads under its own lock now, so it can
    // see a reading the SELECTOR never produces - and the first port gated on
    // `kind !== "no-live-host"`, which sent the busy gate, a stop and a
    // relaunch at a host running a developer's build. Main's predicate is
    // "only `debt` and `no-live-host` are mine", and `selectDebtStart` 1,400
    // lines above already uses it.
    // Falsification (the ablation): reinstate `kind !== "no-live-host"` and
    // this run stops and restarts a non-release host.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.beforeAttemptMutation.mockImplementation((reason: string) => {
      if (reason === "host-update-activate") {
        world.runningVersion = "staging.1750000000.abc1234";
      }
    });

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    expect(mocks.relaunchHostAfterRestartWithAttempt).not.toHaveBeenCalled();
    // Untouched: the developer's build is still the one serving.
    expect(world.runningVersion).toBe("staging.1750000000.abc1234");
    // Exit 0, and the string it left running is carried out - NOT
    // `E_HOST_NOT_RUNNING` (the host IS running) and NOT a null
    // `runningVersion` (which is where main's predicate alone would land).
    expect(outcome.legacy.version).toBe("2.0.0");
    expect(outcome.foreignRuntimeVersion).toBe("staging.1750000000.abc1234");
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "Host update left a non-release host running: nothing was activated",
      expect.objectContaining({
        installedVersion: "2.0.0",
        runningVersion: "staging.1750000000.abc1234",
      }),
    );
  });

  it("D2: the shell says what is running and that nothing was activated", async () => {
    // The operator-facing half of D-51. A bare "(no-op)" would hide the only
    // fact that explains it.
    // Falsification: drop the `foreignRuntimeVersion` arm from `humanSummary`
    // and the line collapses to the ordinary no-op sentence.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.beforeAttemptMutation.mockImplementation((reason: string) => {
      if (reason === "host-update-activate") {
        world.runningVersion = "staging.1750000000.abc1234";
      }
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.0.0",
      ackNonce: null,
      intent: null,
      expectAttempt: null,
    })(shellContext());

    expect(result.human).toBe(
      "host already at 2.0.0 (no-op); the running host is staging.1750000000.abc1234, not a release build, so nothing was activated",
    );
    expect(result.exitCode).toBe(0);
  });

  it("D2: the host DIES in the gap - main's other arm, unchanged: no gate, one stop, complete", async () => {
    // The sibling cell, pinned so main's predicate cannot be over-applied:
    // `no-live-host` IS this command's to act on. The gate is skipped because
    // a host that is gone has no live work to protect, and the stop reports a
    // forced recycle that the relaunch repairs.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.beforeAttemptMutation.mockImplementation((reason: string) => {
      if (reason === "host-update-activate") world.runningVersion = null;
    });

    const outcome = await runUpdate({ versionRequest: "2.0.0" });

    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttempt).toHaveBeenCalledTimes(1);
    expect(outcome.foreignRuntimeVersion).toBeNull();
    expect((await requireRecord()).phase).toBe("complete");
  });

  it("D1: the downgrade actuator callback marks disruption even without a progress label", async () => {
    // The twin of the apply pin. Production threads `onWillDisruptHost` into
    // both `onWillStopHost` and `onWillSwap`, but nothing caught its removal:
    // replacing just this callback with a no-op left 151/151 green.
    // Falsification (the ablation): `onWillDisruptHost: () => {}` on the
    // downgrade arm and the displaced writer is RESTORED instead of stamped.
    await seedInstalled("3.0.0");
    world.runningVersion = "3.0.0";
    mocks.disk.current = {
      state: "updating",
      error: null,
      targetVersion: "4.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
      writerStartIdentity: null,
    };
    mocks.installHostDowngradeInSegment.mockImplementation(
      async (input: { readonly onWillDisruptHost: () => void }) => {
        // Past the actuator's own report: the stop was ISSUED and then
        // failed, which is this run's doing and stamps.
        input.onWillDisruptHost();
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "controller.stop failed after issuance",
          details: null,
          exitCode: 1,
        });
      },
    );

    await expect(
      runUpdate({ versionRequest: "2.0.0", allowDowngrade: true }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("C5: the activation arm's OWN request check, raced after the common re-validation", async () => {
    // The pin this replaces injected its race during entry-marker creation,
    // which runs BEFORE `revalidateInstallIdentity` - so it exercised the
    // common re-validation and passed with the arm's own check deleted. This
    // one injects at the arm's lock acquisition, after that re-validation, so
    // only the arm's check can catch it.
    // Falsification (the ablation): delete the arm's `installedVersionMismatch`
    // and this reddens - the run restarts the host onto 3.0.0 under a request
    // for 2.0.0 and fails its health check afterwards.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    let moved = false;
    mocks.beforeAttemptMutation.mockImplementation(async (reason: string) => {
      if (reason !== "host-update-activate" || moved) return;
      moved = true;
      await seedInstalled("3.0.0");
    });

    await expect(runUpdate({ versionRequest: "2.0.0" })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      details: {
        expectedInstalledVersion: "2.0.0",
        actualInstalledVersion: "3.0.0",
      },
    });

    expect(moved).toBe(true);
    // Before the gate and before the stop, which is what makes "nothing was
    // restarted" true in the message.
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(mocks.disk.current).toBeNull();
  });

  /**
   * The D-51 world reached WITHOUT the activation arm: a resume whose stage
   * another actor consumed and committed, onto a host that is now running a
   * developer's build. Four of the five routes into
   * `settleDeliveredByAnotherActor` look like this, and none of them passes
   * through the activation arm - so the settlement's own write is the only
   * thing that can carry the fact out on any of them.
   */
  async function consumedStageOntoForeignRuntime(): Promise<string> {
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    const attemptId = await parkWithPinnedStage("2.0.0");
    const delegate = applyFixture();
    mocks.applyHostWithAttempt.mockImplementationOnce(
      async (
        capability: unknown,
        contenderOptions: unknown,
        options: ApplyMockOptions,
      ) => {
        await seedInstalled("2.0.0");
        world.runningVersion = "staging.1750000000.abc1234";
        await seedStaged(null);
        return delegate(capability, contenderOptions, options);
      },
    );
    return attemptId;
  }

  it("E1: D-51 is reached through the APPLY arm too, and the settlement is what says so", async () => {
    // The committed D-51 pins both drive the ACTIVATION arm, where a second,
    // redundant write of the same fact used to stand. It masked the only write
    // that matters: this route never touches that arm.
    // Falsification (the ablation): delete the settlement's
    // `input.selection.foreignRuntimeVersion` write and this reddens on the
    // very first assertion, with the arm's write restored or not.
    const attemptId = await consumedStageOntoForeignRuntime();

    const outcome = await runUpdate({
      intent: "continue",
      expectAttempt: attemptId,
      versionRequest: "2.0.0",
      ackNonce: "nonce-abcdefgh",
    });

    expect(outcome.foreignRuntimeVersion).toBe("staging.1750000000.abc1234");
    expect(outcome.legacy.version).toBe("2.0.0");
    // Nothing was stopped and nothing was gated: the same catalog-domain
    // answer the activation arm gives, arrived at from the other side.
    expect(mocks.assertHostNotBusy).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
    expect(mocks.disk.current).toBeNull();
  });

  it("E1: the shell renders the foreign sentence on that route as well", async () => {
    const attemptId = await consumedStageOntoForeignRuntime();

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.0.0",
      ackNonce: null,
      intent: "continue",
      expectAttempt: attemptId,
    })(shellContext());

    expect(result.human).toBe(
      "host already at 2.0.0 (no-op); the running host is staging.1750000000.abc1234, not a release build, so nothing was activated",
    );
    expect(result.exitCode).toBe(0);
  });

  it("E1: the host is a RELEASE build again by the settlement's lock - no foreign sentence", async () => {
    // The negative, and the reason the arm's write had to go: the arm reads
    // under `host-update-activate` and the settlement decides under
    // `host-update-settle`. A host that went foreign and came back between the
    // two is `activated` when the answer is chosen, so there is no foreign
    // fact to report - and a value captured at the earlier lock would have
    // been rendered anyway, telling the operator about a build that is no
    // longer running while the record says `superseded` for another reason.
    // Falsification (the ablation): put the arm's write back and this reddens
    // on the sentence.
    await seedInstalled("2.0.0");
    world.runningVersion = "1.0.0";
    mocks.beforeAttemptMutation.mockImplementation((reason: string) => {
      if (reason === "host-update-activate") {
        world.runningVersion = "staging.1750000000.abc1234";
      }
      if (reason === "host-update-settle") world.runningVersion = "2.0.0";
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.0.0",
      ackNonce: null,
      intent: null,
      expectAttempt: null,
    })(shellContext());

    expect(result.human).not.toMatch(/not a release build/);
    expect(result.exitCode).toBe(0);
    // The world the operator is told about is the world the decision was made
    // in: a release host serving the target, settled as someone else's work.
    expect(world.runningVersion).toBe("2.0.0");
    expect(mocks.stopHostForRestartWithAttempt).not.toHaveBeenCalled();
    const record = await requireRecord();
    expect(record.phase).toBe("superseded");
    expect(record.error).toBeNull();
  });
});

describe("E13: the verify leg says WHY the host never became healthy", () => {
  /**
   * The applied-but-unhealthy shape every case below shares: the swap
   * succeeds, the record moves to the target, and `after` sets the world the
   * verify loop then polls until its deadline.
   */
  function applyThenLeaveWorld(after: () => void): void {
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
        await options.hooks.afterSwap();
        after();
        return appliedOutcome(previous, "2.0.0");
      },
    );
  }

  /** As above, but the post-swap service start ERRORED (Q6). */
  function applyWithStartErrorThenLeaveWorld(
    after: () => void,
    postSwapError: string,
  ): void {
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
        await options.hooks.afterSwap();
        after();
        return appliedOutcomeWithStartError(previous, "2.0.0", postSwapError);
      },
    );
  }

  it.each([
    [
      "the pid names no live process",
      (): void => {
        world.runningVersion = null;
        world.runningDiagnosis = "host-process-dead";
      },
      "host-process-dead",
    ],
    [
      "the pid was RECYCLED onto another process",
      (): void => {
        world.runningVersion = null;
        world.runningDiagnosis = "host-process-recycled";
      },
      "host-process-recycled",
    ],
    [
      "the pid record carries no start stamp",
      (): void => {
        world.runningVersion = null;
        world.runningDiagnosis = "pid-start-stamp-missing";
      },
      "pid-start-stamp-missing",
    ],
    [
      "the host answers, at the version it was supposed to leave",
      (): void => {
        world.runningVersion = "1.0.0";
      },
      "running-version-mismatch",
    ],
  ] as const)(
    "carries the reason into the message and the record: %s",
    async (_label, after, token) => {
      // The gap Linux E13 found: this leg polled the SAME evidence the legacy
      // `probeHostHealth` used to diagnose four ways, and reported none of it.
      // "did not become healthy" with no reason is the 1.2.0 shape.
      // Falsification (the ablation): drop the `: ${diagnosis}` from the
      // verify-timeout message and every row here reddens.
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      applyThenLeaveWorld(after);

      const failure = await runUpdate({}).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
        message: `host update: applied 2.0.0 but the host did not become healthy at that version: ${token}`,
        details: { diagnosis: token },
      });
      // The SAME string on the record, so support reads what the shell
      // printed - `error` has three fields and none of them is a spare one.
      const record = await requireRecord();
      expect(record.phase).toBe("failed");
      expect(record.error).toMatchObject({
        code: "verify-timeout",
        phase: "verifying",
        message: `host update: applied 2.0.0 but the host did not become healthy at that version: ${token}`,
      });
    },
  );

  // ---- Q19: a host that ANSWERED and refused ends the leg now ---------------
  //
  // The Linux lane measured the case: an old host that fails enrollment stays
  // unprovisioned, holds no JWKS, and rejects every authenticated inbound call
  // while still serving unauthenticated loopback HTTP. The verify leg then
  // spent the whole 45 s budget re-asking a question the first answer had
  // already settled, and reported a TIMEOUT for a host that had replied
  // promptly and definitely.
  //
  // The rule has two halves and the pins below are one per half: a REFUSAL
  // short-circuits, and a host that is merely not answering yet does not.

  it("Q19: two consecutive refusals end the leg early, and say so", async () => {
    // The poll count is the assertion that matters. With `verifyBudgetMs: 200`
    // and `verifyPollIntervalMs: 5` the deadline arm takes ~40 observations;
    // this must take exactly the streak length.
    // Falsification (the ablation): drop the `refused ||` from the loop's exit
    // condition and this reddens on the observation count, on the record code
    // and on the message.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyThenLeaveWorld(() => {
      world.runningVersion = null;
      world.runningDiagnosis = "host-refuses-authenticated-rpc";
      world.runningRefusal =
        "UNAUTHORIZED: no applicable key found in the JSON Web Key Set";
    });

    const failure = await runUpdate({}).then(
      () => null,
      (error: unknown) => error,
    );

    expect(mocks.observeAttemptRecoveryEvidence).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
      // The host's OWN words, which is the one fact the operator cannot
      // reconstruct from a token.
      details: {
        refusal:
          "UNAUTHORIZED: no applicable key found in the JSON Web Key Set",
      },
      message: expect.stringContaining("REFUSED this client's authenticated"),
    });
    // The remedy, pinned because the lane proved retrying is futile: the
    // adopted host id persists on disk across installs and restarts, so this
    // refusal recurs on every attempt. A message reading "transient, try
    // again" would loop the operator forever.
    expect(failure).toMatchObject({
      message: expect.stringContaining("retrying cannot change"),
    });
    expect(failure).toMatchObject({
      message: expect.stringContaining("updating forward to a newer host"),
    });
    // NOT `verify-timeout`. Nothing timed out - the leg stopped early because
    // the host gave a definite answer - and a record saying otherwise sends
    // the operator hunting a slow host instead of a rejected client. This is
    // the Q11 lesson in the other direction.
    const record = await requireRecord();
    expect(record.error).toMatchObject({
      code: "host-refuses-rpc",
      phase: "verifying",
    });
  });

  it.each([
    // 1.2.0: fails enrollment against its OWN minted hostId.
    ["UNAUTHORIZED: no applicable key found in the JSON Web Key Set"],
    // 1.1.11: logs no enrollment attempt at all, same dead end.
    ["FORBIDDEN: device credential file does not match this host"],
  ])(
    "Q19: every authenticated refusal classifies the same, whatever the host says (%s)",
    async (reason) => {
      // The lane measured two eras failing the same way by different routes -
      // 1.2.0 mints its own hostId and is refused, 1.1.11 never attempts
      // enrollment - and both must land on ONE token. They do by construction
      // rather than by luck: the gate keys on the RPC error CODE, so nothing
      // about a host's enrollment behaviour, its log wording or its hostId
      // reaches the classification. Only `details.refusal` differs.
      // Falsification: key the gate on the message text instead of the code
      // and one of these rows reddens.
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      applyThenLeaveWorld(() => {
        world.runningVersion = null;
        world.runningDiagnosis = "host-refuses-authenticated-rpc";
        world.runningRefusal = reason;
      });

      const failure = await runUpdate({}).then(
        () => null,
        (error: unknown) => error,
      );

      expect(mocks.observeAttemptRecoveryEvidence).toHaveBeenCalledTimes(2);
      expect(failure).toMatchObject({ details: { refusal: reason } });
      expect((await requireRecord()).error).toMatchObject({
        code: "host-refuses-rpc",
      });
    },
  );

  it.each([
    [
      "a JWKS refusal proves a credential plane answered",
      "UNAUTHORIZED: no applicable key found in the JSON Web Key Set",
      "The host's credential plane answered and rejected this client",
      "The host at this version cannot authenticate",
    ],
    [
      "a handshake-level refusal proves only that the host said no",
      "FORBIDDEN: connection rejected",
      "The host at this version cannot authenticate",
      "credential plane answered and rejected",
    ],
  ])(
    "Q21 fixup: the remedy is era-neutral - %s",
    async (_label, refusal, expected, forbidden) => {
      // The first version of this message said "the host has to be
      // re-enrolled", which is FALSE for an older host: it has no coordination
      // subsystem at all, so the sentence named a plane that does not exist on
      // the operator's machine. And for hosts that DO have one, the Q18 host
      // fix stops the refusal occurring.
      //
      // The era, proven: the coordination path is absent through 1.1.11 (its
      // release provenance names build sha `5b45e06a60`, and the path is
      // absent there) and present at `host-v1.2.0-rc.1`. Two earlier versions
      // of this comment were wrong in opposite directions - one too wide, one
      // too cautious. These rows never cared: the gate keys on what the refusal
      // PROVES, so no movement of the era can redden them.
      //
      // So the sentence may only claim a credential plane when the refusal
      // proves one answered - a key set was consulted - and must otherwise say
      // the era-neutral thing that is true everywhere.
      // Falsification: collapse `refusedMessage` to one arm and whichever row
      // loses its `expected` reddens; drop the `forbidden` check and a
      // regression to the old over-claim would pass silently.
      await seedInstalled("1.0.0");
      world.runningVersion = "1.0.0";
      applyThenLeaveWorld(() => {
        world.runningVersion = null;
        world.runningDiagnosis = "host-refuses-authenticated-rpc";
        world.runningRefusal = refusal;
      });

      const failure = await runUpdate({}).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        message: expect.stringContaining(expected),
      });
      expect(failure).not.toMatchObject({
        message: expect.stringContaining(forbidden),
      });
      // Never era-specific, on either row: nothing claims re-enrolment.
      expect(failure).not.toMatchObject({
        message: expect.stringContaining("re-enrol"),
      });
      // ...and both rows still say the update itself landed.
      expect(failure).toMatchObject({
        message: expect.stringContaining("and the host is running it"),
      });
    },
  );

  it("Q19: a host that is merely NOT ANSWERING keeps its whole budget", async () => {
    // The other half, and the one that makes the first half safe: a host that
    // has not answered yet may be mid-restart, which is the entire reason the
    // budget exists. Only an ANSWER - an RPC error frame, which proves the
    // connection opened and the host chose a refusal - may shorten it.
    // Falsification (the ablation): widen `authenticatedRefusalReason` to
    // return a reason for any error, and this reddens on both the observation
    // count and the record code while the pin above stays green.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyThenLeaveWorld(() => {
      world.runningVersion = null;
      world.runningDiagnosis = "host-rpc-unreachable";
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(
      mocks.observeAttemptRecoveryEvidence.mock.calls.length,
    ).toBeGreaterThan(5);
    expect((await requireRecord()).error).toMatchObject({
      code: "verify-timeout",
    });
  });

  it("Q19: ONE refusal does not short-circuit - the streak has to be consecutive", async () => {
    // What `consecutive` buys, made falsifiable. The messenger under this call
    // revalidates a bearer and retries once, so a lone `UNAUTHORIZED` can be
    // the tail of a rotation this run is about to win; stopping on it would
    // turn a self-healing case into a reported failure.
    // Falsification (the ablation): set `VERIFY_REFUSAL_STREAK_TO_STOP` to 1,
    // or latch the flag instead of resetting it, and this reddens.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyThenLeaveWorld(() => {
      world.runningVersion = null;
      world.runningDiagnosis = "host-refuses-authenticated-rpc";
      world.runningRefusal = "UNAUTHORIZED: rotating";
    });
    // ...and the very next reading is a different failure, which resets the
    // streak. The run must then ride the budget out like any other.
    mocks.observeAttemptRecoveryEvidence.mockImplementationOnce(async () => {
      const observation = observationOfWorld();
      world.runningDiagnosis = "host-rpc-unreachable";
      world.runningRefusal = null;
      return observation;
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(
      mocks.observeAttemptRecoveryEvidence.mock.calls.length,
    ).toBeGreaterThan(5);
    expect((await requireRecord()).error).toMatchObject({
      code: "verify-timeout",
    });
  });

  it("Q19: the refusal's marker stamp is UNCONDITIONAL, like its two siblings", async () => {
    // The trap `UNCONDITIONALLY_STAMPED_FAILURE_CODES`' docblock names in
    // advance - Q6 fell into it once and its ablation came back green. A third
    // code of that class has to be added to the SET, not just to the message,
    // or the observed-running suppression silences it.
    //
    // It would be at its most wrong here: a host that refuses the CLI's
    // authenticated call is very likely still serving `pid.json` AT the
    // target, so the suppression would read "healthy", withhold the stamp, and
    // leave the operator a machine nothing can update and no signal saying so.
    // Falsification (the ablation): remove `"host-refuses-rpc"` from the set
    // and this reddens on the marker never being written.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    mocks.createUpdateProgressMarkerIfAbsent.mockResolvedValueOnce("failed");
    // The world the suppression is wrong about, built the way the sibling
    // `verify-timeout` pin builds it: the apply lands and `pid.json` comes back
    // AT the target - the reading `targetObservedRunning` trusts - while the
    // evidence loop's running leg stays UNREADABLE because the host refuses to
    // talk to this client.
    mocks.observeAttemptRecoveryEvidence.mockImplementation(async () => {
      const observation = observationOfWorld();
      return {
        ...observation,
        evidence: {
          ...observation.evidence,
          running: { kind: "unreadable" as const },
        },
        runningDiagnosis: "host-refuses-authenticated-rpc" as const,
        runningRefusal: "UNAUTHORIZED: unprovisioned host",
      };
    });

    await expect(runUpdate({})).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.disk.current).toMatchObject({
      state: "failed",
      targetVersion: "2.0.0",
    });
  });

  it("Q6: says the SERVICE START failed, rather than reporting it as a health timeout", async () => {
    // Mac item 6 / F-mac-1. `applyHostWithAttempt` returned
    // `postSwapError` 65 ms after the swap - the service start had errored -
    // and the run spent the whole verify budget and then reported "did not
    // become healthy at that version". The probe's token is TRUE and useless:
    // a refused start and a sick host look identical to it (no process, no
    // RPC), and their remedies are different. The operator was never told the
    // start failed.
    // Falsification (the ablation): collapse the message back to the single
    // `postSwapError === null` arm, and/or restore `code: "verify-timeout"`
    // unconditionally - this reddens while every E13 row above stays green.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyWithStartErrorThenLeaveWorld(() => {
      world.runningVersion = null;
      world.runningDiagnosis = "pid-metadata-absent";
    }, "E_SERVICE_CONTROL_FAILED: launchctl kickstart exited 5");

    const failure = await runUpdate({}).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
      details: {
        diagnosis: "pid-metadata-absent",
        // Carried structurally too, not only inside the prose.
        postSwapError: "E_SERVICE_CONTROL_FAILED: launchctl kickstart exited 5",
      },
    });
    const message = (failure as { message: string }).message;
    // The start failure, the remedy, and - still - the probe token, because
    // the reader who needs the token has nowhere else to get it.
    expect(message).toContain("the service start failed");
    expect(message).toContain(
      "E_SERVICE_CONTROL_FAILED: launchctl kickstart exited 5",
    );
    expect(message).toContain("traycer host service install");
    expect(message).toContain("pid-metadata-absent");
    // The bytes ARE committed - `applyHost` does not roll back - and a message
    // that let the operator think otherwise would send them to reinstall.
    expect(message).toContain("committed");

    const record = await requireRecord();
    expect(record.phase).toBe("failed");
    expect(record.error).toMatchObject({
      // A DIFFERENT code from a health timeout, so a support reader can sort
      // the two without parsing prose.
      code: "service-start-failed",
      phase: "verifying",
      message,
    });
  });

  it("Q6: a health timeout with NO start error is unchanged", async () => {
    // The control for the row above: the split must not rewrite the ordinary
    // verify-timeout, whose code `failed()` keys its unconditional marker
    // stamp on.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyThenLeaveWorld(() => {
      world.runningVersion = null;
      world.runningDiagnosis = "pid-metadata-absent";
    });

    const failure = await runUpdate({}).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
      message:
        "host update: applied 2.0.0 but the host did not become healthy at that version: pid-metadata-absent",
      details: { diagnosis: "pid-metadata-absent", postSwapError: null },
    });
    const record = await requireRecord();
    expect(record.error).toMatchObject({ code: "verify-timeout" });
  });

  it("Q1: the verify leg's stamp policy is derived from the TARGET, not from the host it finds", async () => {
    // The leg half of Q1. `update-executor.test.ts` pins the terminal write
    // end to end through the real reader; this suite MOCKS the reader, so what
    // it can prove - and the only place that proves it - is which policy the
    // leg computed and handed over.
    //
    // Below the floor: `version-only`. The target is 1.1.5, chosen against the
    // OBSERVATION and not against today's constant: <= 1.1.8 is the band where
    // raw `pid.json` readings show no stamp, so it stays below the shipped
    // err-high line (`HOST_START_STAMP_FLOOR`, 1.1.11) and below the writer's
    // own tag (`HOST_START_STAMP_WRITER_FLOOR`, 1.1.9) that it drops to when
    // the Linux 1.1.9/1.1.10 rows land. 1.1.11 and 1.2.0 are ABOVE the floor
    // and fail verify for a different, still-open reason (Q15); a row written
    // against those would go green for the wrong mechanism.
    await seedInstalled("1.0.0");
    world.latest = "1.1.5";
    world.runningVersion = "1.1.5";
    world.identityCompared = false;

    await runUpdate({});

    const policies = mocks.observeAttemptRecoveryEvidence.mock.calls.map(
      (call) => call[2],
    );
    expect(policies.length).toBeGreaterThan(0);
    expect(new Set(policies)).toEqual(new Set(["version-only"]));
    // Ablation: hard-code `"identity-required"` at the leg's
    // `observeAttemptRecoveryEvidence` call and this reddens while the
    // above-floor row below stays green.
  });

  it("Q1 CONTROL: an ABOVE-floor target keeps identity-required, whatever the host reports", async () => {
    // The gate is on the target, so the same healthy host verified strictly
    // here and permissively above. Without this row, "derived from the target"
    // is indistinguishable from "always permissive".
    await seedInstalled("1.0.0");
    world.latest = "2.0.0";
    world.runningVersion = "2.0.0";
    world.identityCompared = false;

    await runUpdate({});

    const policies = mocks.observeAttemptRecoveryEvidence.mock.calls.map(
      (call) => call[2],
    );
    expect(policies.length).toBeGreaterThan(0);
    expect(new Set(policies)).toEqual(new Set(["identity-required"]));
  });

  it("names the INSTALLED leg when that is the one that disagrees", async () => {
    // The premise before the symptom: a running host cannot be serving what
    // the record does not say is placed, so reporting the process would send
    // the reader after the wrong thing.
    await seedInstalled("1.0.0");
    world.runningVersion = "1.0.0";
    applyThenLeaveWorld(() => {
      world.installedVersion = null;
      world.runningVersion = null;
      world.runningDiagnosis = "host-process-dead";
    });

    const failure = await runUpdate({}).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
      details: { diagnosis: "install-record-absent" },
    });
  });
});

describe("verifyBudgetFor (Q6)", () => {
  // Pure, so the BUDGET CHOICE is pinned without a wall clock. The behaviour
  // it encodes cannot otherwise be tested cheaply: proving the shortening
  // through `runHostUpdate` would mean actually waiting out a budget.
  it("leaves the ordinary budget alone", () => {
    expect(verifyBudgetFor(null, null)).toBe(45_000);
  });

  it("shortens the wait when the START itself errored", () => {
    const shortened = verifyBudgetFor("E_SERVICE_CONTROL_FAILED", null);
    // Actually shortened - the whole point of the change.
    expect(shortened).toBeLessThan(45_000);
    // Not zero, and not merely non-zero: it must OUTLAST launchd's respawn
    // throttle. `KeepAlive{SuccessfulExit:false}` is one of the two worlds in
    // which a refused start still yields a healthy host, and launchd will not
    // relaunch before `ThrottleInterval` elapses - so a budget at or below it
    // would expire at the exact moment the host first becomes possible, and
    // report a failure against the slowest LEGITIMATE recovery. Cold review
    // found this: the first cut was 10 s against a 10 s throttle.
    expect(shortened).toBeGreaterThan(
      LAUNCHD_THROTTLE_INTERVAL_SECONDS * 1_000,
    );
  });

  it("treats a caller override as a CEILING, not a replacement", () => {
    // Both directions matter. A suite pinning a LONG budget must not thereby
    // re-acquire the 45 s wait this exists to cut...
    expect(verifyBudgetFor("E_SERVICE_CONTROL_FAILED", 60_000)).toBe(
      verifyBudgetFor("E_SERVICE_CONTROL_FAILED", null),
    );
    // ...and a suite pinning a SHORT one must keep it, or every existing
    // fast-budget test silently starts waiting ten seconds.
    expect(verifyBudgetFor("E_SERVICE_CONTROL_FAILED", 50)).toBe(50);
    // With no start error the override is simply authoritative.
    expect(verifyBudgetFor(null, 60_000)).toBe(60_000);
  });
});
