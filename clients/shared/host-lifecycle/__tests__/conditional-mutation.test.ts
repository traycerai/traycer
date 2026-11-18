import { describe, expect, it } from "vitest";
import {
  capturePreconditions,
  runConditionalMutation,
} from "../actuators/conditional-mutation";

describe("runConditionalMutation", () => {
  it.each([
    [
      "scalar",
      { state: "ready", revision: 1 },
      { state: "changed", revision: 1 },
    ],
    [
      "revision",
      { state: "ready", revision: 1 },
      { state: "ready", revision: 2 },
    ],
    [
      "nested",
      { state: { owner: "traycer", pid: 41 } },
      { state: { owner: "traycer", pid: 42 } },
    ],
    ["array", { labels: ["agent", "raw"] }, { labels: ["agent", "fallback"] }],
    [
      "map",
      { fields: new Map([["owner", "traycer"]]) },
      { fields: new Map([["owner", "other"]]) },
    ],
  ])(
    "returns stale-precondition and performs zero mutation when the observed %s field changes",
    async (_field, expectedWorld, actualWorld) => {
      let mutations = 0;
      const result = await runConditionalMutation({
        serialized: async (work) => work(),
        expected: capturePreconditions(expectedWorld),
        probe: async () => actualWorld,
        operation: "test-mutation",
        authorize: () => ({ kind: "authorized", target: "test-target" }),
        mutate: async () => {
          mutations += 1;
        },
      });

      expect(result.kind).toBe("stale-precondition");
      expect(mutations).toBe(0);
    },
  );

  it("refuses, without mutating, when the operation cannot be bound to a target", async () => {
    // The fingerprint is content-blind: an unchanged world says nothing about
    // whether this operation is legal against this target.
    let mutations = 0;
    const world = { state: "ready" };
    const result = await runConditionalMutation({
      serialized: async (work) => work(),
      expected: capturePreconditions(world),
      probe: async () => world,
      operation: "test-mutation",
      authorize: () => ({ kind: "refused", reason: "no such target" }),
      mutate: async () => {
        mutations += 1;
      },
    });

    expect(result).toEqual({
      kind: "refused",
      operation: "test-mutation",
      reason: "no such target",
    });
    expect(mutations).toBe(0);
  });

  it("hands the mutator the target the authorization resolved", async () => {
    const world = { label: "cli-raw" };
    const targets: string[] = [];
    const result = await runConditionalMutation({
      serialized: async (work) => work(),
      expected: capturePreconditions(world),
      probe: async () => world,
      operation: "test-mutation",
      authorize: (actual) => ({ kind: "authorized", target: actual.label }),
      mutate: async (target) => {
        targets.push(target);
      },
    });

    expect(result).toEqual({ kind: "applied" });
    expect(targets).toEqual(["cli-raw"]);
  });

  it("applies only when the complete observed snapshot is unchanged", async () => {
    let mutations = 0;
    const world = {
      fields: new Map([
        ["owner", "traycer"],
        ["revision", "7"],
      ]),
      set: new Set(["agent", "raw"]),
    };
    const result = await runConditionalMutation({
      serialized: async (work) => work(),
      expected: capturePreconditions(world),
      probe: async () => ({
        set: new Set(["raw", "agent"]),
        fields: new Map([
          ["revision", "7"],
          ["owner", "traycer"],
        ]),
      }),
      operation: "test-mutation",
      authorize: () => ({ kind: "authorized", target: "test-target" }),
      mutate: async () => {
        mutations += 1;
      },
    });

    expect(result).toEqual({ kind: "applied" });
    expect(mutations).toBe(1);
  });
});
