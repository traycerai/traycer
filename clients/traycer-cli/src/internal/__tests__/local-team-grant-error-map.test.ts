import { describe, expect, it } from "vitest";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
} from "../../../../shared/host-transport/local-open-auth";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { toAgentCliError } from "../host-rpc";
import { CLI_ERROR_CODES, EXPECTED_CLI_ERROR_CODES } from "../../runner/errors";

function membershipFatal(code: string, reason: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: reason,
    requestId: "req-team-admission",
    method: "agent.list",
    fatalDetails: {
      code,
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(code === TEAM_MEMBERSHIP_UNAVAILABLE ? { retryable: true } : {}),
    },
  });
}

describe("CLI mapping for local team computer admission", () => {
  it("maps a typed nonmember refusal to the actionable sign-in error without exposing host text", async () => {
    const privateHostText =
      "Membership denied for account user-123@example.test on team team-secret-456";
    const mapped = await toAgentCliError(
      Promise.reject(
        membershipFatal(TEAM_MEMBERSHIP_REQUIRED, privateHostText),
      ),
    ).catch((error: unknown) => error);

    expect(mapped).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
      message: `traycer: ${TEAM_MEMBERSHIP_REQUIRED_MESSAGE} Run \`traycer login\` to switch accounts.`,
      details: null,
      exitCode: 1,
    });
    expect(
      EXPECTED_CLI_ERROR_CODES.has(CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED),
    ).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain("user-123@example.test");
    expect(JSON.stringify(mapped)).not.toContain("team-secret-456");
  });

  it("maps typed membership lookup outages to the retryable CLI error with fixed copy", async () => {
    const privateHostText =
      "Cloud membership lookup failed for account user-123@example.test";
    const mapped = await toAgentCliError(
      Promise.reject(
        membershipFatal(TEAM_MEMBERSHIP_UNAVAILABLE, privateHostText),
      ),
    ).catch((error: unknown) => error);

    expect(mapped).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message:
        "traycer: could not reach the cloud to check team membership. Try the command again.",
      details: null,
      exitCode: 1,
    });
    expect(
      EXPECTED_CLI_ERROR_CODES.has(CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE),
    ).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain("user-123@example.test");
  });
});
