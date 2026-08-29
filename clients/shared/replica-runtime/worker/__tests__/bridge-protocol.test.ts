/**
 * The protocol's own invariants - the ones that are about the CONTRACT rather
 * than about either endpoint's behaviour.
 *
 * The count below is the only one of these that a type cannot state. Everything
 * else in `bridge-protocol.ts` is checked by the compiler (the coverage record
 * is a mapped type, the builders and parsers are mapped over their unions, the
 * frame guards are type predicates), which is why this file is short: a pin for
 * something the compiler already proves is a pin that can never fail.
 */
import { describe, expect, it } from "vitest";
import {
  buildMainCall,
  MAIN_CALL_KINDS,
  MAIN_CALL_RESPONSE_PARSERS,
  isMainToWorkerFrame,
  isWorkerToMainFrame,
} from "../bridge-protocol";

describe("MAIN_CALL_KINDS", () => {
  it("names exactly the two calls the worker may make of the main thread", () => {
    // Enumerated BY NAME, not counted. `toHaveLength(2)` would stay green if a
    // member were renamed or swapped for a different call, and the ruling this
    // pin exists for is about WHICH two - both are app-wide single-flights that
    // must not be copied per worker. A third needs the header's justifying
    // paragraph before it needs this line changed.
    expect([...MAIN_CALL_KINDS]).toEqual([
      "main/auth-revalidate",
      "main/mint-credential",
    ]);
  });

  it("is derived from the coverage record, so there is one place to add a member", () => {
    // The list is `Object.keys` of the compile-time coverage record, and the
    // record is a mapped type over the union - so a member added to
    // `MainCallMap` fails to compile at the record, and one added to the record
    // that the map lacks is an excess property. This asserts the DERIVATION
    // held: every kind has a response parser, and the parser table is itself
    // mapped over the union.
    expect([...MAIN_CALL_KINDS].sort()).toEqual(
      Object.keys(MAIN_CALL_RESPONSE_PARSERS).sort(),
    );
  });

  it("builds an envelope whose kind matches the one asked for", () => {
    for (const kind of MAIN_CALL_KINDS) {
      const built =
        kind === "main/auth-revalidate"
          ? buildMainCall(kind, {})
          : buildMainCall(kind, {
              mint: { hostId: "host-1", reason: "absent" },
            });
      expect(built.kind).toBe(kind);
    }
  });
});

describe("frame guards", () => {
  it("recognises a worker->main call and a main->worker answer", () => {
    // The pair that carries the whole worker->main direction. A guard that did
    // not know these tags would DROP them - silently, by design, since a frame
    // that fails the check is dropped rather than thrown on - and the call's
    // promise would hang with nothing logged on either thread.
    expect(
      isWorkerToMainFrame({
        frame: "main-call",
        callId: 1,
        call: { kind: "main/auth-revalidate", request: {} },
      }),
    ).toBe(true);
    expect(
      isMainToWorkerFrame({
        frame: "main-result",
        callId: 1,
        result: { outcome: "ok", value: { outcome: "rotated" } },
      }),
    ).toBe(true);
  });

  it("rejects a frame of the wrong direction, and one with no callId", () => {
    // Each guard answers for ITS direction only. A guard that accepted the
    // other side's tags would let an endpoint route a frame it has no table
    // for, which presents as a reply that vanishes.
    expect(
      isMainToWorkerFrame({
        frame: "main-call",
        callId: 1,
        call: { kind: "main/auth-revalidate", request: {} },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainFrame({
        frame: "main-result",
        callId: 1,
        result: { outcome: "ok", value: {} },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainFrame({
        frame: "main-call",
        call: { kind: "main/auth-revalidate", request: {} },
      }),
    ).toBe(false);
  });
});

describe("MAIN_CALL_RESPONSE_PARSERS", () => {
  it("accepts each revalidate outcome the contract defines and nothing else", () => {
    const parse = MAIN_CALL_RESPONSE_PARSERS["main/auth-revalidate"];
    for (const outcome of ["rotated", "rejected", "network-error"]) {
      expect(parse({ outcome })).toEqual({ outcome });
    }
    // A member the transport does not handle must not reach it. `unchanged`
    // is the specific mistake this guards: it reads like a real outcome and is
    // not one, and a transport handed it would fall through every branch.
    expect(parse({ outcome: "unchanged" })).toBeNull();
    expect(parse({})).toBeNull();
  });

  it("refuses a provisioned mint that is missing its tokens", () => {
    const parse = MAIN_CALL_RESPONSE_PARSERS["main/mint-credential"];
    const provisioned = {
      kind: "provisioned",
      token: "t",
      refreshToken: "r",
      familyId: "f",
      provisionedAt: "2026-08-29T00:00:00.000Z",
      expiresIn: 900,
    };
    expect(parse({ outcome: provisioned })).toEqual({ outcome: provisioned });

    // The reason this parser rebuilds field by field instead of asserting: a
    // payload that merely CLAIMS `provisioned` while missing its credential
    // would otherwise reach the transport as a credential it cannot use, and
    // fail at the dial rather than at the boundary.
    const { refreshToken: _dropped, ...withoutRefresh } = provisioned;
    expect(parse({ outcome: withoutRefresh })).toBeNull();
    expect(parse({ outcome: { kind: "pending-elsewhere" } })).toBeNull();
    expect(parse({ outcome: { kind: "unavailable" } })).toEqual({
      outcome: { kind: "unavailable" },
    });
  });
});
