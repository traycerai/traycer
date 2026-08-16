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
