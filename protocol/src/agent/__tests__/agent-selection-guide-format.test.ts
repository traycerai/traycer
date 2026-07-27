import { describe, expect, it } from "vitest";
import type {
  AgentSelectionGuideResponse,
  AgentSelectionGuideResponseSource,
} from "@traycer/protocol/host";
import { formatAgentSelectionGuideResponse } from "../agent-selection-guide-format";

const GLOBAL_PATH = "/Users/me/.traycer/agent-selection-guide.md";
const APP_DIR = "/Users/me/repos/app";

describe("formatAgentSelectionGuideResponse", () => {
  it("returns the message when not found", () => {
    const response: AgentSelectionGuideResponse = {
      status: "not_found",
      message: "No agent selection guide found.",
    };
    expect(formatAgentSelectionGuideResponse(response)).toBe(
      "No agent selection guide found.",
    );
  });

  it("renders the global guide as plain attributed content", () => {
    const text = formatAgentSelectionGuideResponse(
      found([globalSource("global body", 1)]),
    );
    expect(text).toBe(
      `Agent selection instructions from ${GLOBAL_PATH}:\n\nglobal body`,
    );
  });

  it("ignores legacy workspace sources from older hosts and renders only global", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 2),
        globalSource("global body", 1),
      ]),
    );
    expect(text).toBe(
      `Agent selection instructions from ${GLOBAL_PATH}:\n\nglobal body`,
    );
    expect(text).not.toContain("app body");
  });

  it("reports no guide when an older host sends only workspace sources", () => {
    const text = formatAgentSelectionGuideResponse(
      found([workspaceSource(APP_DIR, "app body", 2)]),
    );
    expect(text).toBe("No agent selection guide found.");
  });
});

function workspaceSource(
  workspacePath: string,
  content: string,
  priority: number,
): AgentSelectionGuideResponseSource {
  return {
    kind: "workspace",
    workspacePath,
    path: `${workspacePath}/.traycer/agent-selection-guide.md`,
    priority,
    content,
  };
}

function globalSource(
  content: string,
  priority: number,
): AgentSelectionGuideResponseSource {
  return { kind: "global", path: GLOBAL_PATH, priority, content };
}

function found(
  sources: readonly AgentSelectionGuideResponseSource[],
): AgentSelectionGuideResponse {
  return { status: "found", sources: [...sources] };
}
