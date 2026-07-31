import { describe, expect, it } from "vitest";
import type { AgentSummary, ListAgentsResponse } from "@traycer/protocol/host";
import { listAgentsResponseSchema } from "@traycer/protocol/host/agent/shared";
import { formatAgentListResponse, formatAgentSelf } from "../agent-list-format";

function agent(
  over: Partial<AgentSummary> & Pick<AgentSummary, "id">,
): AgentSummary {
  return {
    parentId: null,
    hostId: "d1",
    isLocal: true,
    surface: "gui",
    harnessId: "claude",
    title: null,
    isSelf: false,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: [],
    isWorktree: false,
    ...over,
  };
}

function response(
  agents: readonly AgentSummary[],
  callerAgentId: string,
): ListAgentsResponse {
  return {
    caller: { agentId: callerAgentId, canSendMessages: true },
    scope: "user",
    agents: [...agents],
  };
}

/** Returns the lines belonging to the labelled section, until the next blank line. */
function section(output: string, label: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line === label);
  if (start === -1) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].length === 0) break;
    body.push(lines[i]);
  }
  return body;
}

describe("formatAgentListResponse categorization", () => {
  it("groups agents by relationship to the caller", () => {
    const agents = [
      agent({ id: "gp", parentId: null }),
      agent({ id: "parent", parentId: "gp" }),
      agent({ id: "caller", parentId: "parent", isSelf: true }),
      agent({ id: "sibling", parentId: "parent" }),
      agent({ id: "sibchild", parentId: "sibling" }),
      agent({ id: "child", parentId: "caller" }),
      agent({ id: "grandchild", parentId: "child" }),
      agent({ id: "other", parentId: null }),
    ];
    const output = formatAgentListResponse(response(agents, "caller"));

    expect(section(output, "You:").join("\n")).toContain("caller [self]");

    // The full upward lineage (parent + grandparent) renders as a chain, not
    // just the immediate parent.
    const lineage = section(output, "Parent chain (nearest first):").join("\n");
    expect(lineage).toContain("parent");
    expect(lineage).toContain("gp");

    const siblings = section(output, "Siblings:").join("\n");
    expect(siblings).toContain("sibling");
    expect(siblings).toContain("sibchild");
    expect(siblings).not.toContain("caller");

    const children = section(output, "Children (agents you spawned):").join(
      "\n",
    );
    expect(children).toContain("child");
    expect(children).toContain("grandchild");

    const others = section(output, "Other agents (user-triggered):").join("\n");
    expect(others).toContain("other");
    // The caller's full lineage must not leak into the user-triggered bucket -
    // the grandparent belongs to the lineage, not "Other".
    expect(others).not.toContain("gp");
    expect(others).not.toContain("parent ");
    expect(others).not.toContain("sibling ");
  });

  it("shows a single immediate parent under 'Parent:'", () => {
    const agents = [
      agent({ id: "parent", parentId: null }),
      agent({ id: "caller", parentId: "parent", isSelf: true }),
      agent({ id: "other", parentId: null }),
    ];
    const output = formatAgentListResponse(response(agents, "caller"));

    expect(section(output, "Parent:").join("\n")).toContain("parent");
    expect(output).not.toContain("Parent chain");
    expect(
      section(output, "Other agents (user-triggered):").join("\n"),
    ).toContain("other");
  });

  it("omits parent/siblings for a top-level caller", () => {
    const agents = [
      agent({ id: "caller", parentId: null, isSelf: true }),
      agent({ id: "child", parentId: "caller" }),
      agent({ id: "other", parentId: null }),
    ];
    const output = formatAgentListResponse(response(agents, "caller"));

    expect(output).not.toContain("Parent:");
    expect(output).not.toContain("Siblings:");
    expect(
      section(output, "Children (agents you spawned):").join("\n"),
    ).toContain("child");
    expect(
      section(output, "Other agents (user-triggered):").join("\n"),
    ).toContain("other");
  });

  it("renders folder paths and a worktree marker per agent", () => {
    const agents = [
      agent({
        id: "caller",
        parentId: null,
        isSelf: true,
        folderPaths: ["/repo"],
      }),
      agent({
        id: "child",
        parentId: "caller",
        folderPaths: ["/repo/.worktrees/child"],
        isWorktree: true,
      }),
    ];
    const output = formatAgentListResponse(response(agents, "caller"));
    expect(output).toContain("dir: /repo");
    expect(output).toContain("worktree: /repo/.worktrees/child");
    // The location is appended with no em-dash separator (it read as the "-"
    // no-action capability token).
    expect(output).not.toContain("—");
  });

  it("omits the capability token on the caller's own [self] row", () => {
    const agents = [
      agent({ id: "caller", parentId: null, isSelf: true }),
      agent({ id: "child", parentId: "caller" }),
    ];
    const you = section(
      formatAgentListResponse(response(agents, "caller")),
      "You:",
    ).join("\n");
    // [self] identifies the row; R/S (what the caller could do to it) is
    // meaningless against itself, so it is not rendered.
    expect(you).toContain("caller [self] gui/claude");
    expect(you).not.toContain("R/S");
  });

  it("renders a quoted title after the id and omits it when untitled", () => {
    const agents = [
      agent({ id: "caller", parentId: null, isSelf: true, title: "Fix login" }),
      agent({ id: "child", parentId: "caller", title: null }),
    ];
    const output = formatAgentListResponse(response(agents, "caller"));
    // Titled row: quoted title sits between the [self] marker and surface.
    expect(output).toContain('caller [self] "Fix login" gui/claude');
    // Untitled row: no quotes, no stray title token.
    expect(output).toContain("child gui/claude");
    expect(output).not.toContain('child "');
    // Legend documents the quoted-title token.
    expect(output).toContain('"<title>": the agent\'s chat/session title');
  });

  it("marks host-enriched archived rows and explains reactivation", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const archived = {
      ...agent({ id: "done", parentId: "caller" }),
      archived: true,
    };
    const output = formatAgentListResponse(
      response([caller, archived], "caller"),
    );

    expect(output).toContain("done [archived] gui/claude");
    expect(output).toContain(
      "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message",
    );
  });

  it("strips archive rendering end to end when parsed through the CLI's versioned response schema", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const archived = {
      ...agent({ id: "done", parentId: "caller" }),
      archived: true,
    };
    const parsed = listAgentsResponseSchema.parse(
      response([caller, archived], "caller"),
    );
    const output = formatAgentListResponse(parsed);

    // The versioned wire schema has no `archived` field, so zod strips it -
    // no row marker, and the legend line explaining it must not appear either.
    expect(output).not.toContain("[archived]");
    expect(output).not.toContain(
      "[archived]: the agent/chat is archived and treated as inactive",
    );
  });

  it("still explains [archived] when every enriched row is unarchived (presence, not truthiness)", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const notArchived = {
      ...agent({ id: "active", parentId: "caller" }),
      archived: false,
    };
    const output = formatAgentListResponse(
      response([caller, notArchived], "caller"),
    );

    // No row is archived, so no row carries the `[archived]` marker...
    expect(output).not.toContain("active [archived]");
    // ...but every row carries the enrichment key, so the legend must still
    // explain what the marker would mean.
    expect(output).toContain(
      "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message",
    );
  });

  it("still explains [archived] for an all-unarchived enriched listing when sending is unavailable", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const notArchived = {
      ...agent({ id: "active", parentId: "caller" }),
      archived: false,
    };
    const output = formatAgentListResponse({
      ...response([caller, notArchived], "caller"),
      caller: { agentId: "caller", canSendMessages: false },
    });

    expect(output).toContain("Sending is unavailable in this session");
    expect(output).toContain(
      "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message",
    );
  });

  it("leaves the rest of the legend and row formatting untouched for a non-enriched (stripped) response", () => {
    const agents = [
      agent({
        id: "caller",
        isSelf: true,
        title: "Fix login",
        folderPaths: ["/repo"],
      }),
      agent({
        id: "child",
        parentId: "caller",
        folderPaths: ["/repo/.worktrees/child"],
        isWorktree: true,
      }),
    ];
    const parsed = listAgentsResponseSchema.parse(response(agents, "caller"));
    const output = formatAgentListResponse(parsed);

    expect(output).not.toContain("[archived]");
    expect(output).toContain('caller [self] "Fix login" gui/claude');
    expect(output).toContain("R/S");
    expect(output).toContain("dir: /repo");
    expect(output).toContain("worktree: /repo/.worktrees/child");
    expect(output).toContain(
      '[self]: this agent, i.e. the caller of agent.list\n"<title>"',
    );
    expect(output).toContain("dir: <path>: the working directory");
    expect(output).toContain("worktree: <path>: the agent runs in a dedicated");
  });

  it("falls back to a single forest when the caller is absent", () => {
    const agents = [
      agent({ id: "a", parentId: null }),
      agent({ id: "b", parentId: "a" }),
    ];
    const output = formatAgentListResponse(response(agents, "missing"));
    expect(output).toContain("a");
    expect(output).toContain("b");
    expect(output).not.toContain("You:");
  });
});

describe("formatAgentSelf", () => {
  it("reports the agent's own working directory", () => {
    const output = formatAgentSelf(
      agent({ id: "self", isSelf: true, folderPaths: ["/repo"] }),
    );
    expect(output).toContain("self");
    expect(output).toContain("dir: /repo");
  });

  it("reports a dedicated worktree with its path(s)", () => {
    const output = formatAgentSelf(
      agent({
        id: "self",
        isSelf: true,
        folderPaths: ["/repo/.worktrees/self", "/repo/packages/app"],
        isWorktree: true,
      }),
    );
    expect(output).toContain(
      "worktree: /repo/.worktrees/self, /repo/packages/app",
    );
    expect(output).not.toContain("dir:");
  });

  it("falls back to '-' when no folder paths are known", () => {
    const output = formatAgentSelf(agent({ id: "self", isSelf: true }));
    expect(output).toContain("dir: -");
  });

  it("reports its own title, falling back to '-' when untitled", () => {
    expect(
      formatAgentSelf(agent({ id: "self", title: "Fix login" })),
    ).toContain("title: Fix login");
    expect(formatAgentSelf(agent({ id: "self", title: null }))).toContain(
      "title: -",
    );
  });

  it("reports the host-enriched archive state", () => {
    const archived = { ...agent({ id: "self", isSelf: true }), archived: true };
    expect(formatAgentSelf(archived)).toContain("archived: yes");
    expect(formatAgentSelf(agent({ id: "self", isSelf: true }))).toContain(
      "archived: no",
    );
  });

  it("returns a not-found message for a null self", () => {
    expect(formatAgentSelf(null)).toBe("Current agent not found.");
  });
});
