import { z } from "zod";

/**
 * Project a live value onto a FROZEN line's schema by dropping the array
 * members that line cannot represent, instead of letting the nearest `.catch()`
 * discard everything around them.
 *
 * WHY THIS EXISTS. A downgrade bridge reparses the live response through the
 * frozen schema of the line it is serving. That reparse is the freeze doing its
 * job for an added KEY - a non-strict `z.object` strips it. It is the opposite
 * of its job for an added ENUM MEMBER: `z.array(enum)` rejects the WHOLE array
 * over one unknown element, the object holding it fails with it, and the
 * nearest `.catch()` then serves its default.
 *
 * The blast radius is not local. Measured over `providers.list@7.0`, 30 enum
 * leaves sit inside an array and 27 of them share ONE catch scope -
 * `providers[].nativeCapabilities`, a whole-object `.catch(DEFAULT)` - so a
 * single new settings tab costs a 7.0 peer its MCP, Plugins AND Skills tabs
 * together.
 *
 * TWELVE of the 63 enum leaves on that row have no `.catch()` between them and
 * the root at all, where growth fails the entire `providers.list` response
 * rather than degrading part of it. Four are on the row itself
 * (`providers[].providerId`, `candidates[].kind`, `apiKey.source`,
 * `auth.status`) and eight are under `native`. Nine of the twelve sit under an
 * array and are therefore repairable HERE - dropping the element keeps the
 * call alive. The other three are scalars nothing can rescue by dropping, and
 * they are the sharp ones, because a pin cannot help them either:
 *
 *   native|0|3.server.status         native|0|3.server.statusSource
 *   native|1.code
 *
 * Those three want a `.catch()`; the nine want a pin plus this walk. Note in
 * particular that `native|0|3.server.tools[].denySources[]` IS one of the nine:
 * arm 3 is `{kind:"mcpDiscover", server: <the same schema servers[] arrays>}`,
 * so `server` not itself being in an array is irrelevant - `denySources` is
 * `z.array(enum)` nested inside `tools[]`, and dropping a member rescues it
 * exactly as it does on the `servers[]` arm. An earlier revision of this file
 * said that leaf needed a `.catch()`; that was wrong, and wrong in the
 * direction that would have sent the next person to fix it in the wrong place.
 *
 * WHAT ARMS THIS, AND WHAT IS DORMANT. The host parses the resolver result
 * against the CANONICAL (head) schema and fails the call before any downgrade
 * runs (`traycer-host`'s `handler.ts`, `canonicalResultParse`). So a value only
 * reaches this projection if the head ALREADY accepted it - and where a frozen
 * row binds the same enum OBJECT as the head, it accepts exactly what the head
 * accepts and this walk drops nothing. Only a leaf pinned STRICTLY NARROWER
 * than the head is ever acted on.
 *
 * Today that is two leaves, both on 7.0/8.0 and both the provider id enum:
 * `providerId` (a scalar, so the row drops exactly as it always did) and
 * `managedVersions.sharedWithProviders[]`. That second one is the only field
 * this changes in production right now, and it is a real change - a pack shared
 * with a provider the line predates currently costs a peer the ids it DID know.
 * Everything else here is a mechanism waiting on its pin: the four pins that
 * landed with it are byte-identical to live by design, so they arm the day the
 * live enum moves and not before. `__tests__/frozen-line-projection.test.ts`
 * asserts that set rather than leaving it to a reader to assume.
 *
 * None of this is new knowledge. `provider-native-schemas.ts` carries the
 * finding verbatim - "FILTER `supportedTabs` before the parse; never reparse
 * it ... the peer loses MCP, Plugins AND Skills over a single tab id it never
 * knew. This is the trap every closed enum above is copied to avoid" - written
 * when `projectNativeCapabilitiesToV70Preimage` was deleted, alongside the note
 * that whoever reopens the line "has to make them again". v8.0, v9.0, v9.1 and
 * v9.2 all opened since; the projection never came back. This is it, general
 * rather than per-field, because 30 leaves is too many to enumerate by hand and
 * enumerating a sample is how the last freeze came up short.
 *
 * WHAT IT DOES. Exactly one rule, applied recursively: **an array keeps the
 * elements that survive the frozen schema, and drops the ones that do not.**
 * That is not a new policy - it is the rule `downgradeProviderCliStateListToV70`
 * already applies to the provider list itself (`flatMap` over rows, dropping
 * any row the frozen state rejects), pushed down the whole tree so a nested
 * array degrades the way the top-level one always has.
 *
 * Dropping beats not dropping wherever the array is a plain list, because the
 * peer's OWN compiled copy of this frozen schema rejects the same element:
 * without the projection it discards the element's whole catch scope, and with
 * it the peer receives bytes it can parse. It is NOT better where an emptied
 * array would read as a claim rather than a gap, which is why the array case
 * carries the exception it does. And it is the only half of the freeze that can
 * change what a peer receives at all - a pin alone moves WHERE the collapse
 * happens, not WHETHER it happens, since the peer re-rejects the same bytes.
 *
 * WHAT IT DOES NOT DO. A scalar enum has no member to drop, so an unknown
 * scalar still fails its object and still hits the nearest `.catch()` - or, on
 * a provider row, still drops that row, which is exactly how a post-vN provider
 * id stays off an already-shipped wire. That is unchanged behaviour and
 * deliberately so: the alternative is inventing a substitute value, and a
 * downgrade bridge that fabricates wire content is worse than one that
 * degrades.
 *
 * It also does not reach every caller. This runs inside the MAJOR-version
 * downgrade bridges, so it covers 7.0 and 8.0 callers. A caller on the
 * canonical major but an older MINOR - 9.0 against a 9.1 canonical, or either
 * against a future 9.2 - takes a different path in `traycer-host`'s
 * `handler.ts`: `downgradeCanonicalToCaller` returns the canonical value
 * untouched for a matching major, and `projectResponseWithinMajor` has no
 * `providers.list` entry, so the value goes straight to the caller row's
 * `safeParse`. Enum growth there degrades or 500s exactly as it did before.
 * Wiring that up means a `providers.list` case in `projectResponseWithinMajor`
 * keyed on the caller's minor; it is deliberately not in this change, because
 * that seam's own comment records how a projection written for one minor
 * silently captured the next one, and getting it wrong there costs more than
 * the gap does.
 *
 * WHY IT WALKS THE SCHEMA rather than reading parse errors. The obvious
 * implementation - parse, then delete whatever the issues point at - cannot
 * work here, and the reason is the whole problem in miniature: `.catch()` makes
 * the parse SUCCEED. `sharedWithProviders` is `z.array(providerId).catch([])`,
 * so a list containing one unknown id reports no issue at all and silently
 * yields `[]`. The leaves worth repairing are precisely the ones whose failure
 * is already being swallowed, so the repair has to look THROUGH the catch, not
 * at what the catch reports.
 */

/**
 * A schema's definition, widened with the child-schema fields zod puts on the
 * specific node kinds. `_zod.def` is public API typed as `$ZodTypeDef`, which
 * carries the discriminating `type` but not the children, so this states the
 * children as OPTIONAL - every read below is guarded, and a node kind that does
 * not have the field simply reads `undefined` rather than being asserted away.
 */
type ZodNodeDef = z.core.$ZodTypeDef & {
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly options?: readonly z.ZodType[];
};

function nodeOf(schema: z.ZodType): ZodNodeDef {
  return schema._zod.def;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Total array elements anywhere in a value. Used only to choose between union
 * arms that both accept a projection - it is a "how much survived" score, not a
 * validity check, so it counts elements rather than weighing them.
 */
function countArrayElements(value: unknown): number {
  if (Array.isArray(value)) {
    let total = value.length;
    for (const entry of value) total += countArrayElements(entry);
    return total;
  }
  if (isPlainRecord(value)) {
    let total = 0;
    for (const entry of Object.values(value))
      total += countArrayElements(entry);
    return total;
  }
  return 0;
}

/**
 * Project `value` onto `schema`. Returns `value` BY IDENTITY when nothing had
 * to change, so a caller can tell the two cases apart by reference and an
 * undrifted payload is handed on untouched rather than rebuilt.
 *
 * Identity is about the RESULT, not about the work. Every object and record
 * node allocates a `{ ...value }` on the way down and discards it when no child
 * moved, and the union case runs TWO `safeParse` calls per candidate arm - one
 * on the arm to decide candidacy, one on the whole union to score it - which is
 * where the cost actually is. That is 2N top-level parses for an N-arm union,
 * not N+1, and each union parse internally re-tries arms, so the arm-level work
 * is nearer N + N^2. Measured on a 3-arm union: 3 arm parses, 3 union parses.
 *
 * So this is not free. On a `providers.list` payload both the head and the 7.0
 * row accept - 8 rows with full `nativeCapabilities`, plus a native MCP result
 * of 6 servers x 8 tools, on which the walk returns identity - the walk costs
 * about 3x the frozen parse it precedes and the combined call about 4x a bare
 * parse. Those RATIOS held across runtimes; the absolute did not, so it is
 * worth naming: ~0.12 ms under vitest's Node workers (parse ~0.029 ms) and
 * ~0.17 ms under Bun directly (parse ~0.041 ms). An earlier revision claimed
 * 2.5x/3x from a run with too little warm-up.
 *
 * Bounded work on a response already parsed twice over (here and again by the
 * peer), and it buys the tabs a `.catch()` would otherwise drop - but state it
 * as a multiple, and never as "free".
 *
 * One structural note for whoever profiles this next: on a 9->7 downgrade each
 * row is walked twice and fully parsed four times over (the live enabled-
 * profiles pre-pass, the row helper's `safeParse`, this walk's per-element
 * `safeParse` on `providers[]`, and the final frozen parse), plus the handler's
 * own caller-side parse. `parseProvidersListResponseForFrozenLine` re-walks
 * rows that `projectRowsOntoFrozenLine` already handled. That redundancy is
 * known and deliberate for now - each parse has a different owner and merging
 * them would couple the row helper to the response helper - but it is the first
 * place to look if this ever shows up in a profile.
 */
function project(schema: z.ZodType, value: unknown): unknown {
  const def = nodeOf(schema);

  switch (def.type) {
    // Look THROUGH a catch: its default is what we are trying not to serve.
    case "catch": {
      return def.innerType ? project(def.innerType, value) : value;
    }
    // Wrappers that legitimately admit an absent value. Only recurse when the
    // value is actually present, so `undefined`/`null` stay themselves.
    case "optional":
    case "nullable":
    case "default":
    case "nonoptional":
    case "readonly": {
      if (value === null || value === undefined) return value;
      return def.innerType ? project(def.innerType, value) : value;
    }
    // NOTE for `object` and `record` below: both deliberately visit only the
    // declared children - an object's `shape`, a record's `valueType`. An
    // object's `catchall` and a record's `keyType` are NOT walked, and that is
    // a scope decision rather than an oversight. The rule here is "an array
    // keeps the elements that survive"; a record key or a catchall-typed value
    // is not an array member, so dropping one would be a SECOND rule needing
    // its own never-empty exception. Skipping them leaves the enclosing object
    // to fail into its nearest `.catch()` - the behaviour that already shipped.
    //
    // The guard test makes the opposite choice and walks both, because the two
    // have opposite failure modes: a walk that silently skips a child makes the
    // guard's completeness claim VACUOUSLY TRUE, whereas skipping one here just
    // declines to repair something. Both of the guard's holes were found that
    // way, so the asymmetry is load-bearing and not an inconsistency.
    case "object": {
      const shape = def.shape;
      if (!shape || !isPlainRecord(value)) return value;
      let changed = false;
      const out: Record<string, unknown> = { ...value };
      for (const [key, child] of Object.entries(shape)) {
        if (!(key in value)) continue;
        const projected = project(child, value[key]);
        if (projected !== value[key]) {
          out[key] = projected;
          changed = true;
        }
      }
      return changed ? out : value;
    }
    case "array": {
      const element = def.element;
      if (!element || !Array.isArray(value)) return value;
      const kept: unknown[] = [];
      let changed = false;
      for (const entry of value) {
        const projected = project(element, entry);
        if (projected !== entry) changed = true;
        // THE RULE: an element the frozen line cannot represent is dropped,
        // rather than taking the array - and whatever the array is nested in -
        // down with it.
        if (element.safeParse(projected).success) kept.push(projected);
        else changed = true;
      }
      // ...WITH ONE EXCEPTION: never empty a non-empty array. For several
      // fields `[]` is a POSITIVE assertion, not an absence, and the two are
      // read differently downstream - `profiles[].rateLimitLimitedScopes` is
      // the sharp one, where `null` means "could not read, fall back to
      // `rateLimitStatus`" and `[]` means "read fine, nothing is limited"
      // (`rate-limit-scope-match.ts` implements exactly that split). Emptying
      // it would turn "this model is rate limited" into "not limited", which is
      // a confident wrong answer; letting the enclosing `.catch()` serve its
      // default says "unknown" instead. Degrading to unknown is allowed;
      // fabricating a positive claim is not.
      //
      // TWO HONEST LIMITS on that reasoning, both dormant today and both worth
      // stating rather than discovering later:
      //
      //   1. It is emptiness-shaped where the hazard is field-shaped. That same
      //      consumer filters by model family and THEN tests `length === 0`, so
      //      dropping the one scope that gated the selected model produces the
      //      identical false "not limited" without ever emptying the array.
      //      This rule does not cover that; only pinning the severity enum and
      //      refusing to drop from THIS field would. `severity` is unpinned, so
      //      nothing reaches it yet.
      //   2. It fires on EVERY array, including ones with no enclosing
      //      `.catch()` at all - and `native` has none on any of the four
      //      response schemas. There, restoring the original means the whole
      //      response fails where an emptied array would at least have
      //      delivered something parseable. That is the one place the stated
      //      rationale ("let the catch say unknown") has no catch to appeal to.
      if (kept.length === 0 && value.length > 0) return value;
      return changed ? kept : value;
    }
    case "union": {
      const options = def.options;
      if (!options) return value;
      // An arm becomes a candidate only by PARSING, never by being first - but
      // parsing is not enough to CHOOSE between two candidates, and "first that
      // parses" is both order-dependent and lossy. Where two arms overlap, an
      // earlier one can accept the value after dropping members a later one
      // would have kept, and nothing downstream could tell a better answer
      // existed.
      //
      // So: every arm that parses becomes a candidate, and the one whose
      // projection SURVIVES THE UNION best wins - measured by array elements
      // retained, with the unrepaired value preferred on a tie.
      //
      // ARM ORDER STILL DECIDES THE ANSWER, and deliberately so. An earlier
      // revision of this comment claimed the opposite - that the result was
      // order-independent because "arm order is an authoring detail of the
      // frozen schema rather than a statement about the wire". That is exactly
      // backwards: the caller re-parses through this union, a union resolves
      // first-match-wins, so arm order IS a statement about the wire and the
      // scoring below has to honour it rather than pretend it away. Reordering
      // the arms legitimately changes what the peer receives:
      //
      //   [armA, armB] -> {"items":["a","b"]}
      //   [armB, armA] -> {"items":["a"],"extra":["x","x","x"]}
      //
      // Both are correct answers for their own schema; neither is this walk
      // being unstable.
      //
      // Of the eleven union nodes these rows reach, ten are discriminated. The
      // eleventh is `nativeListResultSchema`, a plain `z.union` whose arms are
      // separated by `ok: z.literal(true|false)` - mutually exclusive in fact,
      // but not by construction, which is exactly why the choice here does not
      // rest on "they are all discriminated".
      let best: unknown = null;
      let bestRetained = -1;
      for (const arm of options) {
        const projected = project(arm, value);
        if (!arm.safeParse(projected).success) continue;
        // Score what the UNION yields for this projection, not what the ARM
        // alone would. The caller re-parses the finished value through this
        // same union, and a union resolves FIRST-MATCH-WINS in declaration
        // order - so an arm can win the score and then hand its value to an
        // EARLIER arm that keeps less. Scoring `arm.safeParse(...)` was wrong
        // for exactly the overlap this branch exists to handle:
        //
        //   armA = { items: array(enum["a","b"]) }                 (first)
        //   armB = { items: array(enum["a"]), extra: array(...) }  (second)
        //   value = { items: ["a","b","c"], extra: ["x","x","x"] }
        //
        // armB scored 4 against armA's 2 and won, but the caller's parse then
        // matched armA and delivered `{items:["a"]}` - one element, where
        // armA's own projection would have delivered `{items:["a","b"]}`. The
        // scoring actively chose the worse answer. Scoring the union's own
        // resolution is the only measure that matches what the peer receives.
        const resolved = schema.safeParse(projected);
        // `-1` is reachable, not dead: a union can carry its OWN `.refine()` /
        // `.superRefine()` - `def.type` stays `"union"` and `def.checks` is
        // non-empty - so an arm can accept while the union rejects. Scoring it
        // below every real candidate is right, because `schema.safeParse` IS
        // the test for whether a repair helps: -1 everywhere means no candidate
        // satisfies the union at all, and the fallback returns `value`. No
        // union on these five response schemas is refined today, so this is a
        // guard rather than a live branch - do not "simplify" it away.
        const retained = resolved.success
          ? countArrayElements(resolved.data)
          : -1;
        // An arm needing NO repair gets no special standing - it COMPETES. An
        // earlier revision short-circuited on `projected === value` ("identity
        // means the value already belongs to this arm"), which is the very
        // reasoning the scoring fix above disproved: belonging to SOME arm says
        // nothing about what first-match resolution of the UNREPAIRED value
        // retains. It threw away a better candidate the loop had already built:
        //
        //   armP (first)  = { items: array(enum["a"]), extra: array(enum["x"]) }
        //   armQ (second) = { items: array(enum["a","b"]) }
        //   value         = { items:["a"], extra:["x","y"] }
        //
        //   armP repaired to {items:["a"],extra:["x"]} and scored 2; armQ then
        //   accepted `value` untouched, short-circuited, and the peer received
        //   {items:["a"]} - one element, with armP's better answer discarded.
        //
        // The tie-break keeps what the short-circuit was actually FOR: on an
        // equal score the unrepaired value wins, so an undrifted payload is
        // still returned by identity and never copied.
        if (
          retained > bestRetained ||
          (retained === bestRetained && projected === value)
        ) {
          best = projected;
          bestRetained = retained;
        }
      }
      return bestRetained >= 0 ? best : value;
    }
    case "record": {
      const valueType = def.valueType;
      if (!valueType || !isPlainRecord(value)) return value;
      let changed = false;
      const out: Record<string, unknown> = { ...value };
      for (const [key, entry] of Object.entries(value)) {
        const projected = project(valueType, entry);
        if (projected !== entry) {
          out[key] = projected;
          changed = true;
        }
      }
      return changed ? out : value;
    }
    // Scalars, literals, pipes, effects and anything zod adds later: not
    // something an array member can be dropped from, so leave it exactly as it
    // arrived and let the caller's existing `.catch()` / row filter decide.
    default:
      return value;
  }
}

/**
 * Drop the array members `frozen` cannot represent and return the repaired
 * value, or `value` itself when nothing needed repairing.
 *
 * The caller still parses the result - this only removes what would otherwise
 * take a whole object down with it.
 */
export function projectOntoFrozenLine(
  frozen: z.ZodType,
  value: unknown,
): unknown {
  return project(frozen, value);
}
