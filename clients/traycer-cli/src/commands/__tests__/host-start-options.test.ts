import { describe, expect, it } from "vitest";
import { hostStartOptionsFromCommand } from "../../index";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";

describe("hostStartOptionsFromCommand — mixed-version service invocations", () => {
  it("accepts an old plist with no identity arguments as an ordinary supervisor start", () => {
    expect(
      hostStartOptionsFromCommand({
        environment: "production",
        cwd: null,
        serviceLabel: null,
        transitionId: null,
        probeNonce: null,
      }),
    ).toEqual({ environment: "production", cwd: null });
  });

  it("accepts a new registration's label without accidentally granting probe authority", () => {
    expect(
      hostStartOptionsFromCommand({
        environment: "production",
        cwd: "/tmp/host",
        serviceLabel: "ai.traycer.host.agent",
        transitionId: null,
        probeNonce: null,
      }),
    ).toEqual({
      environment: "production",
      cwd: "/tmp/host",
      serviceLabel: "ai.traycer.host.agent",
    });
  });

  it("requires all probe correlation fields before bypassing the incumbent guard", () => {
    expect(() =>
      hostStartOptionsFromCommand({
        environment: "production",
        cwd: null,
        serviceLabel: "ai.traycer.host.fallback",
        transitionId: "transition-1",
        probeNonce: null,
      }),
    ).toThrow(CliError);
    try {
      hostStartOptionsFromCommand({
        environment: "production",
        cwd: null,
        serviceLabel: "ai.traycer.host.fallback",
        transitionId: "transition-1",
        probeNonce: null,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      if (error instanceof CliError) {
        expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      }
    }
  });

  it("constructs probe mode only for a fully correlated invocation", () => {
    expect(
      hostStartOptionsFromCommand({
        environment: "staging",
        cwd: null,
        serviceLabel: "ai.traycer.host.staging.fallback",
        transitionId: "transition-1",
        probeNonce: "nonce-1",
      }),
    ).toEqual({
      environment: "staging",
      cwd: null,
      probe: {
        serviceLabel: "ai.traycer.host.staging.fallback",
        transitionId: "transition-1",
        probeNonce: "nonce-1",
      },
    });
  });
});
