import { describe, expect, it } from "vitest";
import {
  UPDATE_DISPATCH_ACK_VERSION,
  decodeUpdateDispatchAck,
  isValidUpdateDispatchAckNonce,
  updateDispatchAckPath,
} from "../host-update-ack";

// Direct unit suite for the §5.2.8 dispatch-ACK contract.

const VALID = {
  v: UPDATE_DISPATCH_ACK_VERSION,
  nonce: "nonce-abcdefgh",
  attemptId: "attempt-1",
  generation: 2,
  sequence: 5,
  claimedAt: "2026-01-01T00:00:00.000Z",
};

describe("updateDispatchAckPath", () => {
  it("resolves inside the host home it is given", () => {
    // Parameterized by the directory, not by an `Environment` — the CLI and
    // the host resolve that directory through deliberately different
    // machinery, and taking it as input is what makes the agreement
    // structural instead of a slot rule copied into a third place.
    expect(updateDispatchAckPath("/tmp/host-home")).toBe(
      "/tmp/host-home/update-dispatch-ack.json",
    );
  });
});

describe("decodeUpdateDispatchAck", () => {
  it("decodes a well-formed ACK", () => {
    const decoded = decodeUpdateDispatchAck(JSON.stringify(VALID));
    expect(decoded).toEqual({ kind: "valid", ack: VALID });
  });

  it("tolerates trailing whitespace, which the writer emits", () => {
    // The writer appends a newline. A decoder that choked on its own writer's
    // output would fail only in production.
    expect(decodeUpdateDispatchAck(`${JSON.stringify(VALID)}\n`).kind).toBe(
      "valid",
    );
  });

  it.each([
    ["not json at all", "{{{"],
    ["a truncated write", '{"v":1,"nonce":"nonce-abc'],
  ])("reports %s as unparseable-json", (_label, text) => {
    expect(decodeUpdateDispatchAck(text)).toEqual({
      kind: "invalid",
      reason: "unparseable-json",
    });
  });

  it("reports a future version as unsupported, not as malformed", () => {
    // Checked BEFORE the fields: a future shape is not broken, it is one this
    // build has no business interpreting, and saying so is more useful than
    // naming whichever field happens to differ.
    expect(
      decodeUpdateDispatchAck(JSON.stringify({ ...VALID, v: 99 })),
    ).toEqual({ kind: "invalid", reason: "unsupported-version" });
  });

  it.each([
    ["a missing attemptId", { ...VALID, attemptId: undefined }],
    ["an empty attemptId", { ...VALID, attemptId: "" }],
    ["a non-integer generation", { ...VALID, generation: 1.5 }],
    ["a NaN sequence", { ...VALID, sequence: Number.NaN }],
    ["a missing claimedAt", { ...VALID, claimedAt: undefined }],
    ["an illegal nonce", { ...VALID, nonce: "../../etc/passwd" }],
  ])("rejects %s", (_label, payload) => {
    // Every one of these would otherwise become a correlation the resolver
    // could act on. `NaN` and `1.5` are both `number`, which is why the
    // decoder checks `Number.isInteger` rather than `typeof`.
    expect(decodeUpdateDispatchAck(JSON.stringify(payload))).toEqual({
      kind: "invalid",
      reason: "malformed-fields",
    });
  });

  it.each([
    ["an array", "[]"],
    ["a bare string", '"nope"'],
    ["null", "null"],
  ])("rejects %s as malformed rather than throwing", (_label, text) => {
    // Total by contract: the caller is a bounded wait that must keep its own
    // deadline rather than unwind on a hostile file.
    expect(decodeUpdateDispatchAck(text).kind).toBe("invalid");
  });
});

describe("isValidUpdateDispatchAckNonce", () => {
  it("accepts ordinary token nonces", () => {
    expect(isValidUpdateDispatchAckNonce("nonce-abcdefgh")).toBe(true);
    expect(isValidUpdateDispatchAckNonce("A".repeat(128))).toBe(true);
  });

  it.each([
    ["a path separator", "abc/def-ghij"],
    ["a shell metacharacter", "abc;rm -rf /"],
    ["whitespace", "abc defghij"],
    ["too short", "abc"],
    ["over-long", "A".repeat(129)],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    // A closed character class rather than a length check, because this value
    // travels on a command line: no quoting rule, shell metacharacter or path
    // separator can be part of a legal nonce. The filename is fixed, so this
    // is defence in depth rather than traversal protection — but the cheapest
    // moment to refuse a hostile value is before it is written anywhere.
    expect(isValidUpdateDispatchAckNonce(value)).toBe(false);
  });
});
