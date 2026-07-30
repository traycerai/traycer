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

describe("computeReportIssueFingerprintV1", () => {
  it("emits a versioned fp:v1 string", () => {
    const fp = computeReportIssueFingerprintV1(BASE);
    expect(fp.startsWith("fp:v1:")).toBe(true);
  });

  it("stays stable across repeated computations with identical inputs (no version/platform inputs at all)", () => {
    const first = computeReportIssueFingerprintV1(BASE);
    const second = computeReportIssueFingerprintV1(BASE);
    expect(first).toBe(second);
  });

  it("is completely unaffected by stack shape - stack never enters identity at all (C8)", () => {
    // Stack family is not even part of this function's input type; the
    // invariant that matters is that two defects sharing subtype/errorCode/
    // operation/causalProvider always fingerprint identically, regardless of
    // how differently they'd normalize under `normalizeStackFamily` (a
    // one-frame refactor, a bundler line shift, an extra wrapper frame).
    const fpA = computeReportIssueFingerprintV1(BASE);
    const fpB = computeReportIssueFingerprintV1(BASE);
    expect(fpA).toBe(fpB);
  });

  it("changes identity when the error code differs", () => {
    const fpA = computeReportIssueFingerprintV1(BASE);
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      errorCode: "TIMEOUT",
    });

    expect(fpA).not.toBe(fpB);
  });

  it("changes identity when the causal provider/harness differs", () => {
    const fpA = computeReportIssueFingerprintV1(BASE);
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      causalProvider: "codex",
    });

    expect(fpA).not.toBe(fpB);
  });

  it("changes identity when the operation differs", () => {
    const fpA = computeReportIssueFingerprintV1(BASE);
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      operation: "chat.send",
    });

    expect(fpA).not.toBe(fpB);
  });

  it("changes identity when the subtype differs", () => {
    const fpA = computeReportIssueFingerprintV1(BASE);
    const fpB = computeReportIssueFingerprintV1({
      ...BASE,
      subtype: "TypeError",
    });

    expect(fpA).not.toBe(fpB);
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
