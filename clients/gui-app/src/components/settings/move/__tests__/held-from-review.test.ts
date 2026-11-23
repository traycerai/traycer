import { describe, expect, it } from "vitest";
import type { ReviewHeldEntry } from "@traycer-clients/shared/environment/environment-review";
import { heldCommandLine } from "@/components/settings/move/held-from-review";

function heldRemoval(kind: string, key: string): ReviewHeldEntry {
  return {
    entryId: "held-1",
    reason: "needs_review",
    kind,
    key,
    os: "any",
    hostId: "host-proposer",
    heldAt: 1,
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    op: "delete",
    heldRevision: 8,
    liveRevision: 3,
  };
}

function heldPut(
  kind: string,
  key: string,
  value: string,
  harness: string | null,
): ReviewHeldEntry {
  return {
    ...heldRemoval(kind, key),
    reason: "executable_entry",
    harness,
    value,
    op: "put",
  };
}

describe("heldCommandLine for a held removal", () => {
  it.each([
    ["mcp_server", "MCP server"],
    ["env_override", "variable"],
    ["browser_agent_access", "browser agent access"],
    ["constructor", "constructor"],
  ])("words a removed %s as (%s)", (kind, noun) => {
    expect(heldCommandLine(heldRemoval(kind, "OLD")).clause).toBe(`(${noun})`);
  });
});

describe("heldCommandLine for a held variable", () => {
  it("keeps a plain variable label and masked assignment without guessing a launch effect", () => {
    const line = heldCommandLine(heldPut("variable", "LOG_LEVEL", "•••", null));

    expect(line.name).toBe("LOG_LEVEL");
    expect(line.clause).toContain("(variable)");
    expect(line.clause).toContain("LOG_LEVEL=•••");
    expect(line.clause).not.toContain("changes how programs start");
    expect(line.reach).not.toContain("starts programs with it");
  });

  it("keeps the launch description for NODE_OPTIONS", () => {
    const line = heldCommandLine(
      heldPut("env_override", "claude:NODE_OPTIONS", "--inspect", "claude"),
    );

    expect(line.name).toBe("NODE_OPTIONS");
    expect(line.clause).toBe(
      "(variable) changes how Claude Code starts: NODE_OPTIONS=--inspect",
    );
  });
});
