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
 * ## COMPAT: the `shard` level does not survive re-publication
 *
 * Residual capture makes a newer minor's unmodeled fields survive an older
 * READER. It does not, at the `shard` level, make them survive an older
 * READER THAT RE-PUBLISHES - and a clone target is exactly that.
 *
 * Assembly folds a publication's shards into one chat and retains only the
 * HEAD's residual, so a shard record's own top-level bag never reaches a
 * caller at all. That is not an oversight to fix: cohort boundaries are a
 * deterministic re-cut over the CURRENT projection, so a clone re-shards from
 * its own state and the source's shards do not exist on the other side. There
 * is no coherent object left to attach a per-shard bag to.
 *
 * The rule that follows, and it binds every SAME-MAJOR minor of `chat-shard`:
 *
 * > A minor may add a top-level `chat-shard` field for a reader to display or
 * > a writer to emit. It must NOT put load-bearing CHAT-LEVEL data there -
 * > anything the chat is still true without on the other side of a clone.
 * > Durable additions go head-level (one per publication, carried) or
 * > message-level (inside the entries, which assembly concatenates).
 *
 * The distinction is between per-PUBLICATION bookkeeping, which is what the
 * shard record is for and which a re-publication legitimately re-derives, and
 * chat state, which the shard record is the wrong home for at any minor.
 *
 * A same-major minor that gets this wrong loses data silently: an older client
 * clones the chat, the field is simply absent from the re-published shards, and
 * nothing anywhere reports a loss. Nothing downstream can report it either,
 * which is why the rule has to be stated here rather than enforced there: a
 * shard bag never reaches a re-publishing reader at all, so the difference
 * between "we chose not to carry it" and "it never reached us" is invisible on
 * the other side.
 *
 * The completeness guard below is what makes the level list itself
 * non-optional, and it does bind across the package boundary: a consumer holds
 * an exhaustive `Record<CapturedResidualLevelId, …>` deciding what each level
 * carries, so adding a level here is a compile error there until somebody
 * answers for it. (The Traycer host's chat-sync record adapter is that
 * consumer today; named as a role rather than a symbol, since it lives in a
 * different repository and this file must not depend on it.)
 *
 * `hostPrivate` under a GRADUATED shard is not an exception to this: it is one
 * schema instance and one level, and a clone blanks it deliberately (origin-host
 * session state must not follow a chat onto a new machine).
 *
 * ## The deliberate boundary: publisher-DERIVED levels carry no bag, ever
 *
 * The list below is not the set of levels that happen to have capture wired
 * up; it is the set of levels a chat's durable data may live at. Three head
 * locations are deliberately absent and must stay absent:
 *
 * - the head's part entries (`chatHeadPartSchema` elements),
 * - `cdc`,
 * - `hostPrivateShard`.
 *
 * These are PUBLISHER-DERIVED: a chat is single-owner, and the owner can always
 * re-cut its parts and re-plan its cut from its own op log, which is the source
 * of truth. **The only round-trip any of these values makes is through the
 * owner's own predecessor head** - the extend road re-emits unchanged cohort
 * entries verbatim and reads `cdc` back to check the plan is still the same
 * one, so they are not literally re-derived on every publish; they are
 * re-derivable, and derived afresh on every full recut.
 *
 * That is what bounds the loss. The one scenario is a same-host downgrade: the
 * newer part fields strip on the older host's next publish, and the following
 * newer publish does a full recut instead of an incremental one. An efficiency
 * cost, never data loss.
 *
 * > A minor may add a publisher-derived field for the next publish to plan
 * > with. It must NOT put durable CHAT data there. Anything the chat is not
 * > still true without goes at a captured level below, or inside a message /
 * > event body.
 *
 * Wiring capture here would cost a manifest id, a store op field, and an
 * encoder change per level, and a part-level key perturbs the head bytes the
 * lineage digest is taken over. Deliberately rejected in favour of the rule.
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
