/**
 * The manifest of residual-capture levels across both chat-sync records.
 *
 * Residual capture (`residual.ts`) is what makes a newer minor's unmodeled
 * FIELDS survive an older reader. That only holds end to end if every capture
 * site is known: a level added without an entry here is a level no consumer
 * knows to carry, and `chat-sync-captured-levels.test.ts` fails until it is
 * listed.
 *
 * ## Ids are contracts
 *
 * An id is a CONTRACT, not a label. Renaming a level is safe - the union is
 * typed, so every consumer breaks loudly. What is NOT safe is **reusing an id
 * with changed semantics**: a consumer that special-cases `hostPrivate` (a
 * clone importer must blank exactly that bag, because origin-host envelope
 * state must not follow a chat onto a new host) would keep pointing at the
 * wrong data, silently. A semantic change gets a NEW id plus a ritual entry.
 *
 * The declared-key table below is what pins that: a restructure fails here
 * rather than in a clone.
 *
 * ## Why there are no extract/replace accessors yet
 *
 * The v1 design carried typed accessors per level so a host could persist
 * decoded bags and restore them on rebuild. No v2 consumer does that yet - the
 * host serializes shards straight from its pinned projection - so the accessors
 * would be untested surface. The completeness guard is the part that has to
 * exist now, because it is what makes adding a level non-optional; accessors
 * are a cheap addition when a caller needs them.
 */
export type CapturedResidualLevelId =
  | "head"
  | "shard"
  | "core"
  | "core.lifecycle"
  | "core.settings"
  | "hostPrivate";

export type CapturedResidualLevel = {
  readonly id: CapturedResidualLevelId;
  /**
   * Property path from the record root that owns the level; `[]` is the record
   * itself. `hostPrivate` sits under a head AND under a graduated shard - one
   * schema instance, one level - so its path is stated relative to whichever
   * record carries it.
   */
  readonly path: readonly string[];
};

export const CAPTURED_RESIDUAL_LEVELS: readonly CapturedResidualLevel[] = [
  { id: "head", path: [] },
  { id: "shard", path: [] },
  { id: "core", path: ["core"] },
  { id: "core.lifecycle", path: ["core", "lifecycle"] },
  { id: "core.settings", path: ["core", "settings"] },
  { id: "hostPrivate", path: ["hostPrivate"] },
];
