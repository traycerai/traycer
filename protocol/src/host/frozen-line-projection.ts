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
 * together. Seven leaves have no `.catch()` between them and the root at all,
 * where growth fails the entire `providers.list` response rather than degrading
 * part of it; four sit under an array and so are repairable here
 * (`servers[].status`, `servers[].statusSource`,
 * `servers[].tools[].denySources[]`, `skills[].source`) and three are scalars
 * that nothing can rescue by dropping (`native|0|3.server.status`,
 * `native|0|3.server.statusSource`, `native|1.code`). Those three are where a
 * `.catch()` - not a pin - is the missing defence.
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
 * moved, and the union case runs `safeParse` PER ARM, which is where the cost
 * actually is. So this is not free: on a `providers.list` payload both the head
 * and the 7.0 row accept - 8 rows with full `nativeCapabilities`, plus a native
 * MCP result of 6 servers x 8 tools - the walk measures ~2.5x the frozen
 * parse it precedes, making the combined call ~3x a bare parse (0.037 ms ->
 * 0.12 ms). Bounded, on a response already parsed twice over (here and again by
 * the peer), and it buys the tabs a `.catch()` would otherwise drop - but state
 * it as a multiple, not as "free".
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
      // So: an arm needing NO repair wins outright - identity means the value
      // already belongs to it - and otherwise the arm RETAINING THE MOST array
      // elements wins. An exact tie still falls back to declaration order,
      // which is the one case these rules do not decide; everything else is
      // order-independent, and that matters because arm order is an authoring
      // detail of the frozen schema rather than a statement about the wire.
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
        const parsed = arm.safeParse(projected);
        if (!parsed.success) continue;
        // Identity on the PROJECTION is what says "this arm needed no repair".
        // It has to be tested on the projection and not on `parsed.data`, which
        // is a fresh object for every object schema and so never identical.
        if (projected === value) return value;
        // Score the PARSED result though, not the projected input: an arm
        // strips the keys it does not model, so scoring the input credits an
        // arm for data it is about to throw away, and a narrow arm carrying a
        // fat unmodeled field would beat the arm that actually keeps the
        // payload.
        const retained = countArrayElements(parsed.data);
        if (retained > bestRetained) {
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
