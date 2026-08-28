import { chatSyncRunSettingsSchema } from "@traycer/protocol/persistence/chat-sync/core";
import {
  canonicalJsonStringify,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  CHAT_SNAPSHOT_RESIDUAL_KEY,
  captureResidualKeys,
} from "@traycer/protocol/persistence/chat-sync/residual";
import { describe, expect, it } from "vitest";

/**
 * Residual capture is IDEMPOTENT, and a legacy nest heals on the way through.
 *
 * The property this pins is not an abstraction. `core.settings` is a captured
 * level whose emission does not spread its bag back out - the host re-offers
 * `state.settings` whole, in post-capture form - so every decode→encode cycle
 * used to wrap the bag one level deeper. The field consequence was a chat's
 * inline surface drifting by an empty wrapper per reconcile until a fresh fold
 * of the same op log no longer reproduced the acked head, which halted the
 * publisher's proving recut on essentially every long-lived chat.
 *
 * Depth is therefore the thing under test, and the depths here are the ones
 * observed on real heads (1, 4, 8, 19). A fix that merged only ONE level would
 * pass a naive round-trip test and still leave those chats unprovable.
 */

const DECLARED = ["alpha", "beta"] as const;
const capture = captureResidualKeys(DECLARED);

/** The post-capture object, as the object schema would receive it. */
function capturedObject(raw: JsonValue): JsonObject {
  const result = capture(raw);
  if (!isJsonObject(result)) {
    throw new Error("expected capture to produce a JSON object");
  }
  return result;
}

function bagOf(raw: JsonValue): JsonValue {
  const captured = capturedObject(raw);
  const descriptor = Object.getOwnPropertyDescriptor(
    captured,
    CHAT_SNAPSHOT_RESIDUAL_KEY,
  );
  if (descriptor === undefined) throw new Error("expected a residual bag");
  return descriptor.value;
}

/** How many `residual` wrappers deep the bag is nested. */
function bagDepth(value: JsonValue): number {
  let depth = 0;
  let level: JsonValue = value;

  while (isJsonObject(level)) {
    const descriptor = Object.getOwnPropertyDescriptor(
      level,
      CHAT_SNAPSHOT_RESIDUAL_KEY,
    );
    if (descriptor === undefined || !isJsonObject(descriptor.value)) break;
    depth += 1;
    level = descriptor.value;
  }

  return depth;
}

/** Counts reflection traps taken against a wrapped input. */
type VisitCounter = { count: number };

/**
 * A TRANSPARENT proxy that counts how many times capture reflects on it.
 *
 * Every trap forwards through `Reflect`, so the wrapper is invisible to
 * `isJsonObject`'s prototype / symbol / descriptor checks and to the walk: what
 * is measured is the real algorithm on a real input, not a stub of it.
 *
 * Four traps, which between them are every way capture can reach a level:
 * `get`, `getOwnPropertyDescriptor`, `ownKeys` (both
 * `Object.getOwnPropertyNames` and `Object.getOwnPropertySymbols` route
 * through it), and `getPrototypeOf` - `isJsonObject` takes exactly one of
 * those per level it deep-validates, so omitting it undercounts the
 * validation-driven half of the work by 1 per level.
 */
function countingProxy(target: JsonObject, visits: VisitCounter): JsonObject {
  return new Proxy(target, {
    get(object, key, receiver) {
      visits.count += 1;
      return Reflect.get(object, key, receiver);
    },
    getOwnPropertyDescriptor(object, key) {
      visits.count += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    ownKeys(object) {
      visits.count += 1;
      return Reflect.ownKeys(object);
    },
    getPrototypeOf(object) {
      visits.count += 1;
      return Reflect.getPrototypeOf(object);
    },
  });
}

/** `nestResidual`, with every level wrapped in a counting proxy. */
function countingNest(
  value: JsonObject,
  nesting: number,
  visits: VisitCounter,
): JsonObject {
  let built: JsonObject = countingProxy(value, visits);
  for (let level = 0; level < nesting; level += 1) {
    const wrapper: JsonObject = Object.create(null);
    Object.defineProperty(wrapper, CHAT_SNAPSHOT_RESIDUAL_KEY, {
      value: built,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    built = countingProxy(wrapper, visits);
  }
  return built;
}

/**
 * A plain object carrying `value` under `residual`, `nesting` levels down.
 * Built with `defineProperty` on a null-prototype target for the same reason
 * the canonicalizer does: so a `__proto__` key inside the payload survives.
 */
function nestResidual(value: JsonObject, nesting: number): JsonObject {
  let built: JsonObject = value;
  for (let level = 0; level < nesting; level += 1) {
    const wrapper: JsonObject = Object.create(null);
    Object.defineProperty(wrapper, CHAT_SNAPSHOT_RESIDUAL_KEY, {
      value: built,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    built = wrapper;
  }
  return built;
}

// The raw wire objects a capture site actually meets: declared-only, declared
// plus unmodeled keys, and either of those already carrying a prior bag at
// several nesting depths. Canonical strings compare them, so key ORDER (which
// capture normalizes away) never decides a case.
const RAW_INPUTS: readonly JsonObject[] = (() => {
  const bases: readonly JsonObject[] = [
    { alpha: 1, beta: "b" },
    { alpha: 1, beta: "b", futureField: { added: "by a newer minor" } },
    { alpha: 1, beta: "b", futureField: null, anotherFuture: [1, 2, 3] },
    // Declared fields missing entirely: capture runs ahead of the object
    // schema, so it must not assume a well-formed level.
    { futureField: "orphan" },
  ];
  const priors: readonly JsonObject[] = [
    {},
    { carried: "from an older cycle" },
    { carried: "from an older cycle", deep: { nested: true } },
  ];

  const inputs: JsonObject[] = [...bases];
  for (const base of bases) {
    for (const prior of priors) {
      for (const nesting of [1, 2, 4, 8, 19]) {
        inputs.push({
          ...base,
          [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(prior, nesting - 1),
        });
      }
    }
  }
  return inputs;
})();

describe("residual capture is idempotent", () => {
  it("re-capturing a post-capture object changes nothing", () => {
    // The exact cycle the host performs: decode produces the post-capture
    // domain object, the adapter re-offers it whole, and capture runs again.
    for (const raw of RAW_INPUTS) {
      const once = capturedObject(raw);
      const twice = capturedObject(once);
      expect(canonicalJsonStringify(twice)).toBe(canonicalJsonStringify(once));
    }
  });

  it("stays depth-stable over many cycles, not just one", () => {
    // One merge level would pass the test above and still ratchet. Ten cycles
    // is well past the depths seen in the field.
    for (const raw of RAW_INPUTS) {
      const once = capturedObject(raw);
      let cycled = once;
      for (let cycle = 0; cycle < 10; cycle += 1)
        cycled = capturedObject(cycled);

      expect(bagDepth(bagOf(raw))).toBe(0);
      expect(canonicalJsonStringify(cycled)).toBe(canonicalJsonStringify(once));
    }
  });

  it("flattens a legacy nest to the depth-0 parse of the same content", () => {
    const content: JsonObject = { carried: "from an older cycle" };
    const flat = bagOf({ alpha: 1, beta: "b", ...content });

    for (const nesting of [1, 4, 8, 19]) {
      const nested = bagOf({
        alpha: 1,
        beta: "b",
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(content, nesting - 1),
      });
      expect(nested).toEqual(flat);
    }
  });
});

describe("residual capture reads a prior bag exactly as far as it should", () => {
  it("keeps a NON-object residual as ordinary data", () => {
    // A bag this module produced is always an object, so anything else under
    // that key came from a writer and is data. Losing it would be the same
    // silent strip the whole mechanism exists to stop.
    for (const value of ["a string", 7, true, null, [1, 2], []] as const) {
      const bag = bagOf({
        alpha: 1,
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: value as JsonValue,
      });
      expect(bag).toEqual({ [CHAT_SNAPSHOT_RESIDUAL_KEY]: value });
    }
  });

  it("stops descending at the first non-object residual", () => {
    const bag = bagOf({
      alpha: 1,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: {
        carried: "level one",
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: "not a bag",
      },
    });
    expect(bag).toEqual({
      carried: "level one",
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: "not a bag",
    });
  });

  it("lets the shallower key win a collision", () => {
    // Outermost is this cycle's reading of the object; each level down is an
    // older copy. The own key of `raw` is shallower than any bag level.
    const bag = bagOf({
      alpha: 1,
      shared: "newest",
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: {
        shared: "middle",
        onlyMiddle: 1,
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: {
          shared: "oldest",
          onlyMiddle: 2,
          onlyOldest: 3,
        },
      },
    });

    expect(bag).toEqual({
      shared: "newest",
      onlyMiddle: 1,
      onlyOldest: 3,
    });
  });

  it("does not let a prior bag overwrite a declared key", () => {
    // Declared keys are read off `raw` before the bag is absorbed, and a bag
    // key that shadows one must not reach the modeled field.
    const captured = capturedObject({
      alpha: "declared",
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: { alpha: "from a stale bag" },
    });

    expect(captured.alpha).toBe("declared");
    // And it is not merely shadowed: the bag's invariant is that it holds only
    // UNMODELED keys, so the stale copy is dropped outright. `mergeResidual`
    // would give the declared field precedence anyway, so the wire is the same
    // either way - what this pins is that the bag does not start accumulating
    // shadow copies of modeled fields.
    expect(captured[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({});
  });

  it("visits each chain level a constant number of times, not N of them", () => {
    // THE DETECTOR for the quadratic form, and it works by instrumenting the
    // INPUT rather than the module - so nothing had to be exported, injected or
    // otherwise widened to make a performance property assertable.
    //
    // A per-level `isJsonObject` re-validates the whole remaining suffix, so a
    // chain of depth N is reflected on N + (N-1) + … + 1 times. Wrapping every
    // level in a transparent counting proxy makes that difference a COUNT
    // instead of a duration: linear work touches each level a fixed number of
    // times, quadratic work touches it once per level above it. Deterministic,
    // and with no wall clock anywhere near it.
    //
    // Measured at this depth: ~6N visits one-pass, ~2N² if the deep check comes
    // back - 1,200 against 81,600. The cap below is deliberately loose; the
    // point is separating 6N from 2N², not freezing the constant, so ordinary
    // refactors of the walk have room while the quadratic form cannot fit.
    const DEPTH = 200;
    const visits: VisitCounter = { count: 0 };
    const chain = countingNest(
      { carried: "at the bottom of the chain" },
      DEPTH - 1,
      visits,
    );

    visits.count = 0;
    const bag = bagOf({ alpha: 1, [CHAT_SNAPSHOT_RESIDUAL_KEY]: chain });
    const observed = visits.count;

    // Correct FIRST: a walk that flattened nothing would also be cheap.
    expect(bag).toEqual({ carried: "at the bottom of the chain" });
    expect(observed).toBeLessThanOrEqual(DEPTH * 20);
  });

  it("descends a hostile 2,000-deep chain without re-validating each suffix", () => {
    // Not a detector - the pin above is. This one documents the STACK-BUDGET
    // margin: it is the deepest chain the decoder is expected to meet and
    // survive, and it would still pass if the quadratic form returned, merely
    // slower (~2.8 SECONDS at depth 10,000 on a value under 130 KB, which a
    // corrupt or hostile document reaches for free; ~1 ms now). No wall-clock
    // assertion here on purpose - a timing pin flakes in CI.
    //
    // 2,000 rather than 10,000, and the ceiling is NOT this code: `isJsonValue`
    // / `isJsonObject` recurse per level (`json.ts`), so the entry validation
    // every capture already performed blows the stack somewhere between 5,000
    // and 6,000 inside a vitest worker - and lower as ambient stack depth
    // grows, which is what makes a pin up there flaky rather than strict. That
    // recursion predates this fix and strikes any deep chat-sync value, residual
    // chain or not (ticket 58); outside the worker this same chain flattens
    // fine at 10,000.
    const bag = bagOf({
      alpha: 1,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(
        { carried: "at the bottom of 2,000 wrappers" },
        1_999,
      ),
    });

    expect(bag).toEqual({ carried: "at the bottom of 2,000 wrappers" });
  });
});

/**
 * The bag can hold the ONLY copy of a field the current schema now models.
 *
 * A 1.0 reader bags a 1.1 writer's `newSetting` and has no top-level copy of
 * it, because it never had one to write. That post-capture shape is a supported
 * CARRIER - a clone seed passes `core.settings` verbatim, the host's settings
 * adapter re-offers its opaque settings whole - so a 1.1 schema really does
 * meet it again, with `newSetting` declared by then. Dropping the bag copy
 * there destroys the field: silently for a defaulted one, as a parse failure
 * for a required one.
 *
 * Two declared sets are what make this observable at all; a fixed-schema test
 * cannot witness it, which is how the first cut of this fix shipped the drop.
 */
describe("residual capture promotes a since-modeled field out of the bag", () => {
  const oldSchema = captureResidualKeys(["alpha"]);
  const newSchema = captureResidualKeys(["alpha", "newSetting"]);

  function captureWith(
    capturer: (raw: unknown) => unknown,
    raw: JsonValue,
  ): JsonObject {
    const result = capturer(raw);
    if (!isJsonObject(result)) {
      throw new Error("expected capture to produce a JSON object");
    }
    return result;
  }

  it("promotes it when the carrier has no modeled copy", () => {
    // Step 1: the old schema bags a field it does not model.
    const carried = captureWith(oldSchema, {
      alpha: 1,
      newSetting: "written by a newer minor",
    });
    expect(carried[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({
      newSetting: "written by a newer minor",
    });
    expect(carried.newSetting).toBeUndefined();

    // Step 2: the new schema meets that carrier and now declares the field.
    const recaptured = captureWith(newSchema, carried);
    expect(recaptured.newSetting).toBe("written by a newer minor");
    expect(recaptured[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({});
  });

  it("promotes it from under legacy wrappers too", () => {
    // The nesting and the skew are independent, and a lineage that accumulated
    // wrappers is exactly the population this fix exists for - so the promotion
    // has to reach through them rather than only reading the top bag.
    for (const depth of [2, 4, 19]) {
      const recaptured = captureWith(newSchema, {
        alpha: 1,
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(
          { newSetting: "written by a newer minor" },
          depth - 1,
        ),
      });
      expect(recaptured.newSetting).toBe("written by a newer minor");
      expect(recaptured[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({});
    }
  });

  it("promotes the SHALLOWEST copy when the chain holds several", () => {
    // Same precedence as retention: the outermost bag is the newest cycle's
    // reading, and promotion must not reach past it to an older value.
    const recaptured = captureWith(newSchema, {
      alpha: 1,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: {
        newSetting: "newest",
        [CHAT_SNAPSHOT_RESIDUAL_KEY]: {
          newSetting: "older",
          [CHAT_SNAPSHOT_RESIDUAL_KEY]: { newSetting: "oldest" },
        },
      },
    });

    expect(recaptured.newSetting).toBe("newest");
    expect(recaptured[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({});
  });

  it("still prefers the carrier's own modeled copy over a bagged one", () => {
    // The complement, and what keeps promotion from becoming "the bag wins":
    // when the carrier DOES have a top-level copy it is authoritative, and the
    // stale bagged one is dropped rather than promoted over it.
    const recaptured = captureWith(newSchema, {
      alpha: 1,
      newSetting: "the carrier's own value",
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: { newSetting: "a stale bagged copy" },
    });

    expect(recaptured.newSetting).toBe("the carrier's own value");
    expect(recaptured[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({});
  });

  it("stays idempotent across the promotion", () => {
    // Promotion moves a key between homes, which is exactly the shape of edit
    // that could reintroduce a per-cycle drift. Re-capturing the healed output
    // must change nothing.
    const healed = captureWith(newSchema, {
      alpha: 1,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(
        { newSetting: "written by a newer minor", stillUnmodeled: [1, 2] },
        7,
      ),
    });

    let cycled = healed;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      cycled = captureWith(newSchema, cycled);
    }

    expect(canonicalJsonStringify(cycled)).toBe(canonicalJsonStringify(healed));
    expect(cycled.newSetting).toBe("written by a newer minor");
    expect(cycled[CHAT_SNAPSHOT_RESIDUAL_KEY]).toEqual({
      stillUnmodeled: [1, 2],
    });
  });

  it("carries a __proto__ key through the merge as an own key", () => {
    const prior: JsonObject = Object.create(null);
    Object.defineProperty(prior, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const bag = bagOf({
      alpha: 1,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(prior, 3),
    });
    if (!isJsonObject(bag)) throw new Error("expected a JSON object");

    const descriptor = Object.getOwnPropertyDescriptor(bag, "__proto__");
    expect(descriptor?.value).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(canonicalJsonStringify(bag)).toBe('{"__proto__":{"polluted":true}}');
  });

  it("prefers a shallower __proto__ over a deeper one", () => {
    // The collision check reads own descriptors rather than using `in`, which
    // would resolve `__proto__` through the prototype chain and answer wrong.
    const outer: JsonObject = Object.create(null);
    Object.defineProperty(outer, "__proto__", {
      value: "newest",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const inner: JsonObject = Object.create(null);
    Object.defineProperty(inner, "__proto__", {
      value: "oldest",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(outer, CHAT_SNAPSHOT_RESIDUAL_KEY, {
      value: inner,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const bag = bagOf({ alpha: 1, [CHAT_SNAPSHOT_RESIDUAL_KEY]: outer });
    expect(canonicalJsonStringify(bag)).toBe('{"__proto__":"newest"}');
  });
});

describe("core.settings heals a nested lineage", () => {
  // The staging shape: a settings object whose bag was re-wrapped once per
  // reconcile. `5f496021` was 19 deep with an empty bag at the bottom.
  const settings: JsonObject = {
    harnessId: "claude",
    model: "claude-opus-5",
    permissionMode: "full_access",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };

  it("parses a depth-19 settings object to the same value as a flat one", () => {
    const flat = chatSyncRunSettingsSchema.parse(settings);
    const nested = chatSyncRunSettingsSchema.parse({
      ...settings,
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual({}, 18),
    });

    expect(nested).toEqual(flat);
    expect(nested.residual).toEqual({});
  });

  it("keeps a real unmodeled settings key while flattening around it", () => {
    // Non-vacuity: the healing must be surgical, not "the bag is always empty".
    const nested = chatSyncRunSettingsSchema.parse({
      ...settings,
      futureSetting: "from a newer minor",
      [CHAT_SNAPSHOT_RESIDUAL_KEY]: nestResidual(
        { olderSetting: "from a newer minor, one cycle ago" },
        7,
      ),
    });

    expect(nested.residual).toEqual({
      futureSetting: "from a newer minor",
      olderSetting: "from a newer minor, one cycle ago",
    });
  });
});
