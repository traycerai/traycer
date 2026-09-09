/**
 * Whether the host that writes this machine's chat stores is PROVABLY not
 * running, asked immediately before a swap.
 *
 * ## Why the store-format floor needs this
 *
 * The floor's guarantee is "every store on disk is readable by the build about
 * to land". A survey can only establish that for the instant it ran, so the
 * guarantee holds at the swap only if nothing could have written in between.
 * The pre-stop survey plus a live host is not that: a chat opened during the
 * window migrates a store forward, and the older host lands over it anyway.
 *
 * ## Why it observes the PROCESS rather than the stop
 *
 * The obvious source is the stop's own outcome, and it is the wrong one. The
 * stop is reached through four platform routes with different evidence, one of
 * them (`createBytesOnlyInstallLifecycle` on POSIX) performs no stop at all,
 * and the Desktop-managed macOS route deliberately DEGRADES - it catches a
 * `hung` outcome, which is precisely "the pid was observed still alive after
 * the full grace", and proceeds. A flag threaded out of any of those says what
 * the stop attempted; this asks what is true.
 *
 * {@link publishedHostProcessGone} is positive evidence by construction: `false`
 * means "not proven gone", never "proven alive". So every way of not knowing -
 * an unreadable record, a probe that could not answer, a pid whose creation
 * stamp cannot be read back - lands on NOT ESTABLISHED, and the floor refuses
 * rather than assuming.
 *
 * ## The one arm that looks permissive and is not
 *
 * `absent` does not by itself refuse. A host publishes `pid.json` when it
 * starts and the whole CLI reads that file as the host's identity -
 * `assertHostNotBusy` and the cooperative shutdown both treat its absence as
 * "no host". Nothing has claimed to be running, so refusing there would refuse
 * every install onto a machine that has never run a host.
 *
 * ## "Not running" is not "cannot start"
 *
 * Both arms that would otherwise clear - an absent record, and a record whose
 * process is provably gone - then ask one more question, because the pid is a
 * SNAPSHOT and the swap takes time. A launchd job inside
 * `KeepAlive{SuccessfulExit:false}`'s throttle window, or a systemd unit in
 * `Restart=on-failure`'s relaunch window, has no process right now and is
 * about to have one; `statusService` reports both as `stopped` (it reads
 * `pid.json` too), so the lifecycle never stopped them either. That is the
 * epic's headline shape - a 1.2.0 host crash-looping on v9 data while an
 * install lands underneath it - and it is the one case where every earlier
 * signal says "quiet".
 *
 * A deliberate stop is not refused by this, but it is WAITED OUT rather than
 * exempted. The supervisor outlives its child by the whole post-mortem, so
 * for a few seconds after a clean stop the manager still shows a live job -
 * indistinguishable, from here, from a supervisor between children. Neither
 * manager respawns a clean exit, so the deliberate stop SETTLES on its own:
 * the job pid goes away and the last exit reads clean. The check polls for
 * that, bounded, and refuses only a manager that never settles. An earlier
 * shape waved a live supervisor through on the strength of this install's
 * own stop plus its stop-intent marker; that could not tell the supervisor
 * that owned the stopped host from a second one (a dual CLI + Desktop
 * registration whose other child was still booting, unpublished), and the
 * exemption cleared both.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  publishedHostProcessGone,
  readHostPidMetadataEvidenceAt,
} from "./pid-metadata";
import {
  isChatStoreRootNotFound,
  type ChatStoreSurveyRoots,
} from "./chat-store-survey-roots";
import {
  serviceLabelMayRespawn,
  serviceManagerMayRespawn,
  type ServiceLabel,
} from "../service";
import { devServiceLabelForSlot, serviceLabelFor } from "../service/label";
import {
  hostHolderProcessGone,
  hostHolderRecordPathIn,
  readHostHolderEvidenceAt,
} from "./holder-record";
import type { ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import {
  hostDevHomeDir,
  hostDevRunsRoot,
  hostPidMetadataPath,
  hostPidMetadataPathIn,
} from "../store/paths";

/**
 * Why the writer could not be shown to be gone. Rendered into the refusal, so
 * each arm has to be something an operator can act on.
 */
export type SwapQuiescenceGap =
  /** `pid.json` names a process that is still running, or may be. */
  | "writer-still-running"
  /** `pid.json` exists but could not be read, so nothing can be concluded. */
  | "writer-unknown"
  /**
   * The survey covers a data root whose writers this process could not
   * enumerate - or could not list the roots at all.
   *
   * `pid.json` is SLOT-scoped while the chat stores are IDENTITY-scoped (see
   * the host's `paths.ts`: the slot home holds "pid.json, logs, crash
   * reports", the identity home holds the chat/epic stores). A pooled
   * identity home therefore carries no pid record at all; the host that
   * acquired it publishes its pid in the run slot it was started in -
   * `host/dev-runs/<slot>`, or the unslotted `host/dev` home. So a survey
   * that spans more than one root reads EVERY slot's record
   * (`resolveWriterEvidenceSources`), and this is the answer when that walk could
   * not be completed: the survey's own roots could not be listed, `dev-runs`
   * could not be read, or an entry under it is a symlink (followed, it could
   * point at a tree that is not a slot; ignored, it could hide one that is).
   */
  | "unseen-writers"
  /**
   * No host is running RIGHT NOW, but a service manager has the job loaded
   * after a crash and is about to restart it.
   *
   * `statusService` reports a CLI-owned label purely from `pid.json` on both
   * darwin and linux, so a launchd job inside `KeepAlive{SuccessfulExit:
   * false}`'s throttle window - or a systemd unit in `Restart=on-failure`'s
   * relaunch window - reads `stopped`, the lifecycle skips stopping it, and
   * the pid probe below then finds nothing and calls it quiescent. That is
   * precisely the epic's headline shape: a 1.2.0 host crash-looping on v9
   * data while an install lands underneath it.
   *
   * A DELIBERATE stop is not this, and it is not exempted from it either: it
   * is waited out. Neither manager respawns a clean exit, so the supervisor
   * winding down from the stop this install just performed settles within
   * its post-mortem, and only a job that is still loaded with a live pid or
   * an unclean last exit once {@link SERVICE_SETTLE_TIMEOUT_MS} has passed
   * answers this way.
   */
  | "service-may-respawn";

export type SwapQuiescence =
  | { readonly established: true }
  | { readonly established: false; readonly reason: SwapQuiescenceGap };

const QUIESCED: SwapQuiescence = { established: true };

/**
 * Observe whether the published host process is provably gone.
 *
 * Called AFTER the lifecycle's stop and immediately before the swap, so a
 * cooperative shutdown that actually worked reads as established here whatever
 * route performed it - which is what keeps the GUI's "Install anyway" path on
 * Desktop-managed macOS working, since that route really does wait for the pid
 * to exit before returning.
 *
 * Can take up to {@link SERVICE_SETTLE_TIMEOUT_MS} when the service manager
 * still holds a live job after the stop - which is why the caller asks it
 * LAZILY, only for a move that applicability and formats could not settle.
 */
export async function observeSwapQuiescence(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
  logger: ILogger,
): Promise<SwapQuiescence> {
  const writers = await resolveWriterEvidenceSources(environment, surveyRoots);
  if (writers.kind === "unenumerable") {
    return unseenWriters(environment, surveyRoots, writers.cause, logger);
  }
  const processGap = await publishedHostProcessState(
    environment,
    writers,
    logger,
  );
  if (processGap !== null) return processGap;
  return await quiescenceOnceServiceSettles(
    environment,
    surveyRoots,
    writers,
    logger,
  );
}

/**
 * Everything that could speak for a writer of the surveyed roots.
 *
 * Three kinds, because no one of them is complete on its own:
 *
 * - `pidPaths` - the SLOT-scoped `pid.json` of every host home this process
 *   can name. Answers "is a published host running there".
 * - `holderPaths` - each SURVEYED root's own `holder.json`. Answers "does
 *   anyone hold THIS data root" for a host this process cannot otherwise
 *   name: the record sits in the data being protected rather than in the
 *   launcher's home, and a pooled identity home never gets a `pid.json` at
 *   all. Read in ONE direction only - see below.
 * - `serviceLabels` - the job of every enumerated slot. A manager that can
 *   START a writer disqualifies the swap exactly as a running writer does,
 *   and reading only this process's label was the hole that made the widened
 *   walk unsound.
 *
 * ## What the holder record is NOT
 *
 * It is not proof that a root has no writer, and this walk must never be read
 * as if it were. The host writes it best-effort on acquire and SWALLOWS a
 * failed write (`layer0-lock.ts`'s `writeHolderRecord`), where it is called
 * "a diagnostic only - it never gates anything". So a live host whose holder
 * write failed - an unwritable `holder.json` in a writable root - leaves the
 * dead predecessor's record in place, and a host started with an arbitrary
 * `--host-data-dir` outside `dev-runs` publishes its `pid.json` somewhere
 * this process never enumerates.
 *
 * A present, live holder therefore REFUSES, and an absent or dead one clears
 * nothing by itself - it only declines to add a refusal the other two sources
 * may still supply. That asymmetry is the whole contract: this walk detects
 * strictly more writers than the pid-only walk it replaced, and it closes no
 * hole on its own. Closing the remaining one needs positive lock evidence
 * (taking the Layer 0 lock, which needs the host's native addon the CLI does
 * not carry), not a better reading of a diagnostic.
 */
interface WriterEvidenceRecords {
  readonly kind: "records";
  readonly pidPaths: readonly string[];
  readonly holderPaths: readonly string[];
  /**
   * The labels BESIDES this environment's own, which is probed through
   * `serviceManagerMayRespawn` - the seam every caller and suite already
   * knows. Empty on every shipped path, so production probes exactly what
   * it always did.
   */
  readonly extraServiceLabels: readonly ServiceLabel[];
}

/**
 * The resolution, which either names every source or admits it cannot. Named
 * apart from the records themselves because the settle loop carries ONE round's
 * records forward to compare the next resolution against.
 */
type WriterEvidenceSources =
  | WriterEvidenceRecords
  | { readonly kind: "unenumerable"; readonly cause: string };

/**
 * Every source that could speak for a writer of the surveyed roots.
 *
 * ONE root is the shipped path: that root's own pid record, its own holder
 * record, and this environment's service label - production and staging never
 * union roots, so nothing below changes for them.
 *
 * MORE than one is the dev survey's union (the run slot's home, the unslotted
 * dev home, the identity pool), and answering it needs all three source kinds
 * because each is blind where another sees:
 *
 * - `pid.json` is SLOT-scoped, published once a hostId is known into the home
 *   the host STARTED in. It names published hosts in homes this process can
 *   enumerate, and says nothing about a pooled identity home.
 * - `holder.json` sits in the DATA ROOT itself, written the moment the Layer 0
 *   lock is won. It is what makes this walk less convention-bound: a host may
 *   be started with any `--host-data-dir` beneath `~/.traycer/host` and can
 *   then acquire a pooled identity, so no enumeration of HOMES is exhaustive -
 *   but the holder record of a root is written by whoever took that root,
 *   wherever they came from. Best-effort, so it can only ADD a refusal (see
 *   the source type above).
 * - the SERVICE LABEL of each enumerated slot, because a loaded job with no
 *   live child is precisely the writer the settle wait exists to catch, and
 *   reading only this process's label left every sibling slot unprobed.
 *
 * Resolved on EVERY round rather than once per swap - before the first probe,
 * again after every settle sleep, and once more before clearing: a slot can
 * appear while the service manager is being waited on, and both the reads AND
 * the probes after that wait have to see it. A resolution that names a source
 * the round's probes did not cover cannot clear (`sourcesAppearedSince`).
 * A `dev-runs` that does not exist is the ordinary single-desktop
 * machine and yields no slots; one that cannot be read, or that holds a
 * symlink, is a walk this process cannot complete and answers `unseen-writers`
 * - the same rule the identity pool's own enumeration follows, for the same
 * two-directional reason (a followed link could point outside the slots, an
 * ignored one could hide a slot).
 */
async function resolveWriterEvidenceSources(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
): Promise<WriterEvidenceSources> {
  if (surveyRoots.enumerationFailed) {
    return {
      kind: "unenumerable",
      cause: "the survey could not enumerate its roots",
    };
  }
  const own = hostPidMetadataPath(environment);
  const ownLabel = serviceLabelFor(environment);
  if (surveyRoots.roots.length <= 1) {
    // The SHIPPED path, unchanged: one root is this environment's own host
    // home, so `pid.json` sits inside it and its holder record would say
    // nothing the pid record does not. Reading one anyway would put a new
    // filesystem read on every production install for no information.
    return {
      kind: "records",
      pidPaths: [own],
      holderPaths: [],
      extraServiceLabels: [],
    };
  }
  if (environment !== "dev") {
    // Only the dev survey unions roots (`resolveChatStoreSurveyRoots`). A
    // multi-root survey under any other environment is outside this module's
    // model of who writes what, and a model it does not have refuses rather
    // than guesses.
    return {
      kind: "unenumerable",
      cause: `a ${environment} survey spans ${surveyRoots.roots.length} roots`,
    };
  }
  const paths = new Set<string>([own, hostPidMetadataPathIn(hostDevHomeDir())]);
  // Every SURVEYED root's HOLDER record. This is the half that does not depend
  // on the `dev-runs` convention being an exhaustive list of homes - it is not,
  // and cannot be made one.
  const holderPaths = new Set<string>(
    surveyRoots.roots.map((root) => hostHolderRecordPathIn(root.path)),
  );
  // The unslotted dev home's label always exists beside this process's own;
  // `dev-runs` adds one per slot below. This process's own is excluded - it
  // goes through `serviceManagerMayRespawn`.
  const unslotted = devServiceLabelForSlot(null);
  const labels = new Map<string, ServiceLabel>(
    unslotted.id === ownLabel.id ? [] : [[unslotted.id, unslotted]],
  );
  const runsRoot = hostDevRunsRoot();
  let slots: Dirent[];
  try {
    slots = await readdir(runsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    // Absent is the ordinary single-desktop machine: no slots, nothing to be
    // blind to. `isChatStoreRootNotFound` rather than a fifth private errno
    // helper - the survey's root resolver next door already owns this test.
    if (isChatStoreRootNotFound(error)) {
      return collectedSources(paths, holderPaths, labels);
    }
    return { kind: "unenumerable", cause: `${runsRoot} could not be read` };
  }
  for (const slot of slots) {
    if (slot.isSymbolicLink()) {
      return {
        kind: "unenumerable",
        cause: `${join(runsRoot, slot.name)} is a symlink`,
      };
    }
    if (!slot.isDirectory()) continue;
    const slotHome = join(runsRoot, slot.name);
    paths.add(hostPidMetadataPathIn(slotHome));
    // The slot's own holder record too: a host started INTO a run slot takes
    // that home's lock, and a slot whose host never reached the point of
    // publishing a pid is exactly the writer this walk must not miss.
    holderPaths.add(hostHolderRecordPathIn(slotHome));
    const label = devServiceLabelForSlot(slot.name);
    if (label.id !== ownLabel.id) labels.set(label.id, label);
  }
  return collectedSources(paths, holderPaths, labels);
}

function collectedSources(
  pidPaths: ReadonlySet<string>,
  holderPaths: ReadonlySet<string>,
  labels: ReadonlyMap<string, ServiceLabel>,
): WriterEvidenceSources {
  return {
    kind: "records",
    // Sorted so a refusal's log lists the sources in one stable order.
    pidPaths: [...pidPaths].sort(),
    holderPaths: [...holderPaths].sort(),
    extraServiceLabels: [...labels.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}

function unseenWriters(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
  cause: string,
  logger: ILogger,
): SwapQuiescence {
  logger.info(
    "Host store-format floor cannot establish quiescence: this process cannot account for every host data root on this machine",
    {
      environment,
      surveyedRoots: surveyRoots.roots.length,
      enumerationFailed: surveyRoots.enumerationFailed,
      cause,
    },
  );
  return { established: false, reason: "unseen-writers" };
}

/**
 * The pid-record half of the question: `null` when no published host process
 * stands in the way (no record, or a record whose process is provably gone),
 * else the gap that does. Asked twice - before the service manager is
 * consulted, and again after a wait for it to settle, since a host can
 * publish while this process is waiting. Every record is read, and the first
 * one that cannot be cleared answers for the whole set: one live writer is
 * enough to refuse, whichever slot it is in.
 */
async function publishedHostProcessState(
  environment: Environment,
  sources: WriterEvidenceRecords,
  logger: ILogger,
): Promise<SwapQuiescence | null> {
  for (const path of sources.pidPaths) {
    const evidence = await readHostPidMetadataEvidenceAt(path, environment);
    if (evidence.kind === "absent") continue;
    if (evidence.kind === "unreadable") {
      logger.warn(
        "Host pid metadata could not be read, so the swap cannot be shown to be quiescent",
        { environment, path, cause: evidence.cause },
      );
      return { established: false, reason: "writer-unknown" };
    }
    if (!publishedHostProcessGone(evidence.metadata)) {
      return { established: false, reason: "writer-still-running" };
    }
  }
  // The holder records answer for roots whose writer publishes no pid HERE -
  // a pooled identity home never gets one, and a host started with a
  // hand-passed `--host-data-dir` publishes into a home this process may never
  // enumerate. Same liveness rule, so the two kinds cannot disagree.
  for (const path of sources.holderPaths) {
    const evidence = await readHostHolderEvidenceAt(path, environment);
    if (evidence.kind === "absent") continue;
    if (evidence.kind === "unreadable") {
      logger.warn(
        "Host holder record could not be read, so the swap cannot be shown to be quiescent",
        { environment, path, cause: evidence.cause },
      );
      return { established: false, reason: "writer-unknown" };
    }
    if (!hostHolderProcessGone(evidence.holder)) {
      return { established: false, reason: "writer-still-running" };
    }
  }
  return null;
}

/**
 * How long the service manager is given to settle after the stop before its
 * live job is read as one that may respawn.
 *
 * Sized against the supervisor's own post-mortem, which is what keeps a
 * launchd job "running" after a clean stop: the stderr end wait, the tee
 * flush and, on a fatal signal, the crash-report scan - each bounded at a few
 * seconds in `host/crash-diagnostics.ts`, well inside this. A supervisor
 * BETWEEN children (the crash loop this check exists for) never settles: it
 * sits in its relaunch backoff with a live pid, or launchd holds the job with
 * an unclean last exit through its throttle window. A second supervisor whose
 * child is still booting does not settle either. Both spend the whole window
 * and are refused. The window is host downtime, paid only by a move that
 * neither applicability nor formats could settle.
 *
 * The budget is MONOTONIC and covers everything: it starts before the first
 * probe, every probe's subprocess timeout is capped by what remains, and so
 * is every sleep. A wall clock corrected during the wait therefore neither
 * cuts it short nor stretches it, and a `launchctl` that hangs to its own
 * timeout cannot push the wait past the bound - it runs out of budget and
 * answers "unproven", which refuses.
 */
export const SERVICE_SETTLE_TIMEOUT_MS = 15_000;
const SERVICE_SETTLE_POLL_MS = 500;
/** The most any single `launchctl print` / `systemctl` call may take. */
const SERVICE_PROBE_TIMEOUT_MS = 10_000;

/**
 * No process is running - but "running" is not the same question as "cannot
 * start". Asked LAST, only once the pid evidence would otherwise clear, so the
 * ordinary machine pays a probe and only on a downgrade.
 *
 * The manager is polled until it no longer holds a job that could start a
 * host, or the window runs out. The ordinary running-host downgrade takes the
 * first road: `beforeSwap` stops the host child, the clean stop purges
 * `pid.json`, and `stopService` returns while launchd still considers the job
 * running - the supervisor outlives its child by the whole post-mortem
 * (`relaunchServiceAfterRestart`'s own rationale) - and a few polls later the
 * job has no pid and a clean last exit, which neither manager respawns.
 *
 * Deliberately NOT an exemption keyed on this install's own stop. The manager
 * answers for every loaded label at once (the CLI's and Desktop's), and a
 * stop of the published host says nothing about a second supervisor whose
 * child is still booting, unpublished: that one keeps its live pid, never
 * settles here, and is refused - which an exemption for "the stop we just
 * performed" would have waved through along with the supervisor it meant.
 *
 * Once the manager has settled after a wait, the pid record is read again: a
 * host started outside any manager during the window would have published by
 * now, and the first read predates it.
 */
async function quiescenceOnceServiceSettles(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
  initialWriters: WriterEvidenceRecords,
  logger: ILogger,
): Promise<SwapQuiescence> {
  const startedAt = performance.now();
  const remainingMs = (): number =>
    SERVICE_SETTLE_TIMEOUT_MS - (performance.now() - startedAt);
  let waited = false;
  // The sources THIS round probes. Re-resolved after every sleep rather than
  // captured once for the wait: a run slot can be created while the manager is
  // being waited on, and its job can start a writer exactly as a sibling
  // slot's can. Holding the label set fixed for the whole window would reopen
  // along the TIME axis the hole the widened walk closed along the slot axis.
  let writers = initialWriters;
  // Labels ACCUMULATE across rounds; records do not. The asymmetry is the
  // difference between what the two are made of. A record path is a claim
  // about a directory, so when the directory goes the claim goes with it. A
  // service label names a job in the OS's service manager, and removing a slot
  // directory neither unloads that job nor kills the child it already spawned:
  // dev cleanup that deletes `dev-runs/<slot>` while its host is still booting
  // takes the label out of the next enumeration while the writer it can start
  // is still very much alive. So once a label has been seen in this
  // observation it stays until a PROBE clears it - which costs nothing when
  // the job really is gone, since an unloaded label answers "will not
  // respawn" and the set settles on the next round.
  const labels = new Map<string, ServiceLabel>(
    initialWriters.extraServiceLabels.map((label) => [label.id, label]),
  );
  for (;;) {
    const budget = Math.max(
      1,
      Math.min(SERVICE_PROBE_TIMEOUT_MS, Math.ceil(remainingMs())),
    );
    // EVERY label seen so far, CONCURRENT, and one budget for the set rather
    // than one each: the deadline is shared, so probing N labels in sequence
    // would let a slow manager eat the whole window before the next label is
    // asked at all. Any job that could start a writer keeps the whole set
    // unsettled.
    const probedLabels = [...labels.values()];
    const answers = await Promise.all([
      // This environment's own label through the established seam, so every
      // caller and suite that stubs `serviceManagerMayRespawn` keeps working
      // and the shipped single-label path stays byte-identical to before.
      serviceManagerMayRespawn(environment, budget),
      ...probedLabels.map((label) => serviceLabelMayRespawn(label, budget)),
    ]);
    if (!answers.some((mayRespawn) => mayRespawn)) {
      // Re-read the writers before clearing. The probes above are asynchronous
      // and take real time, so a host that published during them is invisible
      // to the reads that preceded them - the same race the post-wait re-read
      // closes, which the first probe's early return used to skip entirely.
      return await quiescenceOnceWritersRechecked(
        environment,
        surveyRoots,
        { records: writers, probedLabelIds: [...labels.keys()] },
        logger,
      );
    }
    if (!waited) {
      waited = true;
      logger.debug(
        "Host store-format floor: the service manager still holds a host job after the stop; waiting for it to settle",
        { environment, timeoutMs: SERVICE_SETTLE_TIMEOUT_MS },
      );
    }
    const remaining = remainingMs();
    if (remaining <= 0) {
      logger.info(
        "Host store-format floor cannot establish quiescence: no host is running, but the service manager still holds a host job that can start one",
        {
          environment,
          waitedMs: Math.round(performance.now() - startedAt),
        },
      );
      return { established: false, reason: "service-may-respawn" };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(SERVICE_SETTLE_POLL_MS, remaining));
    });
    const next = await resolveWriterEvidenceSources(environment, surveyRoots);
    if (next.kind === "unenumerable") {
      return unseenWriters(environment, surveyRoots, next.cause, logger);
    }
    writers = next;
    for (const label of next.extraServiceLabels) labels.set(label.id, label);
  }
}

/**
 * Re-resolve the writers and clear only if none of them stands in the way.
 *
 * Re-resolved rather than reused: the probes are subprocess calls that take
 * real time, so a slot that appeared - or a host that published - while they
 * ran is invisible to the reads that preceded them.
 *
 * Which is exactly why a re-resolution that names a source the round did NOT
 * probe cannot be read as clearance. Its RECORDS are read here, but the job
 * that could start its writer never was, and a loaded job with no live child
 * is precisely the writer this whole wait exists to catch. Answering
 * `unseen-writers` says the true thing - this process could not get one stable
 * picture of the machine - and costs a retry on a dev box where a run slot
 * appeared during the swap's own settle window.
 */
async function quiescenceOnceWritersRechecked(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
  probed: ProbedSources,
  logger: ILogger,
): Promise<SwapQuiescence> {
  const writers = await resolveWriterEvidenceSources(environment, surveyRoots);
  if (writers.kind === "unenumerable") {
    return unseenWriters(environment, surveyRoots, writers.cause, logger);
  }
  const appeared = sourcesAppearedSince(probed, writers);
  if (appeared.length > 0) {
    return unseenWriters(
      environment,
      surveyRoots,
      `a host record or service job appeared while the service manager was probed (${appeared.length})`,
      logger,
    );
  }
  const processGap = await publishedHostProcessState(
    environment,
    writers,
    logger,
  );
  return processGap ?? QUIESCED;
}

/** What the round actually asked about, which is what clearance is measured against. */
interface ProbedSources {
  /** The records this round read. */
  readonly records: WriterEvidenceRecords;
  /**
   * Every label probed in this observation, which OUTLIVES the resolution it
   * came from - see the settle loop for why a label may not be forgotten when
   * its slot directory is.
   */
  readonly probedLabelIds: readonly string[];
}

/**
 * The sources the re-resolution names that the round did not cover.
 *
 * Growth is the only direction that matters for RECORDS. A record path that
 * disappeared named a directory that is gone, so it takes a possible writer
 * off the board and can never make a cleared swap unsafe - hence a subset test
 * rather than an equality one, and a root torn down during a swap is not
 * turned into a refusal.
 *
 * Labels are not symmetric with that, which is why they are compared against
 * everything probed in this observation rather than against the last
 * resolution: a job survives the deletion of the directory that named it, so
 * "no longer enumerated" is not "no longer able to start a writer". The settle
 * loop keeps probing such a label until the manager itself says otherwise.
 */
function sourcesAppearedSince(
  probed: ProbedSources,
  resolved: WriterEvidenceRecords,
): readonly string[] {
  const covered = new Set<string>([
    ...probed.records.pidPaths,
    ...probed.records.holderPaths,
    ...probed.probedLabelIds,
  ]);
  return [
    ...resolved.pidPaths,
    ...resolved.holderPaths,
    ...resolved.extraServiceLabels.map((label) => label.id),
  ].filter((source) => !covered.has(source));
}

/** The gap, as a sentence fragment for the refusal. */
export function describeQuiescenceGap(reason: SwapQuiescenceGap): string {
  if (reason === "writer-still-running") {
    return "the host that writes them is still running, so it can stamp a store after this check and before the swap";
  }
  if (reason === "service-may-respawn") {
    return "no host is running, but the service manager still held a host job that can start one after waiting for it to settle - a recent crash, or a host that was still starting when the stop ran - so it can stamp a store before the swap lands; retry once it has settled";
  }
  if (reason === "unseen-writers") {
    return "this CLI could not account for every host that can write them on this machine - a data root or a dev run slot could not be listed, or the roots span more machines' worth of state than this process has a model for - so another host could still be writing them";
  }
  return "this CLI could not read the host's pid record, so it cannot tell whether a host is still writing them";
}
