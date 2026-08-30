import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostUpdateInstallUpgradeV10ToV11,
  hostUpdateInstallV10,
  hostUpdateInstallV11,
} from "../contracts";

// `host.update.install@1.1` (Ticket 06): the same dispatch, additionally
// naming the durable update attempt when there is one to name. The two arms
// that gain `attemptId` are deliberately ASYMMETRIC - `already-updating`
// carries the observed non-terminal attempt id (or `null`), while `accepted`
// carries `null` always, pre-cutover - so this suite pins both arms
// separately rather than asserting one shared shape for "carries attemptId".

describe("hostUpdateInstallResponseV11Schema", () => {
  it("parses 'accepted' with a non-null attemptId (post-cutover shape, reserved for ticket 07)", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "accepted",
      attemptId: "attempt-123",
    });
    expect(parsed).toEqual({ outcome: "accepted", attemptId: "attempt-123" });
  });

  it("parses 'accepted' with attemptId: null - the actual pre-cutover shape", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "accepted",
      attemptId: null,
    });
    expect(parsed).toEqual({ outcome: "accepted", attemptId: null });
  });

  it("parses 'already-updating' with a non-null attemptId - the observed in-flight attempt", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "already-updating",
      attemptId: "attempt-456",
    });
    expect(parsed).toEqual({
      outcome: "already-updating",
      attemptId: "attempt-456",
    });
  });

  it("parses 'already-updating' with attemptId: null - the host could not establish an id", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "already-updating",
      attemptId: null,
    });
    expect(parsed).toEqual({ outcome: "already-updating", attemptId: null });
  });

  it("rejects 'accepted' missing the attemptId key entirely - the field is required-key/nullable-value, not optional", () => {
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({ outcome: "accepted" })
        .success,
    ).toBe(false);
  });

  it("rejects 'already-updating' missing the attemptId key entirely", () => {
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({
        outcome: "already-updating",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty-string attemptId on either arm - the id is asserted non-empty when present", () => {
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({
        outcome: "accepted",
        attemptId: "",
      }).success,
    ).toBe(false);
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({
        outcome: "already-updating",
        attemptId: "",
      }).success,
    ).toBe(false);
  });

  it("passes the three failure arms through unchanged, with no attemptId key on any of them", () => {
    for (const outcome of [
      "externally-managed",
      "cli-unavailable",
      "cli-failed",
    ] as const) {
      const parsed = hostUpdateInstallV11.responseSchema.parse({ outcome });
      expect(parsed).toEqual({ outcome });
      expect(parsed).not.toHaveProperty("attemptId");
    }
  });
});

// G9: the `dispatch-indeterminate` arm, shipped into `@1.1` (not a later
// minor) precisely so a `@1.1` decoder already tolerates it from birth - see
// the schema's own header comment for why a `z.discriminatedUnion` makes a
// later-minor arm a hard decode failure on every peer between the two
// versions. Nothing PRODUCES this arm yet; this suite is purely about the
// decoder's shape.
describe("hostUpdateInstallResponseV11Schema — the dispatch-indeterminate arm", () => {
  it("parses with a non-null reason", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "dispatch-indeterminate",
      reason: "ack-timeout",
    });
    expect(parsed).toEqual({
      outcome: "dispatch-indeterminate",
      reason: "ack-timeout",
    });
  });

  it("parses with reason: null - the host did not say why", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "dispatch-indeterminate",
      reason: null,
    });
    expect(parsed).toEqual({
      outcome: "dispatch-indeterminate",
      reason: null,
    });
  });

  // The load-bearing negative control: if the OLDER v1.0 schema also accepted
  // this arm, the versioning would be a no-op - a v1.0-registered peer would
  // silently decode a v1.1-only shape it was never negotiated to receive.
  it("the v1.0 responseSchema REJECTS the arm outright", () => {
    const result = hostUpdateInstallV10.responseSchema.safeParse({
      outcome: "dispatch-indeterminate",
      reason: "ack-timeout",
    });
    expect(result.success).toBe(false);
  });

  it("attemptId is STRUCTURALLY ABSENT, not null - Object.hasOwn is false, so a later 'add it for symmetry' edit fails here first", () => {
    const parsed = hostUpdateInstallV11.responseSchema.parse({
      outcome: "dispatch-indeterminate",
      reason: null,
    });
    expect(Object.hasOwn(parsed, "attemptId")).toBe(false);
  });

  it("rejects reason: undefined (the key is required) and an empty-string reason", () => {
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({
        outcome: "dispatch-indeterminate",
      }).success,
    ).toBe(false);
    expect(
      hostUpdateInstallV11.responseSchema.safeParse({
        outcome: "dispatch-indeterminate",
        reason: "",
      }).success,
    ).toBe(false);
  });
});

const V10_ACCEPTED = hostUpdateInstallV10.responseSchema.parse({
  outcome: "accepted",
});
const V10_ALREADY_UPDATING = hostUpdateInstallV10.responseSchema.parse({
  outcome: "already-updating",
});
const V10_EXTERNALLY_MANAGED = hostUpdateInstallV10.responseSchema.parse({
  outcome: "externally-managed",
});
const V10_CLI_UNAVAILABLE = hostUpdateInstallV10.responseSchema.parse({
  outcome: "cli-unavailable",
});
const V10_CLI_FAILED = hostUpdateInstallV10.responseSchema.parse({
  outcome: "cli-failed",
});

describe("hostUpdateInstallUpgradeV10ToV11", () => {
  it("leaves the request identity-mapped", () => {
    expect(
      hostUpdateInstallUpgradeV10ToV11.upgradeRequest({
        version: "2.1.0",
        force: false,
      }),
    ).toEqual({ version: "2.1.0", force: false });
  });

  it("writes attemptId: null on 'accepted' - a v1.0 peer said nothing about attempts, and null is 'did not report', never 'no attempt'", () => {
    const upgraded =
      hostUpdateInstallUpgradeV10ToV11.upgradeResponse(V10_ACCEPTED);
    expect(upgraded).toEqual({ outcome: "accepted", attemptId: null });
    // The upgraded shape must itself satisfy v1.1's own schema.
    expect(() =>
      hostUpdateInstallV11.responseSchema.parse(upgraded),
    ).not.toThrow();
  });

  it("writes attemptId: null on 'already-updating' for the same reason", () => {
    const upgraded =
      hostUpdateInstallUpgradeV10ToV11.upgradeResponse(V10_ALREADY_UPDATING);
    expect(upgraded).toEqual({ outcome: "already-updating", attemptId: null });
    expect(() =>
      hostUpdateInstallV11.responseSchema.parse(upgraded),
    ).not.toThrow();
  });

  it("passes the three failure arms through UNTOUCHED - no attemptId key is added to any of them", () => {
    for (const v10Response of [
      V10_EXTERNALLY_MANAGED,
      V10_CLI_UNAVAILABLE,
      V10_CLI_FAILED,
    ]) {
      const upgraded =
        hostUpdateInstallUpgradeV10ToV11.upgradeResponse(v10Response);
      expect(upgraded).toEqual(v10Response);
      expect(upgraded).not.toHaveProperty("attemptId");
    }
  });

  it("the two null-attemptId arms are not collapsed into one shape - outcome still distinguishes them", () => {
    const acceptedUpgraded =
      hostUpdateInstallUpgradeV10ToV11.upgradeResponse(V10_ACCEPTED);
    const alreadyUpdatingUpgraded =
      hostUpdateInstallUpgradeV10ToV11.upgradeResponse(V10_ALREADY_UPDATING);
    expect(acceptedUpgraded).not.toEqual(alreadyUpdatingUpgraded);
    expect(acceptedUpgraded.outcome).toBe("accepted");
    expect(alreadyUpdatingUpgraded.outcome).toBe("already-updating");
  });
});

describe("host.update.install registry membership", () => {
  it("installs @1.0 and @1.1 on the unary registry at major 1, with @1.1 wired to the v10->v11 upgrade", () => {
    const entry = hostRpcRegistry["host.update.install"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(1);
    expect(entry[1].versions[0].contract).toBe(hostUpdateInstallV10);
    expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
    expect(entry[1].versions[1].contract).toBe(hostUpdateInstallV11);
    expect(entry[1].versions[1].upgradeFromPreviousVersion).toBe(
      hostUpdateInstallUpgradeV10ToV11,
    );
  });
});
