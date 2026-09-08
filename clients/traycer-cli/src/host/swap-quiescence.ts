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
 * `absent` is ESTABLISHED. A host publishes `pid.json` when it starts and the
 * whole CLI reads that file as the host's identity - `assertHostNotBusy` and
 * the cooperative shutdown both treat its absence as "no host". Nothing has
 * claimed to be running, so there is no writer to quiesce, and refusing there
 * would refuse every install onto a machine that has never run a host.
 */
import {
  publishedHostProcessGone,
  readHostPidMetadataEvidence,
} from "./pid-metadata";
import type { ChatStoreSurveyRoots } from "./chat-store-survey-roots";
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
   * The survey spans a data root this process cannot see the writer of.
   *
   * `pid.json` is SLOT-scoped while the chat stores are IDENTITY-scoped (see
   * the host's `paths.ts`: the slot home holds "pid.json, logs, crash
   * reports", the identity home holds the chat/epic stores). A pooled
   * identity home therefore carries no pid record at all, and the host that
   * acquired it publishes its pid in ITS OWN slot - which this process cannot
   * enumerate. So a second dev slot can be live and migrating one of the very
   * stores the survey just read.
   */
  | "unseen-writers";

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
 */
export async function observeSwapQuiescence(
  environment: Environment,
  surveyRoots: ChatStoreSurveyRoots,
  logger: ILogger,
): Promise<SwapQuiescence> {
  // The pid record this process can read belongs to ONE root - the host home
  // it was handed. Every additional root the survey covers is a store whose
  // writer lives somewhere this process cannot look, so its silence proves
  // nothing. Production always resolves exactly one root, so the shipped path
  // is untouched; only a dev machine with a slot or an identity pool has more.
  if (surveyRoots.roots.length > 1) {
    logger.info(
      "Host store-format floor cannot establish quiescence: the survey spans data roots whose writers this process cannot see",
      { environment, surveyedRoots: surveyRoots.roots.length },
    );
    return { established: false, reason: "unseen-writers" };
  }
  const evidence = await readHostPidMetadataEvidence(environment);
  if (evidence.kind === "absent") return QUIESCED;
  if (evidence.kind === "unreadable") {
    logger.warn(
      "Host pid metadata could not be read, so the swap cannot be shown to be quiescent",
      { environment, cause: evidence.cause },
    );
    return { established: false, reason: "writer-unknown" };
  }
  if (publishedHostProcessGone(evidence.metadata)) return QUIESCED;
  return { established: false, reason: "writer-still-running" };
}

/** The gap, as a sentence fragment for the refusal. */
export function describeQuiescenceGap(reason: SwapQuiescenceGap): string {
  if (reason === "writer-still-running") {
    return "the host that writes them is still running, so it can stamp a store after this check and before the swap";
  }
  if (reason === "unseen-writers") {
    return "they span more than one host data root on this machine and only one publishes a process record here, so another host could still be writing them";
  }
  return "this CLI could not read the host's pid record, so it cannot tell whether a host is still writing them";
}
