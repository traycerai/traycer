import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { hostUpdateActivateV10, hostUpdateContinueV10 } from "../contracts";
import {
  hostUpdateBoundDispatchRequestSchema,
  hostUpdateBoundDispatchResponseSchema,
} from "../schemas";

// The two BOUND update dispatches (D9/D16/D19): `host.update.activate` and
// `host.update.continue`, brand-new at 1.0, sharing one request and one
// response schema of their own - deliberately NOT `host.update.install`'s.

describe("hostUpdateBoundDispatchRequestSchema", () => {
  it("parses a non-empty attemptId and a boolean force", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.parse({
        attemptId: "attempt-1",
        force: true,
      }),
    ).toEqual({ attemptId: "attempt-1", force: true });
  });

  it("rejects an empty attemptId", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({
        attemptId: "",
        force: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing force", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({ attemptId: "attempt-1" })
        .success,
    ).toBe(false);
  });
});

describe("hostUpdateBoundDispatchResponseSchema", () => {
  it.each(["accepted", "already-updating"] as const)(
    "parses %s with a non-empty attemptId",
    (outcome) => {
      expect(
        hostUpdateBoundDispatchResponseSchema.parse({
          outcome,
          attemptId: "attempt-1",
        }),
      ).toEqual({ outcome, attemptId: "attempt-1" });
    },
  );

  it.each(["dispatch-indeterminate", "cli-failed"] as const)(
    // Unlike `host.update.install`'s `cli-failed`, which carries no reason at
    // all, a bound dispatch's `cli-failed` names why - most importantly "the
    // CLI is too old to honour these bound options."
    "parses %s with a non-empty reason",
    (outcome) => {
      expect(
        hostUpdateBoundDispatchResponseSchema.parse({
          outcome,
          reason: "cli-too-old",
        }),
      ).toEqual({ outcome, reason: "cli-too-old" });
    },
  );

  it("rejects an accepted arm with no attemptId, or with attemptId: null - every arm here is non-nullable, unlike host.update.install's legacy accommodation", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({ outcome: "accepted" })
        .success,
    ).toBe(false);
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({
        outcome: "accepted",
        attemptId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a cli-failed arm with no reason", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({ outcome: "cli-failed" })
        .success,
    ).toBe(false);
  });

  it("rejects an outcome outside the declared set", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({
        outcome: "declined",
        attemptId: "attempt-1",
      }).success,
    ).toBe(false);
  });
});

describe.each([
  ["host.update.activate", hostUpdateActivateV10] as const,
  ["host.update.continue", hostUpdateContinueV10] as const,
])("%s registry line", (method, contract) => {
  const REGISTRY = hostRpcRegistry[method];

  it("registers at major 1, minor 0, with the shared bound-dispatch contract and no upgrade predecessor", () => {
    expect(REGISTRY[1].latestMinor).toBe(0);
    expect(REGISTRY[1].versions[0].contract).toBe(contract);
    expect(REGISTRY[1].versions[0].upgradeFromPreviousVersion).toBeNull();
  });

  it("adds no cross-major downgrade bridge", () => {
    expect(REGISTRY[1].downgradePathsFromLatest).toEqual({});
  });

  it("degrades as unsupported for a host that predates the method - a missing METHOD is refused at dispatch rather than silently dropping the bound intent onto a lower minor", () => {
    expect(REGISTRY.degrade).toEqual({ kind: "unsupported" });
  });

  it("shares the bound-dispatch request and response schemas", () => {
    expect(contract.requestSchema).toBe(hostUpdateBoundDispatchRequestSchema);
    expect(contract.responseSchema).toBe(hostUpdateBoundDispatchResponseSchema);
  });
});
