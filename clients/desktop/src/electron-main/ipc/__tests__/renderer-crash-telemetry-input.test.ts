import { describe, expect, it } from "vitest";
import { parseRendererCrashTelemetryInput } from "../../../ipc-contracts/renderer-crash-telemetry";

describe("parseRendererCrashTelemetryInput", () => {
  const validInput = {
    appVersion: "0.1.16",
    buildRevision: "a".repeat(40),
    componentStack: "\n    at Boom (/app.tsx:1:1)",
    correlationId: "correlation-id",
    fingerprint: "fp:v1:test",
    timestamp: 1_777_000_000_000,
  };

  it("accepts the complete RootErrorBoundary payload", () => {
    expect(parseRendererCrashTelemetryInput(validInput)).toEqual(validInput);
  });

  it("accepts missing release identity as explicit nulls", () => {
    expect(
      parseRendererCrashTelemetryInput({
        ...validInput,
        appVersion: null,
        buildRevision: null,
      }),
    ).toEqual({ ...validInput, appVersion: null, buildRevision: null });
  });

  it("rejects unbounded component stacks and unknown fields", () => {
    expect(() =>
      parseRendererCrashTelemetryInput({
        ...validInput,
        componentStack: "x".repeat(64_001),
      }),
    ).toThrow(/componentStack/);
    expect(() =>
      parseRendererCrashTelemetryInput({ ...validInput, secret: "nope" }),
    ).toThrow(/unknown key/);
  });
});
