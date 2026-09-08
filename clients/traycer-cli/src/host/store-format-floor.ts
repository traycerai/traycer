/**
 * The store-format FLOOR GATE: the one refusal every CLI path that can land
 * OLDER host bytes runs before it downloads, stops or swaps anything.
 *
 * ## Why a gate at all
 *
 * A host data directory is shared by every build that runs on it, and the
 * per-epic chat store (`<hostHome>/epic-state/<epicId>/chat/chat.db`) carries
 * a forward-only stamp. Host 1.2.0 speaks chat-store format 8; 1.3.0-rc.1 and
 * later write 9, and a build refuses a file stamped newer than it speaks. What
 * a user sees after installing 1.2.0 over a 1.3 data directory is not a
 * version choice, it is data loss with a crash loop on top: the refusal is
 * swallowed into "chat registry has not been hydrated", escapes as an
 * unhandled rejection, and 1.2.0's strict Sentry integration exits the
 * process. 1.2.0 is shipped and cannot be fixed, so the only honest place to
 * say no is HERE, in the actor about to place the bytes.
 *
 * ## The three answers, and why two of them refuse
 *
 * `decideStoreFormatFloor` (`@traycer/protocol/host/store-formats`) is
 * three-valued - `clear` / `blocked` / `indeterminate` - and this gate refuses
 * on both of the latter. An unreadable store is not evidence that it is
 * readable, and a target whose format nothing can name is not evidence that
 * its format is high enough. Everything about this module fails closed; the
 * ONE way past it is `--accept-store-format-loss`, which is explicit, named
 * after the loss it accepts, and never implied by anything else.
 *
 * In particular `--force` does NOT bypass it. `--force` means "replace a host
 * that has work in progress" - it skips the busy probe, which protects live
 * work that the user can decide to discard. The floor protects data the user
 * cannot get back by waiting, and conflating the two would put the escape
 * hatch behind the flag people already reach for when a host misbehaves -
 * which, for this failure, is precisely the symptom.
 *
 * ## What it costs
 *
 * Nothing on the paths that are not downgrades. `storeFloorApplicability` sends
 * every upgrade and same-version reinstall straight out, and
 * `storeFloorClearedByFormats` clears an rc→rc rollback from two table lookups
 * with no disk access at all. Only a move that actually crosses a store-format
 * boundary walks the epics: one read-only open and one row each, measured at
 * 7.9 ms over 22 epics / 144 MB, against a command that is about to transfer a
 * host bundle.
 */
import {
  decideStoreFormatFloor,
  resolveHostStoreFormats,
  storeFloorApplicability,
  storeFloorClearedByFormats,
  type ChatDbStampFailure,
  type ChatDbStampFailureReason,
  type ChatDbStampReading,
  type HostStoreFormats,
  type HostStoreFormatsKnowledge,
  type StoreFormatFloorVerdict,
} from "@traycer/protocol/host/store-formats";
import type { ILogger, LogValue } from "../logger";
import { errorFromUnknown } from "../logger";
import { readHostInstallRecord } from "../manifest/host-install";
import { parseHostVersionsManifestWithWarnings } from "../registry/manifest-schema";
import { resolveManifestUrl } from "../registry/manifest-url";
import { fetchText } from "../registry/fetch-resource";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import { surveyChatDbStamps } from "./chat-store-survey";

/**
 * How many epics the refusal names before it collapses the rest into
 * "+N more".
 *
 * The message is read in a terminal and pasted into support threads, and the
 * decision it supports ("do I really want to lose these chats?") does not get
 * better after ten ids. The count is always exact, so nothing is hidden - only
 * the enumeration is bounded. `details` is capped at the same number so the
 * NDJSON envelope cannot grow without bound either.
 */
export const STORE_FORMAT_FLOOR_LISTED_EPICS = 10;

/**
 * How long the manifest read that resolves the TARGET's published formats may
 * take before the gate gives up on it and falls back to the fixed table.
 *
 * Short, and safe to be short: giving up means "unknown", and unknown REFUSES.
 * The only cost of a timeout is a refusal the user can override, never a
 * downgrade that proceeds unchecked.
 */
const STORE_FORMATS_LOOKUP_TIMEOUT_MS = 5_000;

/** Which command is about to land the bytes; prefixes the refusal. */
export type StoreFormatFloorSite =
  | "host install"
  | "host ensure"
  | "host update"
  | "host apply";

export interface StoreFormatFloorInput {
  readonly environment: Environment;
  /**
   * The host DATA root the target build would serve - `hostHomeDir(...)`, the
   * directory holding `epic-state/`, never the install directory.
   */
  readonly hostHome: string;
  /** The version whose bytes are about to be placed. */
  readonly targetVersion: string;
  /**
   * The target's `storeFormats` as PUBLISHED on its registry manifest entry,
   * or `null` when the caller had no entry to read - a `--from` / bundled
   * archive, or a lookup that failed. `null` is not "no constraint": it sends
   * the resolution to the fixed table, which refuses anything above its
   * ceiling.
   */
  readonly publishedStoreFormats: HostStoreFormats | null;
  /**
   * What the ARCHIVE about to be installed declares about itself, from its
   * runtime `version.json`, or `null` when the caller cannot see one yet.
   *
   * `null` before staging is the honest answer, not a shortcut: a pre-stage
   * site has no archive to ask. It is what makes an off-ladder target stand
   * aside there and be judged at the commit tail instead, where the extracted
   * tree can finally answer for itself.
   */
  readonly declaredStoreFormats: HostStoreFormats | null;
  /**
   * `install.json`'s version, or `null` when nothing is installed. `null`
   * still evaluates: a data directory outlives the install that wrote it (the
   * uninstaller deliberately keeps user data), so "no host installed" is
   * exactly the state in which a downgrade is most likely to be attempted.
   */
  readonly installedVersion: string | null;
  /**
   * What the INSTALLED tree declares it writes, or `null`. See
   * `InstalledFloorOperands.storeFormats` - it is what keeps a build-stamped
   * install from walking the disk on a move that is not a downgrade.
   *
   * An input rather than something this module fetches, so a caller's test can
   * state the installed side instead of inheriting the developer's own
   * `~/.traycer`.
   */
  readonly installedStoreFormats: HostStoreFormats | null;
  /** `--accept-store-format-loss`. Never inferred from `--force`. */
  readonly acceptStoreFormatLoss: boolean;
  readonly site: StoreFormatFloorSite;
  readonly logger: ILogger;
}

/**
 * Refuse to land `targetVersion` when a store on disk is stamped above the
 * format it reads.
 *
 * Returns normally on `clear`, on a gate that does not apply, and on a
 * `blocked`/`indeterminate` verdict the caller explicitly accepted; throws
 * `E_HOST_STORE_FORMAT_FLOOR` otherwise.
 */
export async function assertHostStoreFormatFloor(
  input: StoreFormatFloorInput,
): Promise<void> {
  const applicability = storeFloorApplicability(
    input.targetVersion,
    input.installedVersion,
    input.declaredStoreFormats,
  );
  if (!applicability.applies) {
    logFloorNotApplicable({
      environment: input.environment,
      site: input.site,
      targetVersion: input.targetVersion,
      installedVersion: input.installedVersion,
      reason: applicability.reason,
      logger: input.logger,
    });
    return;
  }
  // The manifest's published field wins over the archive's own declaration:
  // the registry entry is stamped at RELEASE time from the same source
  // constant, and it is the value the host and the desktop resolve too, so
  // preferring it keeps the three actors reading one number. The declaration
  // is what answers for a build the registry never saw.
  const target = resolveHostStoreFormats(
    input.targetVersion,
    input.publishedStoreFormats ?? input.declaredStoreFormats,
  );
  // The INSTALLED side, from the installed tree's own declaration first and
  // the fixed table second - never from a manifest, which describes a build
  // that may not be the one on disk.
  //
  // The declaration is not a nicety here. A skipped walk always ALLOWS, but a
  // taken walk can return `indeterminate`, and that REFUSES - so an unknown
  // installed side does not merely cost milliseconds, it converts a clear
  // verdict into a refusal the moment any single store happens to be
  // unreadable (an EACCES, a `-wal` under an unwritable directory, an
  // exclusive lock - precisely the state a crash-looping host leaves behind).
  // Every build-stamped install is unplaceable by the table, so without the
  // declaration `host ensure` converging FORWARD onto its own bundled host
  // could be refused over a move that cannot lose anything, with no way past
  // it but a flag neither the desktop nor `make` passes.
  const installed =
    input.installedVersion === null
      ? null
      : resolveHostStoreFormats(
          input.installedVersion,
          input.installedStoreFormats,
        );
  if (storeFloorClearedByFormats(target, installed)) {
    input.logger.debug("Host store-format floor cleared without a disk walk", {
      environment: input.environment,
      site: input.site,
      targetVersion: input.targetVersion,
      installedVersion: input.installedVersion,
      targetChatDb: knownChatDb(target),
      installedChatDb: knownChatDb(installed),
    });
    return;
  }
  const survey = await surveyChatDbStamps(input.hostHome);
  // An empty survey is `clear` inside `decideStoreFormatFloor` - a machine
  // with no chat stores has nothing an older target could fail to open, so an
  // unknown target format protects nothing there. This is why
  // `surveyChatDbStamps` must report a root it could not ENUMERATE as a
  // failure rather than as emptiness: the two are indistinguishable here.
  const verdict = decideStoreFormatFloor(target, survey);
  if (verdict.kind === "clear") {
    input.logger.info("Host store-format floor cleared", {
      environment: input.environment,
      site: input.site,
      targetVersion: input.targetVersion,
      installedVersion: input.installedVersion,
      targetChatDb: knownChatDb(target),
      epicsSurveyed: survey.readings.length,
    });
    return;
  }
  const refusal = storeFormatFloorRefusal(input, target, verdict);
  if (input.acceptStoreFormatLoss) {
    // The SAME facts the refusal would have carried, at WARN. A run that
    // accepted the loss should leave behind exactly what a run that refused it
    // would have shown, so a later "why are my chats gone" reads off one line.
    input.logger.warn(
      "Host store-format floor overridden by --accept-store-format-loss",
      {
        environment: input.environment,
        site: input.site,
        ...floorLogFields(input, target, verdict),
        message: refusal.message,
      },
    );
    return;
  }
  input.logger.error(
    "Host store-format floor refused the target",
    {
      environment: input.environment,
      site: input.site,
      ...floorLogFields(input, target, verdict),
    },
    null,
  );
  throw refusal;
}

/**
 * The record that the floor did not judge this move.
 *
 * Shared by the pre-stage gate and the commit tail so both sites say it, and
 * say it the same way. Two very different non-answers, logged at different
 * levels on purpose: `target-not-older` is the overwhelmingly common path
 * (every upgrade) and belongs at debug, while `target-off-ladder` means the
 * floor had nothing to judge the target BY - it stood aside rather than
 * cleared it - and an operator reading why a downgrade was allowed deserves to
 * find that at INFO rather than infer it from silence.
 */
function logFloorNotApplicable(args: {
  readonly environment: Environment;
  readonly site: StoreFormatFloorSite;
  readonly targetVersion: string;
  readonly installedVersion: string | null;
  readonly reason: "target-not-older" | "target-off-ladder";
  readonly logger: ILogger;
}): void {
  const fields = {
    environment: args.environment,
    site: args.site,
    targetVersion: args.targetVersion,
    installedVersion: args.installedVersion,
    reason: args.reason,
  };
  if (args.reason !== "target-off-ladder") {
    args.logger.debug("Host store-format floor not consulted", fields);
    return;
  }
  args.logger.info("Host store-format floor stood aside", {
    ...fields,
    detail:
      "the target is not a released host version and declares no store formats; the commit tail judges the staged archive's own declaration",
  });
}

function storeFormatFloorRefusal(
  input: StoreFormatFloorInput,
  target: HostStoreFormatsKnowledge,
  verdict: Exclude<StoreFormatFloorVerdict, { kind: "clear" }>,
): CliError {
  const head = `${input.site}: refusing to install host ${input.targetVersion} over ${describeInstalled(input.installedVersion)}`;
  const remedy =
    "Update forward instead, or rerun with --accept-store-format-loss to install it anyway and lose access to those chats.";
  const message =
    verdict.kind === "blocked"
      ? `${head} - it reads chat store format ${verdict.targetChatDb}, and ${countedEpics(verdict.epics.length)} on this machine ${verdict.epics.length === 1 ? "carries" : "carry"} a newer one (${describeReadings(verdict.epics)}).${describeBlockedFailures(verdict.failures)} Those chats would be unreadable to it, and a host that meets a store it cannot open crash-loops rather than reporting it. ${remedy}`
      : `${head} - ${describeIndeterminate(input, verdict)}, so it cannot be shown that those chats survive the downgrade. ${remedy}`;
  return cliError({
    code: CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR,
    message,
    details: {
      environment: input.environment,
      site: input.site,
      verdict: verdict.kind,
      // Carries `targetVersion` / `installedVersion` too - the same fields the
      // log line gets, from the same builder, so a support thread comparing an
      // NDJSON envelope against `cli.log` cannot find them disagreeing.
      ...floorLogFields(input, target, verdict),
    },
    exitCode: 1,
  });
}

/**
 * The unreadable stores a BLOCKED verdict also found, or nothing.
 *
 * `blocked` wins over `indeterminate` because naming the proven-newer epics is
 * the more useful refusal - but the unreadable ones are still stores whose
 * fate this verdict cannot speak for, and a message that listed only the
 * proven ones would under-report what the user is about to lose. Leading space
 * included so the caller can concatenate an empty string away.
 */
function describeBlockedFailures(
  failures: readonly ChatDbStampFailure[],
): string {
  if (failures.length === 0) return "";
  return ` A further ${countedEpics(failures.length)} could not be read at all (${describeFailures(failures)}), so what a downgrade would do to ${failures.length === 1 ? "it" : "them"} cannot be shown either.`;
}

function describeIndeterminate(
  input: StoreFormatFloorInput,
  verdict: Extract<StoreFormatFloorVerdict, { kind: "indeterminate" }>,
): string {
  if (verdict.reason === "target-format-unknown") {
    return `this CLI cannot tell which chat store format ${input.targetVersion} reads (its registry entry publishes none, and it is outside the versions this CLI has a built-in answer for)`;
  }
  return `${countedEpics(verdict.failures.length)} on this machine could not be read (${describeFailures(verdict.failures)})`;
}

function describeInstalled(installedVersion: string | null): string {
  return installedVersion === null
    ? "this machine's host data"
    : `the installed ${installedVersion}`;
}

function countedEpics(count: number): string {
  return count === 1 ? "1 epic" : `${count} epics`;
}

function describeReadings(readings: readonly ChatDbStampReading[]): string {
  return joinCapped(
    readings.map(
      (reading) => `${reading.epicId} at format ${reading.schemaVersion}`,
    ),
  );
}

function describeFailures(failures: readonly ChatDbStampFailure[]): string {
  return joinCapped(
    failures.map(
      (failure) =>
        `${failure.epicId}: ${describeFailureReason(failure.reason)}`,
    ),
  );
}

/**
 * A failure code as a sentence fragment.
 *
 * The message a user reads should say what happened, not name an enum; the
 * enum itself still travels in `details` for anything parsing the envelope.
 * `engine-unavailable` is the one that matters most to get right - it is a
 * statement about THIS PROCESS, and phrasing it as a damaged file would blame
 * the user's data for the CLI's runtime.
 */
function describeFailureReason(reason: ChatDbStampFailureReason): string {
  switch (reason) {
    case "linked-epic-directory":
      return "the epic directory is a symbolic link";
    case "linked-chat-directory":
      return "the chat directory is a symbolic link";
    case "epic-state-not-a-directory":
      return "the epic entry is not a directory";
    case "chat-directory-not-a-directory":
      return "the chat entry is not a directory";
    case "unreadable-epic-state-directory":
      return "the epic-state directory could not be read";
    case "chat-db-not-a-file":
      return "chat.db is not a regular file";
    case "missing-or-invalid-schema-version":
      return "it carries no usable format stamp";
    case "unreadable-chat-db":
      return "chat.db could not be read";
    case "engine-unavailable":
      return "this CLI has no SQLite engine under the runtime it is running on, so no store was examined";
    case "survey-failed":
      return "the survey did not complete";
  }
}

function joinCapped(parts: readonly string[]): string {
  const listed = parts.slice(0, STORE_FORMAT_FLOOR_LISTED_EPICS);
  const hidden = parts.length - listed.length;
  return hidden > 0
    ? `${listed.join("; ")}; +${hidden} more`
    : listed.join("; ");
}

/**
 * The verdict's facts, shaped for both the log line and the error `details`
 * so the two cannot drift. Capped at the same list length as the message: an
 * NDJSON error envelope is read by Desktop and by CI, and neither is served by
 * an unbounded epic array.
 */
function floorLogFields(
  input: StoreFormatFloorInput,
  target: HostStoreFormatsKnowledge,
  verdict: Exclude<StoreFormatFloorVerdict, { kind: "clear" }>,
): { readonly [key: string]: LogValue } {
  const blockedEpics =
    verdict.kind === "blocked" ? verdict.epics : ([] as const);
  // Both verdicts carry failures now. A blocked verdict used to drop them,
  // which meant the NDJSON envelope and the log line named only the epics the
  // survey could prove - and everything downstream that renders a refusal
  // (the consent warning, the typed GUI refusal) inherited that blind spot.
  const failures = verdict.failures;
  return {
    targetVersion: input.targetVersion,
    installedVersion: input.installedVersion,
    targetChatDb: knownChatDb(target),
    targetFormatUnknownReason: target.kind === "unknown" ? target.reason : null,
    blockedEpicCount: blockedEpics.length,
    blockedEpics: blockedEpics
      .slice(0, STORE_FORMAT_FLOOR_LISTED_EPICS)
      .map((reading) => ({
        epicId: reading.epicId,
        schemaVersion: reading.schemaVersion,
      })),
    unreadableEpicCount: failures.length,
    unreadableEpics: failures
      .slice(0, STORE_FORMAT_FLOOR_LISTED_EPICS)
      .map((failure) => ({ epicId: failure.epicId, reason: failure.reason })),
  };
}

function knownChatDb(
  knowledge: HostStoreFormatsKnowledge | null,
): number | null {
  if (knowledge === null || knowledge.kind !== "known") return null;
  return knowledge.formats.chatDb;
}

/**
 * What a caller's own early gate learned, carried down to the commit tail so
 * the LAST fail-closed check before the swap can re-run the same decision
 * without re-fetching anything.
 *
 * The early gate is where a refusal is cheap - nothing downloaded, nothing
 * stopped. This exists because `commitInstallFromSource` is the ONE funnel
 * every path shares, and a compatibility check whose coverage depends on every
 * caller having remembered to call it is not a floor. Threading the evidence
 * rather than re-deriving it is what keeps the late check from FALSELY
 * refusing a legitimate downgrade: the published formats live on a manifest
 * entry the commit tail has no access to.
 */
export interface StoreFormatFloorEvidence {
  /**
   * The version the caller's early gate actually cleared, or `null` when it
   * ran none (a caller with no version to resolve before staging).
   *
   * Checked against the version being committed rather than trusted. The stage
   * is a shared slot and the transfer is unlocked, so the bytes at the swap are
   * not always the bytes that were gated; when they differ, the published
   * formats below describe a different build and are dropped, which sends the
   * late check to the fixed table - and, above its ceiling, to a refusal.
   */
  readonly clearedVersion: string | null;
  /** See `StoreFormatFloorInput.publishedStoreFormats`. */
  readonly publishedStoreFormats: HostStoreFormats | null;
  /** See `StoreFormatFloorInput.acceptStoreFormatLoss`. */
  readonly acceptStoreFormatLoss: boolean;
  readonly site: StoreFormatFloorSite;
}

/**
 * The version the floor judges for a tree that is about to land: the ARCHIVE's
 * own `version.json` stamp when it declares one, else the version the install
 * record will carry.
 *
 * The two are different strings for one shape of install, and only one of them
 * describes the bytes. `host install --from ./host-v1.2.0.tar.gz` records
 * `local-host-v1.2.0.tar.gz-<timestamp>` - deliberately, so one local install
 * is distinguishable from the next - and that stamp is not a released version.
 * Judged by it, a genuinely released 1.2.0 archive reads as off-ladder and the
 * floor STANDS ASIDE on precisely the downgrade it exists to refuse. Judged by
 * the sidecar's `1.2.0`, the fixed table answers chat store format 8 and a
 * machine holding 9s blocks it.
 *
 * Preferred whether or not the declaration is itself a released version. A
 * stamp read off the tree is a better description of the tree than one derived
 * from a filename or a caller's prediction either way, and an off-ladder
 * declaration that names no formats still stands aside - so the preference can
 * only ever move a target from "unjudgeable" towards "judged".
 */
export function storeFormatFloorTargetVersion(
  declaredRuntimeVersion: string | null,
  recordVersion: string,
): string {
  return declaredRuntimeVersion ?? recordVersion;
}

/**
 * The floor, re-checked at the commit tail from the version actually being
 * placed.
 *
 * Deliberately a full re-run rather than a "did the early gate pass?" flag.
 * Between the two the world moves: a host can open an epic and stamp a new
 * store while the archive downloads, and the staged bytes can be replaced by
 * another promoter. Both are answered by asking the question again here, where
 * the version is no longer a prediction.
 */
export async function assertStoreFormatFloorAtCommit(args: {
  readonly environment: Environment;
  readonly hostHome: string;
  /**
   * The version the install RECORD will carry. Not necessarily the version
   * judged - see `declaredRuntimeVersion`.
   */
  readonly committingVersion: string;
  /**
   * The archive's own `version.json` stamp, or `null` when it declares none.
   *
   * Takes precedence over `committingVersion` as the version this check
   * judges (`storeFormatFloorTargetVersion`), because a record version can be
   * derived from a local filename while this one is read from the tree.
   */
  readonly declaredRuntimeVersion: string | null;
  /**
   * What the extracted tree about to be swapped in declares about itself.
   *
   * The tail is the FIRST point that can ask - a pre-stage gate has no archive
   * - and for an off-ladder build it is the only source of an answer at all.
   * Read from the bytes being committed rather than carried in the evidence,
   * so it describes what is actually landing.
   */
  readonly declaredStoreFormats: HostStoreFormats | null;
  readonly installedVersion: string | null;
  /** See `StoreFormatFloorInput.installedStoreFormats`. */
  readonly installedStoreFormats: HostStoreFormats | null;
  readonly evidence: StoreFormatFloorEvidence;
  readonly logger: ILogger;
}): Promise<void> {
  const targetVersion = storeFormatFloorTargetVersion(
    args.declaredRuntimeVersion,
    args.committingVersion,
  );
  // Compared against the version JUDGED, not the one recorded: the published
  // formats were fetched for the manifest entry the early gate named, and if
  // the tree about to land calls itself something else then that entry
  // describes a different build. Dropping them sends the resolution to the
  // archive's own declaration and then to the fixed table - the fail-closed
  // direction - rather than clearing these bytes on another build's word.
  const sameBytesAsGated = args.evidence.clearedVersion === targetVersion;
  if (!sameBytesAsGated && args.evidence.clearedVersion !== null) {
    args.logger.warn(
      "Host store-format floor re-checked against different bytes than the early gate cleared",
      {
        environment: args.environment,
        site: args.evidence.site,
        clearedVersion: args.evidence.clearedVersion,
        committingVersion: args.committingVersion,
        declaredRuntimeVersion: args.declaredRuntimeVersion,
        targetVersion,
      },
    );
  }
  await assertHostStoreFormatFloor({
    environment: args.environment,
    hostHome: args.hostHome,
    targetVersion,
    publishedStoreFormats: sameBytesAsGated
      ? args.evidence.publishedStoreFormats
      : null,
    // NOT dropped when the bytes differ from what was gated: a declaration is
    // read off the tree being committed, so it describes those exact bytes
    // whatever the early gate looked at.
    declaredStoreFormats: args.declaredStoreFormats,
    installedVersion: args.installedVersion,
    installedStoreFormats: args.installedStoreFormats,
    acceptStoreFormatLoss: args.evidence.acceptStoreFormatLoss,
    site: args.evidence.site,
    logger: args.logger,
  });
}

/**
/**
 * Evidence for a caller that could NOT gate early - it had no concrete version
 * before staging (`--from`, an implicit `latest`).
 *
 * `clearedVersion: null` is a statement, not a placeholder: the commit tail
 * reads it as "nothing was pre-cleared", resolves the target through the fixed
 * table, and refuses anything the table cannot vouch for. That is the point -
 * a path that cannot name its target in advance must be MORE conservative at
 * the swap, not exempt from the check.
 */
export function ungatedStoreFormatFloorEvidence(
  site: StoreFormatFloorSite,
  acceptStoreFormatLoss: boolean,
): StoreFormatFloorEvidence {
  return {
    clearedVersion: null,
    publishedStoreFormats: null,
    acceptStoreFormatLoss,
    site,
  };
}

/**
 * The early gate for a command that has already resolved a CONCRETE target
 * version: consult the floor, and hand back the evidence for the commit tail.
 *
 * The manifest read is inside the gate rather than before it, so the ordinary
 * upgrade pays nothing: `storeFloorApplicability` answers from two version
 * strings, and only a move that is actually backwards goes to the network for
 * the target's published formats. That ordering is the whole reason this
 * helper exists instead of each caller resolving the formats itself - a lookup
 * hoisted above the applicability test would put a manifest fetch on every
 * `host install --release`, including the ones that install something newer.
 *
 * Callers with no concrete version yet (`--from`, an implicit `latest`) skip
 * this and rely on `assertStoreFormatFloorAtCommit`, which sees the version
 * that actually resolved.
 */
export async function gateStoreFormatFloor(args: {
  readonly environment: Environment;
  readonly hostHome: string;
  readonly targetVersion: string;
  readonly installedVersion: string | null;
  /**
   * Whether the target is a REGISTRY version whose manifest entry may publish
   * its store formats. False for a local archive or this build's own bundled
   * host: those have no entry to read, so the resolution is the fixed table
   * and asking the network would be a round trip that cannot answer.
   */
  readonly consultRegistry: boolean;
  /** See `StoreFormatFloorInput.installedStoreFormats`. */
  readonly installedStoreFormats: HostStoreFormats | null;
  readonly acceptStoreFormatLoss: boolean;
  readonly site: StoreFormatFloorSite;
  readonly logger: ILogger;
}): Promise<StoreFormatFloorEvidence> {
  const evidence = {
    clearedVersion: args.targetVersion,
    acceptStoreFormatLoss: args.acceptStoreFormatLoss,
    site: args.site,
  };
  // A pre-stage site holds no archive, so the applicability test sees no
  // declaration - which is exactly how an off-ladder target reaches its
  // `target-off-ladder` answer here and is judged at the commit tail instead.
  const applicability = storeFloorApplicability(
    args.targetVersion,
    args.installedVersion,
    null,
  );
  if (!applicability.applies) {
    // Logged HERE and not only inside the gate below: this early return is the
    // one that runs on every ordinary install, so leaving it silent would mean
    // the "stood aside" record the module promises appears at a pre-stage site
    // exactly never.
    logFloorNotApplicable({
      environment: args.environment,
      site: args.site,
      targetVersion: args.targetVersion,
      installedVersion: args.installedVersion,
      reason: applicability.reason,
      logger: args.logger,
    });
    return { ...evidence, publishedStoreFormats: null };
  }
  const publishedStoreFormats = args.consultRegistry
    ? await lookupPublishedStoreFormats(
        args.environment,
        args.targetVersion,
        args.logger,
      )
    : null;
  await assertHostStoreFormatFloor({
    environment: args.environment,
    hostHome: args.hostHome,
    targetVersion: args.targetVersion,
    publishedStoreFormats,
    declaredStoreFormats: null,
    installedVersion: args.installedVersion,
    installedStoreFormats: args.installedStoreFormats,
    acceptStoreFormatLoss: args.acceptStoreFormatLoss,
    site: args.site,
    logger: args.logger,
  });
  return { ...evidence, publishedStoreFormats };
}

/**
 * The TARGET's published `storeFormats`, looked up on the registry manifest.
 *
 * Modelled on `createRegistryYankLookup`, with the opposite failure posture:
 * the yank lookup fails OPEN because refusing an install over an unreachable
 * manifest would be worse than installing a withdrawn build, while a floor
 * that fails open is not a floor. Every failure here yields `null`, which
 * sends the resolution to the fixed table - and a target the table does not
 * cover is then UNKNOWN, which refuses.
 *
 * Only ever called on a path that has already decided the target is older than
 * the install, so an offline machine pays this timeout on a downgrade and
 * never on an ordinary update.
 */
export async function lookupPublishedStoreFormats(
  environment: Environment,
  version: string,
  logger: ILogger,
): Promise<HostStoreFormats | null> {
  const manifestUrl = resolveManifestUrl().url;
  const controller = new AbortController();
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    controller.abort();
  }, STORE_FORMATS_LOOKUP_TIMEOUT_MS);
  try {
    const body = await fetchText(manifestUrl, {
      signal: controller.signal,
      onHeartbeat: null,
    });
    const parsed: unknown = JSON.parse(body);
    const manifest = parseHostVersionsManifestWithWarnings(
      parsed,
      manifestUrl,
    ).manifest;
    const entry = manifest.versions.find((row) => row.version === version);
    return entry?.storeFormats ?? null;
  } catch (err) {
    logger.warn(
      "Host store-format lookup failed; falling back to the built-in table",
      {
        environment,
        manifestUrl,
        version,
        watchdogExpired,
        errorName: errorFromUnknown(err).name,
      },
    );
    return null;
  } finally {
    clearTimeout(watchdog);
  }
}
