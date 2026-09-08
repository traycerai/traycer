import {
  NO_CHAT_STORE,
  resolveHostStoreFormats,
  storeFloorApplicability,
  storeFloorClearedByFormats,
  type HostStoreFormats,
  type HostStoreFormatsKnowledge,
} from "@traycer/protocol/host/store-formats";
import type {
  HostStatusInstall,
  HostStatusStoreFormats,
} from "@traycer/protocol/host/status/index";
import type { HostUpdateStoreFloorRefusal } from "@traycer/protocol/host/maintenance/index";

/**
 * One availability rule for both the version picker and the summary action.
 * The RPC still re-surveys before dispatch: a cached status can explain an
 * offer, but cannot authorize placing older bytes over newly migrated data.
 */
export interface HostStoreFormatOffer {
  readonly version: string;
  readonly publishedFormats: HostStoreFormats | null;
  readonly runningVersion: string | null;
  readonly storeFormats: HostStatusStoreFormats | null;
  /**
   * The install record's provenance and the installed tree's own declaration
   * (`host.status@1.5`), or `null` for a peer that reported none: an older
   * host, or one with no install record at all.
   *
   * This is what lets the pre-check judge a row the way the CLI's commit tail
   * will. The CLI decides from BOTH install records' provenance whether a move
   * takes the version shortcut (`StoreFloorTargetIdentity`), and a desktop
   * provisions from its bundled archive - a `local-file` record under the
   * CLI's own version - so its first registry upgrade EVALUATES there. A
   * pre-check that only saw `runningVersion` called that upgrade unrestricted
   * and then met the CLI's refusal; with the record's provenance and the
   * sidecar's declaration it reaches the same verdict up front. `null` is
   * judged as a registry install, which is what every row was judged as
   * before the field existed.
   */
  readonly install: HostStatusInstall | null;
  /**
   * Whether the NEGOTIATED `host.update.install` carries the store-format
   * floor - the `@1.3` contract that added per-dispatch loss consent and the
   * typed refusal.
   *
   * Separate from "can this host downgrade at all", which is `@1.2`. Those two
   * minors are the whole finding: a host in between advertises downgrades and
   * has no floor behind them, so it neither surveys before installing nor has
   * anywhere to put the consent this page collects - the framework projects
   * `acceptStoreFormatLoss` away on the way down.
   */
  readonly installSupportsStoreFloor: boolean;
}

export interface HostStoreFormatRestriction {
  readonly kind:
    | "blocked"
    | "unknown"
    | "pending"
    | "failed"
    | "floor-unsupported";
  readonly reason: string;
  readonly detail: string | null;
  readonly confirmation: string | null;
}

export function hostStoreFormatRestriction(
  input: HostStoreFormatOffer,
): HostStoreFormatRestriction | null {
  // Read BEFORE the `storeFormats === null` return below, because whether the
  // floor APPLIES does not depend on what the host reported about its stores.
  const applies = storeFloorApplies(input);
  // A peer that cannot be told about store-format loss must not be offered a
  // downgrade at all - not even behind Install anyway, because there is no
  // way for it to honour the consent that button collects. It predates the
  // floor: it will not survey, and `acceptStoreFormatLoss` is projected away
  // before it arrives. Withholding is the only honest answer, and it is
  // deliberately independent of `storeFormats`: a host that cannot honour
  // consent stays withheld whether or not it happens to report its formats.
  if (applies && !input.installSupportsStoreFloor) {
    return unsupportedFloorRestriction(input.version);
  }
  // Nothing reported, and the peer CAN honour the floor: leave the row alone
  // and let the host's own pre-dispatch survey refuse it authoritatively.
  if (input.storeFormats === null) return null;
  const target = resolveHostStoreFormats(input.version, input.publishedFormats);
  const chatDb = input.storeFormats.chatDb;
  // Formats FIRST, before either uncertain survey state. A target that reads
  // at least the installed side's format cannot make any store newly
  // unreadable, so nothing a survey could find - pending, failed or complete
  // - changes the answer. An rc.4 → rc.1 move inside one chat-store format is
  // the everyday case: both stamp 9, and holding it on "Checking chat stores…"
  // would wait for a walk whose result cannot matter.
  //
  // `storeFloorClearedByFormats` rather than a local `>=` because this is the
  // same predicate the CLI clears a move with before it walks the disk and
  // the host clears a refusal with before it sends one. Three ends, one rule;
  // a fourth spelling here is how they drift. The installed operand is the one
  // the CLI will hold, not always this build's own stamp - see
  // `installedSideKnowledge`.
  if (
    applies &&
    storeFloorClearedByFormats(
      target,
      installedSideKnowledge(input.install, chatDb.current),
    )
  ) {
    return null;
  }
  // Boot uncertainty is transient. Do not offer loss consent until the
  // first survey has answered, even if this target's metadata is unknown.
  if (applies && chatDb.survey === "pending") {
    return {
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    };
  }
  // A completed empty survey has no chats to lose access to, even when the
  // target's format is unknown. A fresh RPC refusal can still override this
  // cached observation if a store appeared after the status poll.
  if (surveyCompleteAndEmpty(chatDb)) return null;
  if (target.kind === "unknown") {
    return applies ? unknownTargetRestriction(input.version) : null;
  }
  // A failed survey read no file, so on its own it can only ever produce
  // uncertainty; the formats-first clearance above has already excused every
  // target that reads the installed side's files anyway, so what reaches here
  // is a target the formats could not clear over stores nobody could inspect.
  if (applies && chatDb.survey === "failed") {
    return unreadableStoresRestriction(input.version);
  }
  if (chatDb.onDiskMax === null || chatDb.onDiskMax <= target.formats.chatDb) {
    return null;
  }
  // `null`, not an empty group: this path reads the cached `host.status`,
  // which reports whether the survey failed but never which epics - so it has
  // nothing to say about unreadable stores either way.
  return newerStoresRestriction(
    input.version,
    target.formats.chatDb,
    chatDb.onDiskMax,
    null,
  );
}

/**
 * Whether the floor evaluates this row at all, decided the way the CLI's
 * commit tail decides it (`StoreFloorTargetIdentity`).
 *
 * Between two registry artifacts the version IS the identity, so the string
 * shortcuts apply: an identical or strictly newer row is not a downgrade and
 * is not evaluated. `null` for the declaration there, deliberately: a
 * declaration makes `storeFloorApplicability` evaluate unconditionally
 * because it is an ARCHIVE's own `version.json`, the word of a tree that named
 * itself. A catalog row is a signed registry artifact, and the manifest's
 * published formats describe it rather than override it; they still resolve
 * the target's format in the caller, where they belong.
 *
 * With a local archive on the INSTALLED end the recorded version is not the
 * tree's identity (`host ensure --from` records a bundled archive under the
 * CLI's OWN version), so the CLI withholds it from applicability and every
 * move evaluates - a forward move included. It is then cleared from formats
 * when the installed side can be placed, and walked when it cannot; the
 * caller mirrors both.
 */
function storeFloorApplies(input: HostStoreFormatOffer): boolean {
  if (input.install !== null && input.install.source === "local-file") {
    return true;
  }
  return storeFloorApplicability(input.version, input.runningVersion, null)
    .applies;
}

/**
 * The installed side as the CLI will place it.
 *
 * For a registry install that is this build's own stamp: every registry
 * archive from 1.3.0 carries the sidecar and the fixed table places every
 * release before it, so the CLI's read and `current` agree, and `current` is
 * the exact value. For a local archive the CLI reads the sidecar beside the
 * installed executable and falls back to the table on the RECORDED version -
 * the CLI's own, not the tree's - so this resolves what the host reported
 * those two reads say, through the same resolver the CLI uses. An install the
 * CLI cannot place is `unknown` here too, which is what sends the row to the
 * survey branches instead of clearing it on a number the CLI never sees.
 */
function installedSideKnowledge(
  install: HostStatusInstall | null,
  current: number,
): HostStoreFormatsKnowledge {
  if (install === null || install.source === "registry") {
    return { kind: "known", formats: { chatDb: current } };
  }
  return resolveHostStoreFormats(install.version, install.declaredFormats);
}

/** A completed survey that found no chat store at all. */
function surveyCompleteAndEmpty(
  chatDb: HostStatusStoreFormats["chatDb"],
): boolean {
  return (
    chatDb.survey === "complete" &&
    chatDb.onDiskMax === null &&
    chatDb.epicCount === 0
  );
}

/**
 * A fresh host refusal outranks the catalog/status that offered the action.
 * Keep it actionable even when those retained reads cannot reproduce it.
 *
 * Deliberately WITHOUT the formats shortcut the cached path above applies.
 * `hostInstallStoreFloorRefusal` already runs `storeFloorClearedByFormats`
 * against the running build's own `CHAT_DB_SCHEMA_VERSION` and returns null
 * when it clears, so a refusal that reached this function is one the host
 * decided formats alone could NOT clear - with the authoritative version of
 * the same evidence. Re-deciding it here from a cached status would be a
 * second opinion formed from strictly less.
 */
export function hostStoreFormatRestrictionFromRpc(
  refusal: HostUpdateStoreFloorRefusal,
): HostStoreFormatRestriction {
  if (refusal.kind === "blocked" && refusal.targetChatDb !== null) {
    return newerStoresRestriction(
      refusal.targetVersion,
      refusal.targetChatDb,
      refusal.onDiskMax,
      {
        count: refusal.unreadableEpicCount,
        epicIds: refusal.unreadableEpicIds,
      },
    );
  }
  return refusal.reason === "target-format-unknown"
    ? unknownTargetRestriction(refusal.targetVersion)
    : unreadableStoresRestriction(refusal.targetVersion);
}

/**
 * The row is WITHHELD: this host is too old to be downgraded safely, and no
 * consent this page could collect would change that.
 *
 * `confirmation: null` is the whole mechanism - `VersionRow` reads a null
 * confirmation as "no Install anyway", so a non-null `reason` with no
 * confirmation disables the row and prints why. That is the same shape
 * `pending` already uses; this one is permanent until the host moves.
 *
 * Named `floor-unsupported` rather than `unsupported` because this folder
 * already has an `unsupported`: `OverviewDegradeReason`'s, which retires the
 * whole update region when a METHOD is absent. Different union, different
 * scope, and one word for both would have to be disambiguated by whoever read
 * it next.
 */
function unsupportedFloorRestriction(
  version: string,
): HostStoreFormatRestriction {
  return {
    kind: "floor-unsupported",
    reason: "Update this host before installing an older version",
    detail: `This host is too old to check whether v${version} can open this device's chats, so it can't be downgraded from here. Update the host first; older versions become available once it can check.`,
    confirmation: null,
  };
}

function unknownTargetRestriction(version: string): HostStoreFormatRestriction {
  return {
    kind: "unknown",
    reason: "Chat store format not published",
    detail: `v${version} doesn't publish which chat store format it reads, so this device's data can't be verified against it.`,
    confirmation: `v${version} doesn't publish which chat store format it reads, so Traycer can't verify it can open this device's chats.`,
  };
}

function unreadableStoresRestriction(
  version: string,
): HostStoreFormatRestriction {
  return {
    kind: "failed",
    reason: "Chat stores couldn't be read",
    detail:
      "This device's chat stores couldn't be read, so installing this version may lose access to those chats.",
    confirmation: `This device's chat stores couldn't be read, so Traycer can't verify v${version} can open them.`,
  };
}

/**
 * Stores the host's survey could not read, for a caller that HAS that
 * evidence.
 *
 * `null` is a distinct answer from `{count: 0}` and the reason this is an
 * explicit parameter: the authoritative RPC refusal can say "none of them
 * failed to read", while the cached `host.status` path has no per-epic list at
 * all and can only say nothing. Rendering an absent list as "0 epics could not
 * be read" would put a claim the status never made in the host's mouth.
 */
interface UnreadableStoreGroup {
  readonly count: number;
  readonly epicIds: readonly string[];
}

function newerStoresRestriction(
  version: string,
  targetFormat: number,
  onDiskMax: number | null,
  unreadable: UnreadableStoreGroup | null,
): HostStoreFormatRestriction {
  const formatDescription =
    onDiskMax === null ? "in a newer format" : `written in format ${onDiskMax}`;
  const targetDescription =
    targetFormat === NO_CHAT_STORE
      ? `v${version} doesn't read chat stores`
      : `v${version} reads format ${targetFormat}`;
  // The consent this dialog collects is about losing access to chats, so the
  // stores whose fate is UNKNOWN belong in it as much as the proven ones -
  // they are the part of the loss the device cannot bound.
  const unreadableSentence =
    unreadable === null || unreadable.count === 0
      ? ""
      : ` ${describeEpicGroup(unreadable.count, unreadable.epicIds)} couldn't be read, so Traycer can't verify v${version} can open them.`;
  return {
    kind: "blocked",
    reason: newerStoresReason(targetFormat, onDiskMax),
    detail:
      "Can't open chat stores written by this host; installing anyway loses access to those chats until you update forward.",
    confirmation: `This device has chat stores ${formatDescription}. ${targetDescription}, so it can't open those chats, and it may fail to start until you update the host again.${unreadableSentence} Nothing is deleted; updating forward restores access.`,
  };
}

function newerStoresReason(
  targetFormat: number,
  onDiskMax: number | null,
): string {
  if (targetFormat === NO_CHAT_STORE) {
    return "Doesn't read this device's chat stores";
  }
  if (onDiskMax === null) {
    return `Reads format ${targetFormat}; this device has newer chat stores`;
  }
  return `Reads chat store format ${targetFormat}; this device has ${onDiskMax}`;
}

/** The authoritative refusal may name epics a cached status had not seen. */
export function describeHostStoreFloorRpcRefusal(
  refusal: HostUpdateStoreFloorRefusal,
): string {
  const epics = describeEpicGroup(refusal.epicCount, refusal.epicIds);
  if (refusal.kind === "blocked") {
    const maximum =
      refusal.onDiskMax === null
        ? "maximum format could not be determined"
        : `format ${refusal.onDiskMax}`;
    // The unreadable group is reported only on this arm. An `indeterminate`
    // refusal's `epicIds` ARE the stores it could not establish, so naming
    // them a second time here would list the same epics twice under two
    // headings; `blocked` is the arm where they would otherwise vanish behind
    // the proven-newer ones.
    return `Can't install ${refusal.targetVersion}: ${epics} ${refusal.epicCount === 1 ? "uses" : "use"} a newer chat store (${maximum}; ${targetFormatDescription(refusal.targetVersion, refusal.targetChatDb)}).${describeUnreadableClause(refusal)} ${overrideGuidance(refusal.targetVersion)}`;
  }
  const affected = refusal.epicCount > 0 ? ` for ${epics}` : "";
  const reason =
    refusal.reason === "target-format-unknown"
      ? "the target's chat store format is unknown"
      : `the chat stores could not be read${affected}`;
  return `Can't install ${refusal.targetVersion}: ${reason}. ${overrideGuidance(refusal.targetVersion)}`;
}

/**
 * The sentence naming stores the survey could not read at all, or `""` when
 * every store was readable.
 *
 * Separate from the proven-newer list because the two claims are not the same
 * strength and must not be merged into one count: `blocked` proves those epics
 * lose access, while these are epics whose fate nothing on this device can
 * speak for. Folding them together would report an unread stamp as proven.
 */
function describeUnreadableClause(
  refusal: HostUpdateStoreFloorRefusal,
): string {
  if (refusal.unreadableEpicCount === 0) return "";
  const group = describeEpicGroup(
    refusal.unreadableEpicCount,
    refusal.unreadableEpicIds,
  );
  return ` ${group} could not be read.`;
}

/**
 * "3 epics (a, b, …)" - a count, with as many ids as the refusal carried.
 *
 * The counts are unbounded while the id lists are capped at
 * `HOST_STORE_FLOOR_EPIC_ID_LIMIT`, so the ellipsis is the only thing telling
 * a reader the names are a sample rather than the whole set. One helper for
 * both groups, so the proven-newer and unreadable lists cannot drift into two
 * different truncation stories.
 */
function describeEpicGroup(count: number, epicIds: readonly string[]): string {
  const omitted = count > epicIds.length ? ", …" : "";
  const named =
    epicIds.length === 0 ? "" : ` (${epicIds.join(", ")}${omitted})`;
  return `${count} ${count === 1 ? "epic" : "epics"}${named}`;
}

function targetFormatDescription(
  version: string,
  format: number | null,
): string {
  if (format === null) return `${version}'s readable format is unknown`;
  return format === NO_CHAT_STORE
    ? `${version} does not read chat stores`
    : `${version} reads ${format}`;
}

function overrideGuidance(version: string): string {
  return `Update forward instead, or choose Install anyway for v${version} to proceed and lose access to affected chats until the host is updated again.`;
}
