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
 * Only a move to an OLDER build can leave data unreadable, so an upgrade or a
 * same-version reinstall skips the floor entirely - no table lookup, no disk
 * walk. `null` (nothing installed) and an installed version that cannot be
 * compared (a `<target>.<epochMs>.<sha>` local install) both evaluate: neither
 * proves the move is an upgrade, and the survey is ground truth regardless of
 * what wrote the files.
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
  if (installedVersion === null) return { applies: true };
  const relation = compareHostVersions(targetVersion, installedVersion);
  if (!relation.comparable || relation.ordering === "less") {
    return { applies: true };
  }
  return { applies: false, reason: "target-not-older" };
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

/** One epic's chat store that could not be read. */
export interface ChatDbStampFailure {
  readonly epicId: string;
  readonly reason: string;
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
  if (epics.length > 0) return { kind: "blocked", targetChatDb, epics };
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
