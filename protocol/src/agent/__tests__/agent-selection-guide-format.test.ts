import { describe, expect, it } from "vitest";
import type {
  AgentSelectionGuideResponse,
  AgentSelectionGuideResponseSource,
} from "@traycer/protocol/host";
import {
  A2A_PERMISSION_MODE_INSTRUCTION,
  formatAgentSelectionGuideResponse,
} from "../agent-selection-guide-format";

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
      `No agent selection guide found.\n\nPermission mode: ${A2A_PERMISSION_MODE_INSTRUCTION}`,
    );
  });

  it("renders the global guide as plain attributed content", () => {
    const text = formatAgentSelectionGuideResponse(
      found([globalSource("global body", 1)]),
    );
    expect(text).toBe(
      `Agent selection instructions from ${GLOBAL_PATH}:\n\nglobal body\n\nPermission mode: ${A2A_PERMISSION_MODE_INSTRUCTION}`,
    );
  });

  it("layers a workspace guide over global, ordered by priority", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        globalSource("global body", 1),
        workspaceSource(APP_DIR, "app body", 2),
      ]),
    );
    expect(text).toContain("take precedence and override global");
    expect(text).toContain("apply only to files under the workspace path");
    expect(text).not.toContain("Multiple workspaces provide instructions");
    expect(text.indexOf(`## Workspace instructions — ${APP_DIR}`)).toBeLessThan(
      text.indexOf("## Global instructions"),
    );
    expect(text).toContain("app body");
    expect(text).toContain("global body");
  });

  it("adds workspace selection guidance for multiple workspaces", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 3),
        workspaceSource(LIB_DIR, "lib body", 2),
        globalSource("global body", 1),
      ]),
    );
    expect(text).toContain(
      "Files outside that path follow the global instructions unless another workspace guide applies",
    );
    expect(text).toContain(
      "If more than one workspace contains the file, use the most specific workspace",
    );
    expect(text).toContain(`## Workspace instructions — ${APP_DIR}`);
    expect(text).toContain(`## Workspace instructions — ${LIB_DIR}`);
    expect(text).toContain("## Global instructions");
  });

  it("states precedence when nested workspace guides both apply", () => {
    const nestedWorkspace = `${APP_DIR}/packages/web`;
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 2),
        workspaceSource(nestedWorkspace, "web body", 3),
        globalSource("global body", 1),
      ]),
    );

    expect(text).toContain("the most specific workspace");
    expect(text).toContain(
      "If more than one workspace contains the file, use the most specific workspace",
    );
    const nestedHeading = `## Workspace instructions — ${nestedWorkspace} (`;
    const parentHeading = `## Workspace instructions — ${APP_DIR} (`;
    expect(text).toContain(nestedHeading);
    expect(text).toContain(parentHeading);
    expect(text.indexOf(nestedHeading)).toBeLessThan(
      text.indexOf(parentHeading),
    );
  });

  it("renders workspace-only guides without global precedence framing", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 2),
        workspaceSource(LIB_DIR, "lib body", 1),
      ]),
    );
    expect(text).toContain("Multiple workspaces provide instructions below");
    expect(text).not.toContain("override global");
    expect(text).not.toContain("## Global");
  });

  it("renders a lone workspace guide as plain attributed content", () => {
    const text = formatAgentSelectionGuideResponse(
      found([workspaceSource(APP_DIR, "app body", 2)]),
    );
    expect(text).toBe(
      `Agent selection instructions from ${APP_DIR}/.traycer/agent-selection-guide.md:\n\napp body\n\nPermission mode: ${A2A_PERMISSION_MODE_INSTRUCTION}`,
    );
  });

  it("forbids inferred permission-mode overrides", () => {
    const text = formatAgentSelectionGuideResponse(
      found([globalSource("implementation guidance only", 1)]),
    );

    expect(text).toContain("Use `full_access` unless");
    expect(text).toContain("explicitly instructs you");
    expect(text).toContain("never infer a more restrictive permission mode");
  });

  it("appends the permission invariant after layered guides", () => {
    const text = formatAgentSelectionGuideResponse(
      found([
        workspaceSource(APP_DIR, "app body", 2),
        globalSource("global body", 1),
      ]),
    );

    expect(text.endsWith(A2A_PERMISSION_MODE_INSTRUCTION)).toBe(true);
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
