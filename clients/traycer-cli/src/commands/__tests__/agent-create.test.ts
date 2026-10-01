import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorktreeCreatePolicy } from "@traycer/protocol/config/schema";
import { parseAgentCreateWorkspace } from "../agent-create";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

// The user's Agent worktrees setting (`worktrees.agentCreate`), as the
// relative-path error reads it for an agent session. A mock rather than a real
// config file so no test here reads the real `~/.traycer/cli/config.json`.
const worktreePolicy = vi.hoisted(() => {
  const state: { current: AgentWorktreeCreatePolicy } = { current: "allow" };
  return {
    state,
    read: vi.fn((): AgentWorktreeCreatePolicy => state.current),
  };
});

vi.mock("../../agent-worktree-create", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agent-worktree-create")>();
  return {
    ...actual,
    readAgentWorktreeCreatePolicy: worktreePolicy.read,
  };
});

// This suite runs inside a live Traycer agent session, which already has
// `TRAYCER_AGENT_ID` set: pin it to "" (a person) so the outcome does not
// depend on the session running it. Agent cases stub it explicitly.
beforeEach(() => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  worktreePolicy.state.current = "allow";
  worktreePolicy.read.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent create workspace CLI parsing", () => {
  it("treats --cwd as a run path with no separate source workspace", () => {
    expect(
      parseAgentCreateWorkspace({
        cwd: "/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
        workspacePaths: [],
        workspaceEntries: [],
      }),
    ).toEqual({
      entries: [
        {
          path: "/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
          workspacePath: null,
        },
      ],
    });
  });

  it("rejects alias-style workspace entries that are not source paths", () => {
    expect(() =>
      parseAgentCreateWorkspace({
        cwd: null,
        workspacePaths: [],
        workspaceEntries: [
          "traycer=/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
        ],
      }),
    ).toThrow(CliError);
    try {
      parseAgentCreateWorkspace({
        cwd: null,
        workspacePaths: [],
        workspaceEntries: [
          "traycer=/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      if (error instanceof CliError) {
        expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      }
    }
  });

  it("supports exact source-to-worktree bindings", () => {
    expect(
      parseAgentCreateWorkspace({
        cwd: null,
        workspacePaths: [],
        workspaceEntries: [
          "/Users/tgill/src/traycer=/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
        ],
      }),
    ).toEqual({
      entries: [
        {
          path: "/Users/tgill/.traycer/worktrees/traycerai__traycer/report",
          workspacePath: "/Users/tgill/src/traycer",
        },
      ],
    });
  });
});

describe("agent create: relative path error", () => {
  function relativeCwdError(): CliError {
    try {
      parseAgentCreateWorkspace({
        cwd: "relative/path",
        workspacePaths: [],
        workspaceEntries: [],
      });
    } catch (error) {
      if (error instanceof CliError) return error;
      throw error;
    }
    throw new Error("expected a relative --cwd to be rejected");
  }

  const OFFERED_SCENARIOS: ReadonlyArray<
    readonly [string, string, AgentWorktreeCreatePolicy]
  > = [
    ["a person under never", "", "never"],
    ["an agent session under allow", "agent-fixture", "allow"],
    ["an agent session under ask", "agent-fixture", "ask"],
  ];

  it.each(OFFERED_SCENARIOS)(
    "points at `traycer worktree create` for %s",
    (_label, agentId, policy) => {
      vi.stubEnv("TRAYCER_AGENT_ID", agentId);
      worktreePolicy.state.current = policy;

      const error = relativeCwdError();

      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(error.exitCode).toBe(1);
      expect(error.message).toContain("must be an absolute path");
      expect(error.message).toContain(
        "Use --cwd <worktree-path> for a path returned by traycer worktree create, or --workspace-entry <source-path>=<run-path> for an exact binding.",
      );
    },
  );

  it("never consults the policy for a person", () => {
    worktreePolicy.state.current = "never";
    relativeCwdError();
    expect(worktreePolicy.read).not.toHaveBeenCalled();
  });

  it("points at an existing folder, not at `traycer worktree create`, for an agent session under never", () => {
    vi.stubEnv("TRAYCER_AGENT_ID", "agent-fixture");
    worktreePolicy.state.current = "never";

    const error = relativeCwdError();

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("must be an absolute path");
    expect(error.message).toContain(
      "Use --cwd <path> for a folder that already exists, or --workspace-entry <source-path>=<run-path> for an exact binding.",
    );
    expect(error.message).not.toContain("worktree create");
  });
});
