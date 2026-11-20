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
