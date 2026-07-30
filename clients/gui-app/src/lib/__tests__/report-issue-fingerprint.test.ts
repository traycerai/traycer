import { describe, expect, it } from "vitest";
import {
  computeReportIssueFingerprintV1,
  normalizeStackFamily,
} from "@/lib/report-issue-fingerprint";

const BASE = {
  errorCode: "RPC_ERROR",
  operation: "chat.subscribe",
  causalProvider: "claude-code",
  subtype: "HostRpcError",
};

/** First 14 chars = `fp:v1:` + the 8-hex identity hash, before the stack suffix. */
function identityPrefix(fingerprint: string): string {
  return fingerprint.slice(0, 14);
}

describe("computeReportIssueFingerprintV1", () => {
  it("emits a versioned fp:v1 string", () => {
    const fp = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>connect",
    });
    expect(fp.startsWith("fp:v1:")).toBe(true);
  });

  it("stays stable across repeated computations with identical inputs (no version/platform inputs at all)", () => {
    const first = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>connect",
    });
    const second = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>connect",
    });
    expect(first).toBe(second);
  });

  it("weights identity over stack shape: a stack change alone only perturbs the low-weight suffix", () => {
    const withStackA = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>connect",
    });
    const withStackB = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>reconnect>connect",
    });

    expect(identityPrefix(withStackA)).toBe(identityPrefix(withStackB));
    expect(withStackA).not.toBe(withStackB);
  });

  it("changes identity when the error code differs, even with the same stack", () => {
    const fpA = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: "subscribe>connect",
    });
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      errorCode: "TIMEOUT",
      normalizedStackFamily: "subscribe>connect",
    });

    expect(identityPrefix(fpA)).not.toBe(identityPrefix(fpB));
  });

  it("changes identity when the causal provider/harness differs", () => {
    const fpA = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: null,
    });
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      causalProvider: "codex",
      normalizedStackFamily: null,
    });

    expect(identityPrefix(fpA)).not.toBe(identityPrefix(fpB));
  });

  it("changes identity when the operation differs", () => {
    const fpA = computeReportIssueFingerprintV1({
      ...BASE,
      normalizedStackFamily: null,
    });
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      operation: "chat.send",
      normalizedStackFamily: null,
    });

    expect(identityPrefix(fpA)).not.toBe(identityPrefix(fpB));
  });
});

describe("normalizeStackFamily", () => {
  it("returns null for a missing stack", () => {
    expect(normalizeStackFamily(null)).toBeNull();
  });

  it("strips line/column numbers and file paths, keeping frame names in order", () => {
    const stackA = [
      "Error: boom",
      "    at ChatRuntime.subscribe (/Users/alice/app/chat-runtime.ts:42:11)",
      "    at TabHostProvider (/Users/alice/app/tab-host-provider.tsx:88:3)",
    ].join("\n");
    const stackB = [
      "Error: boom",
      "    at ChatRuntime.subscribe (webpack:///./src/chat-runtime.ts:9001:4)",
      "    at TabHostProvider (webpack:///./src/tab-host-provider.tsx:1:1)",
    ].join("\n");

    expect(normalizeStackFamily(stackA)).toBe(normalizeStackFamily(stackB));
    expect(normalizeStackFamily(stackA)).toBe(
      "ChatRuntime.subscribe>TabHostProvider",
    );
  });

  it("keeps frame position for anonymous frames instead of dropping them", () => {
    const stack = [
      "Error: boom",
      "    at named (/x/a.ts:1:1)",
      "    at /x/b.ts:2:2",
      "    at named (/x/c.ts:3:3)",
    ].join("\n");

    expect(normalizeStackFamily(stack)).toBe("named><anonymous>>named");
  });
});
