import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_UPDATE_BOUND_DISPATCH_REASONS,
  isHostUpdateBoundDispatchReason,
} from "../host-update-bound-dispatch-reasons";
import type { HostUpdateBoundDispatchReason } from "../host-update-bound-dispatch-reasons";

// The vocabulary three surfaces agree over: the host derives its
// `BOUND_DISPATCH_REASONS` from this tuple, the GUI closes its
// indeterminate-dispatch arm set over the derived type, and the CLI draws its
// bound release reasons from the same names. Nothing on the wire enumerates
// them - both `reason` fields stay open strings - so this list is the only
// place the three can be kept in step, and these rows are what make a drift
// loud rather than a raw string reaching a user.

describe("HOST_UPDATE_BOUND_DISPATCH_REASONS", () => {
  it("is the exact vocabulary, in full", () => {
    expect([...HOST_UPDATE_BOUND_DISPATCH_REASONS]).toEqual([
      "externally-managed",
      "refused-attempt-gone",
      "refused-attempt-moved",
      "refused-unverifiable",
      "cli-unavailable",
      "cli-too-old",
      "spawn-failed",
    ]);
  });

  // Not covered by the list above: that one is an equality on a literal, and a
  // careless edit changes both sides together. This says the property the
  // consumers actually depend on - every value is a distinct kebab token, so
  // it can be pasted into a log, a URL or a JSX label unescaped, which is the
  // same grammar the ACK reason pattern enforces.
  it("holds seven distinct lowercase-kebab tokens", () => {
    const reasons: readonly string[] = HOST_UPDATE_BOUND_DISPATCH_REASONS;
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons.length).toBe(7);
    for (const reason of reasons) {
      expect(reason).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  // `refused-attempt-moved` is the P1 window-A reason and the point of this
  // round. Pinned by name, and pinned as DISTINCT from `refused-attempt-gone`:
  // collapsing the two would tell a user nothing is happening when the truth
  // is that what is happening is not what they confirmed.
  it("carries `refused-attempt-moved`, distinct from `refused-attempt-gone`", () => {
    expect(HOST_UPDATE_BOUND_DISPATCH_REASONS).toContain(
      "refused-attempt-moved",
    );
    expect(HOST_UPDATE_BOUND_DISPATCH_REASONS).toContain(
      "refused-attempt-gone",
    );
    expect("refused-attempt-moved").not.toBe("refused-attempt-gone");
  });

  it("narrows a known reason and declines an unknown one without throwing", () => {
    expect(isHostUpdateBoundDispatchReason("refused-attempt-moved")).toBe(true);
    // A newer host's vocabulary. `false` is the caller's cue to render it
    // generically, never to drop it - the raw string is the only thing that
    // host managed to say.
    expect(isHostUpdateBoundDispatchReason("refused-something-newer")).toBe(
      false,
    );
    expect(isHostUpdateBoundDispatchReason("")).toBe(false);
  });

  it("gives an exhaustive switch to a consumer, with no default arm", () => {
    // The GUI's arm set is this shape. If a reason is added to the tuple and
    // not here, `describe` stops type-checking - which is the obligation the
    // whole module exists to create.
    const describeReason = (reason: HostUpdateBoundDispatchReason): string => {
      switch (reason) {
        case "externally-managed":
          return "supervised elsewhere";
        case "refused-attempt-gone":
          return "nothing to act on";
        case "refused-attempt-moved":
          return "the attempt moved since you looked";
        case "refused-unverifiable":
          return "could not be read";
        case "cli-unavailable":
          return "no CLI";
        case "cli-too-old":
          return "CLI too old";
        case "spawn-failed":
          return "spawn failed";
      }
    };
    expect(HOST_UPDATE_BOUND_DISPATCH_REASONS.map(describeReason)).toHaveLength(
      HOST_UPDATE_BOUND_DISPATCH_REASONS.length,
    );
  });

  // The reason this list is its own file rather than a section of
  // `./host-update-ack.ts`, which reads `node:path`. The renderer imports this
  // module directly; a `node:` import here would break the GUI bundle at build
  // time in a way no unit test would otherwise notice.
  it("imports nothing from `node:` - the renderer bundles this module", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../host-update-bound-dispatch-reasons.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"node:/);
    expect(source).not.toMatch(/require\(/);
    // Proof the read found the real module and not an empty path: the export
    // this file is about has to be in what was read.
    expect(source).toContain("HOST_UPDATE_BOUND_DISPATCH_REASONS");
  });
});
