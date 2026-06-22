import { describe, expect, it } from "vitest";
import type {
  AgentSelectionGuideResponse,
  AgentSelectionGuideResponseSource,
} from "@traycer/protocol/host";
import { formatAgentSelectionGuideResponse } from "../agent-selection-guide-format";

const GLOBAL_PATH = "/Users/me/.traycer/agent-selection-guide.md";
const APP_DIR = "/Users/me/repos/app";
const LIB_DIR = "/Users/me/repos/lib";

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

  it("renders a lone global guide as plain attributed content, no precedence framing", () => {
    const text = formatAgentSelectionGuideResponse(
      found([globalSource("global body", 1)]),
    );
    expect(text).toBe(
      `Agent selection instructions from ${GLOBAL_PATH}:\n\nglobal body`,
    );
    expect(text).not.toContain("##");
    expect(text).not.toContain("take precedence");
  });

  it("layers a workspace guide over global, ordered by priority not array order", () => {
    // Global first in the array but lower priority - the workspace must still win.
    const text = formatAgentSelectionGuideResponse(
      found([
        globalSource("global body", 1),
        workspaceSource(APP_DIR, "app body", 2),
      ]),
    );
    expect(text).toContain("take precedence and override global");
    expect(text).not.toContain("Multiple workspaces provide");
    expect(text.indexOf(`## Workspace instructions — ${APP_DIR}`)).toBeLessThan(
      text.indexOf("## Global instructions"),
    );
  });

  it("adds the per-workspace paragraph with two workspace blocks plus global", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 3),
        workspaceSource(LIB_DIR, "lib body", 2),
        globalSource("global body", 1),
      ]),
    );
    expect(text).toContain(
      "Multiple workspaces provide their own instructions",
    );
    expect(text).toContain(`## Workspace instructions — ${APP_DIR}`);
    expect(text).toContain(`## Workspace instructions — ${LIB_DIR}`);
    expect(text).toContain("## Global instructions");
  });

  it("drops global references when no global guide is present", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 2),
        workspaceSource(LIB_DIR, "lib body", 1),
      ]),
    );
    expect(text).toContain("Each workspace's instructions apply");
    expect(text).not.toContain("global");
    expect(text).not.toContain("## Global");
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
