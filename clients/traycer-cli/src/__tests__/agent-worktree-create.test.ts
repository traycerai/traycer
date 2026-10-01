import { describe, expect, it, vi, type Mock } from "vitest";
import type { AgentWorktreeCreatePolicy } from "@traycer/protocol/config/schema";
import {
  agentWorktreeCreateOffered,
  agentWorktreeCreatePolicyFor,
  assertAgentWorktreeCreateAllowed,
  isAgentSession,
  WORKTREE_CREATE_COMMAND_PATH,
} from "../agent-worktree-create";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";

// The leaf module is driven with explicit env maps and an injected
// `readPolicy`, so nothing here reads `process.env` (this suite runs inside a
// live Traycer agent session, which already has `TRAYCER_AGENT_ID` set) or the
// user's real `~/.traycer/cli/config.json`.

const AGENT_ENV: Readonly<Record<string, string | undefined>> = {
  TRAYCER_AGENT_ID: "agent-1",
};
const PERSON_ENV: Readonly<Record<string, string | undefined>> = {};

function policyReader(
  policy: AgentWorktreeCreatePolicy,
): Mock<() => AgentWorktreeCreatePolicy> {
  return vi.fn((): AgentWorktreeCreatePolicy => policy);
}

function captureCliError(run: () => void): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected the call to throw a CliError, but it returned");
}

describe("isAgentSession", () => {
  it("is false when TRAYCER_AGENT_ID is missing", () => {
    expect(isAgentSession({})).toBe(false);
    expect(isAgentSession({ TRAYCER_AGENT_ID: undefined })).toBe(false);
  });

  it("is false when TRAYCER_AGENT_ID is empty", () => {
    expect(isAgentSession({ TRAYCER_AGENT_ID: "" })).toBe(false);
  });

  it("is false when TRAYCER_AGENT_ID is whitespace only", () => {
    expect(isAgentSession({ TRAYCER_AGENT_ID: "   " })).toBe(false);
    expect(isAgentSession({ TRAYCER_AGENT_ID: "\t\n" })).toBe(false);
  });

  it("is true when TRAYCER_AGENT_ID carries an id", () => {
    expect(isAgentSession({ TRAYCER_AGENT_ID: "agent-1" })).toBe(true);
  });
});

describe("agentWorktreeCreatePolicyFor", () => {
  it("is null for a person, and never reads the policy", () => {
    const readPolicy = policyReader("never");
    expect(agentWorktreeCreatePolicyFor(PERSON_ENV, readPolicy)).toBeNull();
    expect(
      agentWorktreeCreatePolicyFor({ TRAYCER_AGENT_ID: "" }, readPolicy),
    ).toBeNull();
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it.each(["allow", "ask", "never"] as const)(
    "is the %s policy for an agent session",
    (policy) => {
      const readPolicy = policyReader(policy);
      expect(agentWorktreeCreatePolicyFor(AGENT_ENV, readPolicy)).toBe(policy);
      expect(readPolicy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("agentWorktreeCreateOffered", () => {
  it("is true for a person even when the policy would be never, without reading it", () => {
    const readPolicy = policyReader("never");
    expect(agentWorktreeCreateOffered(PERSON_ENV, readPolicy)).toBe(true);
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it("is true for an agent session under allow", () => {
    expect(agentWorktreeCreateOffered(AGENT_ENV, policyReader("allow"))).toBe(
      true,
    );
  });

  it("is true for an agent session under ask", () => {
    expect(agentWorktreeCreateOffered(AGENT_ENV, policyReader("ask"))).toBe(
      true,
    );
  });

  it("is false for an agent session under never", () => {
    expect(agentWorktreeCreateOffered(AGENT_ENV, policyReader("never"))).toBe(
      false,
    );
  });
});

describe("assertAgentWorktreeCreateAllowed", () => {
  it("names the command path 'worktree create'", () => {
    expect(WORKTREE_CREATE_COMMAND_PATH).toBe("worktree create");
  });

  it.each([
    "worktree list",
    "worktree delete",
    "agent create",
    "workspace list",
  ])(
    "is a no-op for '%s' even for an agent under never, without reading the policy",
    (commandPath) => {
      const readPolicy = policyReader("never");
      expect(() =>
        assertAgentWorktreeCreateAllowed(commandPath, AGENT_ENV, readPolicy),
      ).not.toThrow();
      expect(readPolicy).not.toHaveBeenCalled();
    },
  );

  it("is a no-op for a person under never", () => {
    const readPolicy = policyReader("never");
    expect(() =>
      assertAgentWorktreeCreateAllowed(
        WORKTREE_CREATE_COMMAND_PATH,
        PERSON_ENV,
        readPolicy,
      ),
    ).not.toThrow();
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it("is a no-op for a person whose TRAYCER_AGENT_ID is empty, under ask", () => {
    expect(() =>
      assertAgentWorktreeCreateAllowed(
        WORKTREE_CREATE_COMMAND_PATH,
        { TRAYCER_AGENT_ID: "" },
        policyReader("ask"),
      ),
    ).not.toThrow();
  });

  it("is a no-op for an agent under allow", () => {
    expect(() =>
      assertAgentWorktreeCreateAllowed(
        WORKTREE_CREATE_COMMAND_PATH,
        AGENT_ENV,
        policyReader("allow"),
      ),
    ).not.toThrow();
  });

  it("refuses an agent under never with FORBIDDEN, exit code 1, and guidance to stay put", () => {
    const error = captureCliError(() =>
      assertAgentWorktreeCreateAllowed(
        WORKTREE_CREATE_COMMAND_PATH,
        AGENT_ENV,
        policyReader("never"),
      ),
    );
    expect(error.code).toBe(CLI_ERROR_CODES.FORBIDDEN);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("turned off for agents on this host");
    expect(error.message).toContain("git worktree add");
    // The never refusal must not point at a tool that is also refused.
    expect(error.message).not.toContain("traycer_create_worktree");
  });

  it("refuses an agent under ask with FORBIDDEN, exit code 1, and points at the asking tool", () => {
    const error = captureCliError(() =>
      assertAgentWorktreeCreateAllowed(
        WORKTREE_CREATE_COMMAND_PATH,
        AGENT_ENV,
        policyReader("ask"),
      ),
    );
    expect(error.code).toBe(CLI_ERROR_CODES.FORBIDDEN);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("needs the user's approval");
    expect(error.message).toContain("traycer_create_worktree");
    expect(error.message).not.toContain("turned off for agents on this host");
  });
});
