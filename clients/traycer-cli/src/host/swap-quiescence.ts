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
import {
  publishedHostProcessGone,
  readHostPidMetadataEvidence,
} from "./pid-metadata";
import type { ChatStoreSurveyRoots } from "./chat-store-survey-roots";
import { serviceManagerMayRespawn } from "../service";
import type { ILogger } from "../logger";
import type { Environment } from "../runner/environment";

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
   * The survey covers a data root this process cannot see the writer of - or
   * could not list the roots at all.
   *
   * `pid.json` is SLOT-scoped while the chat stores are IDENTITY-scoped (see
   * the host's `paths.ts`: the slot home holds "pid.json, logs, crash
   * reports", the identity home holds the chat/epic stores). A pooled
   * identity home therefore carries no pid record at all, and the host that
   * acquired it publishes its pid in ITS OWN slot - which this process cannot
   * enumerate. So a second dev slot can be live and migrating one of the very
   * stores the survey just read.
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
  // The pid record this process can read belongs to ONE root - the host home
  // it was handed. Two shapes put a store beyond that record, and both mean
  // the same thing here:
  //
  //   - MORE ROOTS than the one whose writer we can see. Every extra root is
  //     a store whose writer lives somewhere this process cannot look, so its
  //     silence proves nothing.
  //   - A root set that could not be fully ENUMERATED. Then the count itself
  //     is unreliable and there may be a root - hence a writer - we never
  //     listed at all.
  //
  // The survey turns `enumerationFailed` into its own `*` failure and would
  // refuse on that anyway, so this arm changes no outcome today. It is here
  // because quiescence is asked as its own question and must answer honestly
  // on its own: "I could not enumerate the roots" is not evidence that
  // nothing is writing them.
  //
  // Production always resolves exactly one root and never fails to enumerate,
  // so the shipped path is untouched.
  if (surveyRoots.enumerationFailed || surveyRoots.roots.length > 1) {
    logger.info(
      "Host store-format floor cannot establish quiescence: this process cannot account for every host data root on this machine",
      {
        environment,
        surveyedRoots: surveyRoots.roots.length,
        enumerationFailed: surveyRoots.enumerationFailed,
      },
    );
    return { established: false, reason: "unseen-writers" };
  }
  const processGap = await publishedHostProcessState(environment, logger);
  if (processGap !== null) return processGap;
  return await quiescenceOnceServiceSettles(environment, logger);
}

/**
 * The pid-record half of the question: `null` when no published host process
 * stands in the way (no record, or a record whose process is provably gone),
 * else the gap that does. Asked twice - before the service manager is
 * consulted, and again after a wait for it to settle, since a host can
 * publish while this process is waiting.
 */
async function publishedHostProcessState(
  environment: Environment,
  logger: ILogger,
): Promise<SwapQuiescence | null> {
  const evidence = await readHostPidMetadataEvidence(environment);
  if (evidence.kind === "absent") return null;
  if (evidence.kind === "unreadable") {
    logger.warn(
      "Host pid metadata could not be read, so the swap cannot be shown to be quiescent",
      { environment, cause: evidence.cause },
    );
    return { established: false, reason: "writer-unknown" };
  }
  if (!publishedHostProcessGone(evidence.metadata)) {
    return { established: false, reason: "writer-still-running" };
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
  logger: ILogger,
): Promise<SwapQuiescence> {
  const startedAt = performance.now();
  const remainingMs = (): number =>
    SERVICE_SETTLE_TIMEOUT_MS - (performance.now() - startedAt);
  const probe = (): Promise<boolean> =>
    serviceManagerMayRespawn(
      environment,
      Math.max(1, Math.min(SERVICE_PROBE_TIMEOUT_MS, Math.ceil(remainingMs()))),
    );
  let mayRespawn = await probe();
  if (!mayRespawn) return QUIESCED;
  logger.debug(
    "Host store-format floor: the service manager still holds a host job after the stop; waiting for it to settle",
    { environment, timeoutMs: SERVICE_SETTLE_TIMEOUT_MS },
  );
  while (mayRespawn) {
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
    mayRespawn = await probe();
  }
  const processGap = await publishedHostProcessState(environment, logger);
  return processGap ?? QUIESCED;
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
    return "this CLI cannot account for every host data root on this machine - only one of them publishes a process record here - so another host could still be writing them";
  }
  return "this CLI could not read the host's pid record, so it cannot tell whether a host is still writing them";
}
