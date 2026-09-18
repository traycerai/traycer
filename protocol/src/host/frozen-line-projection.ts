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
 * together. Two more, both `denySources[]` on the `native` result (once under
 * `servers[]` and again under the single-server union arm), have no `.catch()`
 * anywhere between them and the root, so growing THAT enum fails the entire
 * `providers.list` response rather than degrading any part of it.
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
 * Dropping is strictly better than not dropping, because the peer's OWN
 * compiled copy of this frozen schema rejects the same element: without the
 * projection it discards the element's whole catch scope, and with it the peer
 * receives bytes it can parse. This is the only part of the freeze that changes
 * what a peer actually receives - a pin alone moves WHERE the collapse happens,
 * not WHETHER it happens.
 *
 * WHAT IT DOES NOT DO. A scalar enum has no member to drop, so an unknown
 * scalar still fails its object and still hits the nearest `.catch()` - or, on
 * a provider row, still drops that row, which is exactly how a post-vN provider
 * id stays off an already-shipped wire. That is unchanged behaviour and
 * deliberately so: the alternative is inventing a substitute value, and a
 * downgrade bridge that fabricates wire content is worse than one that
 * degrades.
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
 * to change, so an undrifted payload allocates nothing and a caller can tell
 * the two cases apart by reference.
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
      // elements wins. Both rules are independent of arm order, which matters
      // because that order is an authoring detail of the frozen schema, not a
      // statement about the wire. Today's unions here are discriminated and so
      // at most one arm can match anyway; this is what keeps that from becoming
      // a silent precondition.
      let best: unknown = null;
      let bestRetained = -1;
      for (const arm of options) {
        const projected = project(arm, value);
        if (!arm.safeParse(projected).success) continue;
        if (projected === value) return value;
        const retained = countArrayElements(projected);
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
