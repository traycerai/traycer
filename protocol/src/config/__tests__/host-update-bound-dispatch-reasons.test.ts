import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATED_CLI_ERROR_REFUSAL_PREFIX,
  HOST_UPDATE_CLI_FAILED_REASONS,
  HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS,
  isGeneratedCliErrorRefusal,
  isHostUpdateCliFailedReason,
  narrowKnownIndeterminateDispatchReason,
} from "../host-update-bound-dispatch-reasons";
import type {
  HostUpdateCliFailedReason,
  HostUpdateKnownIndeterminateDispatchReason,
} from "../host-update-bound-dispatch-reasons";
import { STALE_ATTEMPT_CLOSED_SUFFIX } from "../host-update-ack-reason";

// One tuple per WIRE FIELD. The two fields differ in kind, not only in
// membership - `cli-failed.reason` is closed and `dispatch-indeterminate.reason`
// is generated - and these rows exist to keep that difference legible, because
// the whole defect this module was rewritten to fix was one list treated as if
// it were the domain of both.

describe("HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS", () => {
  it("is the exact known set, in full", () => {
    expect([...HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS]).toEqual([
      "externally-managed",
      "refused-attempt-gone",
      "refused-attempt-moved",
      "refused-unverifiable",
      "record-fail-closed",
      "recovered-complete",
      "recovered-failed",
      "ack-timeout",
      "child-exited-before-ack",
      "attempt-record-invalid",
      "refused-unprintable",
      "unnamed-attempt",
    ]);
  });

  it("holds distinct lowercase-kebab tokens inside the ACK grammar", () => {
    const reasons: readonly string[] =
      HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS;
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  // The census results most likely to be "corrected" by someone who does not
  // know why they are the way they are. Both are stated in the docblock; these
  // rows are what make the statements load-bearing.
  it("excludes `nothing-to-do`, which no bound intent can reach", () => {
    expect(HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS).not.toContain(
      "nothing-to-do",
    );
  });

  it("excludes `refused-install-changed`, which is generated rather than minted", () => {
    expect(HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS).not.toContain(
      "refused-install-changed",
    );
    // ...and is recognisable as the generated family instead, which is the
    // branch a consumer is supposed to use for it.
    expect(isGeneratedCliErrorRefusal("refused-e-install-changed")).toBe(true);
  });

  it("carries the host's own wait and projection outcomes, not only refusals", () => {
    for (const reason of [
      "ack-timeout",
      "child-exited-before-ack",
      "attempt-record-invalid",
      "refused-unprintable",
      "unnamed-attempt",
    ]) {
      expect(HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS).toContain(
        reason,
      );
    }
  });
});

describe("narrowKnownIndeterminateDispatchReason", () => {
  it("narrows a plain known reason", () => {
    expect(
      narrowKnownIndeterminateDispatchReason("refused-attempt-moved"),
    ).toBe("refused-attempt-moved");
  });

  // The strip, which is the reason this is a narrowing function and not a
  // predicate. A decorated reason is a REAL value naming a reason in the tuple;
  // a consumer comparing raw values loses a live arm silently, and that has
  // been found twice already.
  it("narrows a SUFFIXED known reason to its base", () => {
    expect(
      narrowKnownIndeterminateDispatchReason(
        `refused-attempt-moved${STALE_ATTEMPT_CLOSED_SUFFIX}`,
      ),
    ).toBe("refused-attempt-moved");
    expect(
      narrowKnownIndeterminateDispatchReason(
        `recovered-complete${STALE_ATTEMPT_CLOSED_SUFFIX}`,
      ),
    ).toBe("recovered-complete");
  });

  it("declines a SUFFIXED unknown base rather than accepting the decoration", () => {
    expect(
      narrowKnownIndeterminateDispatchReason(
        `refused-e-host-not-installed${STALE_ATTEMPT_CLOSED_SUFFIX}`,
      ),
    ).toBeNull();
  });

  it("declines an unknown reason without throwing - the field is OPEN", () => {
    expect(
      narrowKnownIndeterminateDispatchReason("refused-something-newer"),
    ).toBeNull();
    expect(narrowKnownIndeterminateDispatchReason("")).toBeNull();
  });

  // The three-branch shape the docblock prescribes, written out so it is
  // executable rather than advisory. A `default`-less switch over the tuple
  // would be a lie about this field; this is what a correct consumer looks
  // like, and the `null` arm is the one that must never be deleted.
  it("supports known -> generated family -> raw fallback, in that order", () => {
    const describeReason = (reason: string): string => {
      // Typed explicitly: this is the value a consumer holds after narrowing,
      // and it is what lets the arms below be checked by the compiler even
      // though the field they came from is open.
      const known: HostUpdateKnownIndeterminateDispatchReason | null =
        narrowKnownIndeterminateDispatchReason(reason);
      if (known !== null) return `known:${known}`;
      if (isGeneratedCliErrorRefusal(reason)) return "cli-error";
      return `raw:${reason}`;
    };
    expect(describeReason("ack-timeout")).toBe("known:ack-timeout");
    expect(
      describeReason(`refused-unverifiable${STALE_ATTEMPT_CLOSED_SUFFIX}`),
    ).toBe("known:refused-unverifiable");
    expect(describeReason("refused-e-invalid-argument")).toBe("cli-error");
    expect(describeReason("something-a-newer-host-said")).toBe(
      "raw:something-a-newer-host-said",
    );
  });
});

describe("HOST_UPDATE_CLI_FAILED_REASONS", () => {
  it("is closed at exactly three host-minted reasons", () => {
    expect([...HOST_UPDATE_CLI_FAILED_REASONS]).toEqual([
      "cli-unavailable",
      "cli-too-old",
      "spawn-failed",
    ]);
  });

  it("gives a consumer an exhaustive switch with no default arm", () => {
    // Honest here and NOT honest over the indeterminate tuple: this field has
    // no generator and no ACK echo, so the compiler's exhaustiveness check is
    // a real guarantee rather than a partition of the subset we have copy for.
    const describeFailure = (reason: HostUpdateCliFailedReason): string => {
      switch (reason) {
        case "cli-unavailable":
          return "no CLI to run";
        case "cli-too-old":
          return "the CLI predates the bound options";
        case "spawn-failed":
          return "the spawn itself failed";
      }
    };
    expect(HOST_UPDATE_CLI_FAILED_REASONS.map(describeFailure)).toHaveLength(3);
  });

  it("narrows without stripping - the closure suffix cannot reach this arm", () => {
    expect(isHostUpdateCliFailedReason("cli-too-old")).toBe(true);
    expect(
      isHostUpdateCliFailedReason(`cli-too-old${STALE_ATTEMPT_CLOSED_SUFFIX}`),
    ).toBe(false);
    expect(isHostUpdateCliFailedReason("refused-attempt-gone")).toBe(false);
  });

  // The two fields are disjoint. Neither tuple may grow a member of the other:
  // a consumer picks its tuple by the arm it is rendering, and an overlap
  // would make the wrong choice invisible.
  it("shares no member with the indeterminate tuple", () => {
    const indeterminate: readonly string[] =
      HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS;
    for (const reason of HOST_UPDATE_CLI_FAILED_REASONS) {
      expect(indeterminate).not.toContain(reason);
    }
  });
});

describe("the generated family", () => {
  it("is keyed on the prefix the CLI's generator actually produces", () => {
    // `CLI_ERROR_CODES` values are all `E_`-prefixed and the generator
    // lowercases and re-punctuates them, so `E_HOST_NOT_INSTALLED` arrives as
    // `refused-e-host-not-installed`.
    expect(GENERATED_CLI_ERROR_REFUSAL_PREFIX).toBe("refused-e-");
    expect(isGeneratedCliErrorRefusal("refused-e-host-not-installed")).toBe(
      true,
    );
  });

  it("does not swallow the named refusals that merely start with `refused-`", () => {
    for (const reason of [
      "refused-attempt-gone",
      "refused-attempt-moved",
      "refused-unverifiable",
      "refused-unprintable",
    ]) {
      expect(isGeneratedCliErrorRefusal(reason)).toBe(false);
    }
  });
});

// The reason this list is its own file rather than a section of
// `./host-update-ack.ts`, which reads `node:path`. The renderer imports this
// module directly; a `node:` import here would break the GUI bundle at build
// time in a way no unit test would otherwise notice. The sibling it DOES
// import (`./host-update-ack-reason`) is node-free for the same reason.
describe("renderer safety", () => {
  it("imports nothing from `node:`", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../host-update-bound-dispatch-reasons.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"node:/);
    expect(source).not.toMatch(/require\(/);
    // Proof the read found the real module and not an empty path.
    expect(source).toContain(
      "HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS",
    );
  });

  it("holds for the ACK-grammar leaf it imports, too", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../host-update-ack-reason.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"node:/);
    expect(source).toContain("baseDispatchAckReason");
  });
});
