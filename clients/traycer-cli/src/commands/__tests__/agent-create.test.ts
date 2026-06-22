import { describe, expect, it } from "vitest";
import { parseAgentCreateWorkspace } from "../agent-create";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

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
