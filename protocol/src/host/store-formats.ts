/**
 * On-disk store formats, by released host version.
 *
 * A host's data directory is shared by every build that runs on it, and the
 * per-epic chat store (`~/.traycer/host/epic-state/<epicId>/chat/chat.db`)
 * carries a forward-only stamp: a build refuses a file stamped newer than the
 * schema it speaks. So installing an OLDER host over a data directory an newer
 * host has written is a data-availability event, not a version choice - and
 * the refusal has to happen BEFORE any bytes are swapped, by whoever is about
 * to swap them, from knowledge of what the target build reads.
 *
 * This module is that knowledge. It is in the protocol package because the
 * three actors that can land older bytes cannot share code any other way: the
 * CLI (`host install`, `host update --allow-downgrade`, `host ensure`), the
 * host's own `host.update.install` resolver, and the desktop's update offers.
 *
 * ## Two sources, one precedence
 *
 * 1. A registry manifest entry published from 1.3.0 on carries
 *    `storeFormats: { chatDb }` - the stamp that build writes, read straight
 *    from its source at release time. When present it wins.
 * 2. Entries published before that field existed are covered by the FIXED
 *    TABLE below, which was read off the tagged sources and stops at
 *    {@link CHAT_DB_FORMAT_TABLE_CEILING}. Anything newer that arrives
 *    without the field is UNKNOWN, and unknown refuses: guessing "probably
 *    still 9" is exactly the reading that fails permissively.
 *
 * 3. A host ARCHIVE can declare its own formats in its runtime `version.json`
 *    (written by the host's SEA build from the same source constant). That is
 *    how a build that is not a release - the archive a local desktop install
 *    bundles, stamped `<target>.<epochMs>.<sha>` - is judged, since neither
 *    the manifest nor the table has a line for it.
 *
 * ## What the verdict compares
 *
 * The target's format against the MAXIMUM stamp on disk - never "the target is
 * older than the install". Every 1.3.0 release candidate speaks 9, so an
 * rc→rc rollback stays allowed; what is refused is landing a build that cannot
 * open files already on the machine.
 *
 * ## What the floor does not govern
 *
 * A target that is not on the release ladder at all and declares nothing - a
 * dev archive built before archives carried their formats - is outside the
 * floor's model rather than refused by it: it cannot be shown to be a
 * downgrade, and a released host always has a SemVer version, so the exemption
 * never covers anything a user can install from the registry. See
 * {@link storeFloorApplicability}.
 */
import { compareHostVersions, isValidHostVersion } from "./version-order";

/**
 * The version a host reports when built straight from source, before the
 * deploy stamper rewrites it. It parses as SemVer and would sit in the
 * pre-chat-store era of the fixed table, which is exactly wrong for a build of
 * today's source - so the table refuses to vouch for it.
 */
export const SOURCE_TREE_HOST_VERSION = "0.0.0-dev";

/**
 * The `chat_db_meta.schema_version` stamp a host build writes, or
 * {@link NO_CHAT_STORE} for a build that predates the store.
 */
export interface HostStoreFormats {
  readonly chatDb: number;
}

/**
 * A host without a per-epic chat store. Ordered below every real stamp on
 * purpose: a target that reads no `chat.db` is blocked by any `chat.db` at all.
 */
export const NO_CHAT_STORE = 0;

/**
 * Whether a value is a usable store-format version.
 *
 * One predicate for every boundary that admits a format number from outside
 * this process - the registry manifest's `storeFormats.chatDb`, an archive's
 * runtime `version.json`, a `chat_db_meta` row. They had the same three-clause
 * check written out separately, which is exactly the kind of duplication that
 * drifts one clause at a time.
 *
 * What each boundary does with a `false` stays its own business, and they
 * deliberately differ: the manifest parser throws (a malformed published entry
 * is a release-tooling bug), an archive declaration warns and degrades to
 * "undeclared" (a typo must not brick a local install), and a store row
 * becomes a finite failure code. Only the PREDICATE is shared.
 */
export function isValidStoreFormatVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

interface ChatDbFormatEra {
  /** First host version, inclusive, that writes `chatDb`. */
  readonly from: string;
  readonly chatDb: number;
}

/**
 * Read off `CHAT_DB_SCHEMA_VERSION` at each tag. Ascending; a version belongs
 * to the last era whose `from` it is not below.
 *
 * | tag(s)                          | stamp |
 * | ------------------------------- | ----- |
 * | every host through 1.1.x        | none  |
 * | 1.2.0-rc.1                      | 7     |
 * | 1.2.0-rc.2, 1.2.0-rc.3, 1.2.0   | 8     |
 * | 1.3.0-rc.1 … 1.3.0-rc.4         | 9     |
 */
const CHAT_DB_FORMAT_ERAS: readonly ChatDbFormatEra[] = [
  { from: "0.0.0", chatDb: NO_CHAT_STORE },
  { from: "1.2.0-rc.1", chatDb: 7 },
  { from: "1.2.0-rc.2", chatDb: 8 },
  { from: "1.3.0-rc.1", chatDb: 9 },
];

/**
 * The newest host version the fixed table vouches for. Every release after it
 * publishes `storeFormats` on its manifest entry, so the table is never
 * extended - a version above this line without the field is unknown.
 */
export const CHAT_DB_FORMAT_TABLE_CEILING = "1.3.0-rc.4";

export type HostStoreFormatsKnowledge =
  | { readonly kind: "known"; readonly formats: HostStoreFormats }
  | {
      readonly kind: "unknown";
      /**
       * `above-table-ceiling`: a release the table predates, whose manifest
       * entry did not publish the field. `not-a-released-version`: not on the
       * release ladder at all - a `<target>.<epochMs>.<sha>` or `local-*`
       * stamp, or {@link SOURCE_TREE_HOST_VERSION}.
       */
      readonly reason: "above-table-ceiling" | "not-a-released-version";
    };

/**
 * Whether a host version is one the release ladder can place: valid SemVer
 * and not the source-tree sentinel.
 */
export function isReleasedHostVersion(hostVersion: string): boolean {
  return (
    hostVersion !== SOURCE_TREE_HOST_VERSION && isValidHostVersion(hostVersion)
  );
}

/**
 * What the fixed table says a host version writes.
 *
 * Unknown for a version the table does not cover: above the ceiling, or not a
 * released version at all. Callers that hold a manifest entry or an archive's
 * own declaration should go through {@link resolveHostStoreFormats} instead,
 * which consults the declared field first.
 */
export function storeFormatsFromReleasedTable(
  hostVersion: string,
): HostStoreFormatsKnowledge {
  const aboveCeiling = compareHostVersions(
    hostVersion,
    CHAT_DB_FORMAT_TABLE_CEILING,
  );
  if (hostVersion === SOURCE_TREE_HOST_VERSION || !aboveCeiling.comparable) {
    return { kind: "unknown", reason: "not-a-released-version" };
  }
  if (aboveCeiling.ordering === "greater") {
    return { kind: "unknown", reason: "above-table-ceiling" };
  }
  let formats: HostStoreFormats = { chatDb: NO_CHAT_STORE };
  for (const era of CHAT_DB_FORMAT_ERAS) {
    const relation = compareHostVersions(hostVersion, era.from);
    // Every `from` is valid SemVer and `hostVersion` compared above, so this
    // is always comparable; the guard only keeps the type honest.
    if (!relation.comparable || relation.ordering === "less") break;
    formats = { chatDb: era.chatDb };
  }
  return { kind: "known", formats };
}

/**
 * The store formats a target host writes: the declared field when one is held
 * (the manifest entry's `storeFormats`, or the archive's own runtime
 * `version.json`), else the fixed table.
 */
export function resolveHostStoreFormats(
  hostVersion: string,
  published: HostStoreFormats | null,
): HostStoreFormatsKnowledge {
  if (published !== null) return { kind: "known", formats: published };
  return storeFormatsFromReleasedTable(hostVersion);
}

export type StoreFloorApplicability =
  | { readonly applies: true }
  | {
      readonly applies: false;
      /**
       * `target-not-older`: the move is an upgrade or a same-version
       * reinstall. `target-off-ladder`: the target is not a released version
       * and declares no formats, so the floor has nothing to judge it by.
       */
      readonly reason: "target-not-older" | "target-off-ladder";
    };

/**
 * Whether landing `targetVersion` over `installedVersion` has to consult the
 * store floor at all.
 *
 * Only a move to an OLDER build can leave data unreadable, so the floor is
 * skipped entirely - no table lookup, no disk walk - for exactly two moves:
 * the target version string is IDENTICAL to the installed one, or it is
 * STRICTLY newer by SemVer precedence.
 *
 * Equal precedence with a different string is not one of them. SemVer ignores
 * build metadata, so `2.0.0+old` over `2.0.0+new` compares equal while being a
 * different artifact - and the install path already classifies that as a
 * sideways downgrade needing `--allow-downgrade`. Standing aside there let the
 * one move a user was warned about skip the check meant to protect it.
 *
 * That shortcut is available only when the INSTALLED version is itself a
 * released one, because it is an argument about the ladder and only a ladder
 * version has a place on it. `null` (nothing installed), a stamp that cannot
 * be compared (`<target>.<epochMs>.<sha>`), and {@link
 * SOURCE_TREE_HOST_VERSION} all evaluate instead. The sentinel is the one that
 * has to be named: it parses as SemVer and sorts below every release, so
 * ordering alone would call `1.2.0` an UPGRADE over it and skip the floor -
 * while a build of today's source writes format 9. Nothing about `0.0.0-dev`
 * describes what it wrote, which is the same reason
 * {@link storeFormatsFromReleasedTable} refuses to place it.
 *
 * A target that is not a released version is judged only by what it DECLARES
 * (`targetDeclaredFormats`, from the archive's runtime `version.json`). With a
 * declaration it evaluates like any other target. Without one the floor does
 * not apply: refusing would stop every local desktop build from converging its
 * own host, and the fixed table has no line that could ever clear it. The
 * caller should log that it stood aside; it must not read it as `clear`.
 */
export function storeFloorApplicability(
  targetVersion: string,
  installedVersion: string | null,
  targetDeclaredFormats: HostStoreFormats | null,
): StoreFloorApplicability {
  if (!isReleasedHostVersion(targetVersion) && targetDeclaredFormats === null) {
    return { applies: false, reason: "target-off-ladder" };
  }
  if (installedVersion === null || !isReleasedHostVersion(installedVersion)) {
    return { applies: true };
  }
  // The SAME BUILD, by string. A reinstall of the identical version cannot
  // move the store format, and this is the only equality that means identity:
  // SemVer precedence ignores build metadata, so `2.0.0+a` and `2.0.0+b`
  // compare EQUAL while being different artifacts with possibly different
  // formats. Treating that as "not older" is what let a sideways move - one
  // the install path itself classifies as a downgrade needing
  // `--allow-downgrade` - skip the floor entirely.
  //
  // This arm is reachable ONLY for a released version, and deliberately so: an
  // identical string means both sides are the same string, and the guard above
  // has already sent every unreleased installed version to the floor. So
  // `0.0.0-dev` over `0.0.0-dev`, and a repeated `<target>.<epochMs>.<sha>`,
  // both EVALUATE - which is the behaviour that matters for the team's daily
  // local rebuilds, where two builds share a string and can differ in format.
  // Do not "tighten" this by adding an `isReleasedHostVersion(targetVersion)`
  // test: it would be unreachable, and it would suggest the guarantee lives
  // here rather than in the guard that actually provides it.
  if (targetVersion === installedVersion) {
    return { applies: false, reason: "target-not-older" };
  }
  const relation = compareHostVersions(targetVersion, installedVersion);
  // STRICTLY newer, and comparable. Everything else evaluates: older,
  // incomparable, and equal-precedence-different-identity alike. None of those
  // proves the target can read what the installed build wrote.
  if (relation.comparable && relation.ordering === "greater") {
    return { applies: false, reason: "target-not-older" };
  }
  return { applies: true };
}

/**
 * Whether the target can be cleared from formats alone, without reading any
 * file.
 *
 * True when both sides are known and the target writes a stamp at least as
 * new as the installed build's: nothing the installed build could have written
 * is unreadable by the target. The one case this reads past is a directory a
 * NEWER build than the installed one wrote before being forced below the floor
 * - those files are already unreadable by the installed build, so the move
 * loses nothing that was not lost already.
 */
export function storeFloorClearedByFormats(
  target: HostStoreFormatsKnowledge,
  installed: HostStoreFormatsKnowledge | null,
): boolean {
  if (target.kind !== "known" || installed === null) return false;
  if (installed.kind !== "known") return false;
  return target.formats.chatDb >= installed.formats.chatDb;
}

/** One epic's chat store, as stamped. */
export interface ChatDbStampReading {
  readonly epicId: string;
  readonly schemaVersion: number;
}

/**
 * Why one epic's chat store could not be read.
 *
 * A CLOSED set, and closed is the point. These values travel into a human
 * refusal, an NDJSON error envelope, the host's ledger and the CLI's
 * diagnostic; the free-form strings they replaced came from a corrupt database
 * row and from SQLite/OS error text - unbounded in length and unrestricted in
 * charset, which in a log line is a forged-line vector as much as a size one.
 * A code can be neither. What a code costs is the specific errno, and the
 * remedy for every one of these is the same: look at the named epic's file.
 *
 * Both producers emit from this set - the CLI's pre-install survey
 * (`chat-store-survey.ts`) and the host's ledger
 * (`chat-store-format-ledger.ts`) - so a new failure mode is added HERE and
 * the two ends stay comparable.
 */
export type ChatDbStampFailureReason =
  /** The epic directory, or the `chat` directory inside it, is a symlink. */
  | "linked-epic-directory"
  | "linked-chat-directory"
  /**
   * The epic directory, or the `chat` directory inside it, exists but is not
   * a directory, so the store behind it cannot be located, let alone read.
   */
  | "epic-state-not-a-directory"
  | "chat-directory-not-a-directory"
  /** The root holding the per-epic directories could not be enumerated. */
  | "unreadable-epic-state-directory"
  /** `chat.db` exists but is not a regular file. */
  | "chat-db-not-a-file"
  /** Opened, but no `chat_db_meta` row names a usable positive integer. */
  | "missing-or-invalid-schema-version"
  /** Could not be opened or queried: corrupt, locked, or access-denied. */
  | "unreadable-chat-db"
  /**
   * No SQLite engine at all in the RUNTIME running the survey, so nothing on
   * disk was examined. Distinct from `unreadable-chat-db` because it says
   * nothing about the user's files, and a refusal that blamed them would be a
   * lie: the CLI runs under `bun` in the repo's own dev loop and under Node in
   * the released binary, and only one of those has `node:sqlite`.
   */
  | "engine-unavailable"
  /** The survey did not complete; the caller could not attribute a cause. */
  | "survey-failed";

/** One epic's chat store that could not be read. */
export interface ChatDbStampFailure {
  readonly epicId: string;
  readonly reason: ChatDbStampFailureReason;
}

/**
 * The result of walking a data root for chat stores. Readings and failures
 * are disjoint by epic; an epic with no `chat.db` appears in neither.
 */
export interface ChatDbStampSurvey {
  readonly readings: readonly ChatDbStampReading[];
  readonly failures: readonly ChatDbStampFailure[];
}

export type StoreFormatFloorVerdict =
  | { readonly kind: "clear" }
  | {
      /** Epics whose store the target cannot open, with the stamp each carries. */
      readonly kind: "blocked";
      readonly targetChatDb: number;
      readonly epics: readonly ChatDbStampReading[];
      /**
       * Stores the survey could not read at all, carried alongside the proven
       * ones rather than dropped.
       *
       * `blocked` outranks `indeterminate` because naming the proven-newer
       * epics is the more useful refusal - but "more useful" is not "the whole
       * truth". An unreadable store is still a store whose fate this verdict
       * cannot speak for, and a refusal that listed only the proven ones would
       * under-report what the user is about to lose, in the one direction that
       * matters. Every renderer that shows a blocked verdict shows these too.
       */
      readonly failures: readonly ChatDbStampFailure[];
    }
  | {
      /**
       * The survey could not prove the move safe. Refused exactly like
       * `blocked`: an unreadable file is not evidence that it is readable.
       */
      readonly kind: "indeterminate";
      readonly reason: "target-format-unknown" | "unreadable-stores";
      readonly failures: readonly ChatDbStampFailure[];
    };

/**
 * The floor verdict for a target, given a survey of the data root.
 *
 * `blocked` outranks `indeterminate`: when readable stores already prove the
 * move loses data, naming them is the more useful refusal, and the unreadable
 * ones are still listed. Only a survey with every store readable and every
 * stamp at or below the target's format is `clear`.
 *
 * An EMPTY survey - no store read, none failed - is `clear` whatever is known
 * about the target: there is nothing on the machine the target could fail to
 * open, so an unknown target format protects nothing there. A survey that
 * failed to enumerate at all must report that as a failure, not as emptiness.
 */
export function decideStoreFormatFloor(
  target: HostStoreFormatsKnowledge,
  survey: ChatDbStampSurvey,
): StoreFormatFloorVerdict {
  if (survey.readings.length === 0 && survey.failures.length === 0) {
    return { kind: "clear" };
  }
  if (target.kind === "unknown") {
    return {
      kind: "indeterminate",
      reason: "target-format-unknown",
      failures: survey.failures,
    };
  }
  const targetChatDb = target.formats.chatDb;
  const epics = survey.readings.filter(
    (reading) => reading.schemaVersion > targetChatDb,
  );
  if (epics.length > 0) {
    return {
      kind: "blocked",
      targetChatDb,
      epics,
      failures: survey.failures,
    };
  }
  if (survey.failures.length > 0) {
    return {
      kind: "indeterminate",
      reason: "unreadable-stores",
      failures: survey.failures,
    };
  }
  return { kind: "clear" };
}

/**
 * Fatal close code for a stream whose backing store was written by a NEWER
 * host build than the one serving it.
 *
 * Distinct from `INCOMPATIBLE` (a method-version mismatch between two live
 * peers) because the remedy is different: nothing about the client is wrong,
 * and no reconnect can help - only a host update, or a demotion of the data,
 * resolves it. The host sends `upgradeGuidance: { hostShouldUpgrade: true,
 * clientShouldUpgrade: false }` alongside so surfaces that already render
 * version skew can reuse that copy.
 */
export const HOST_OLDER_THAN_DATA_FATAL_CODE = "HOST_OLDER_THAN_DATA";
