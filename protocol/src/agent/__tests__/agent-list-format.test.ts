import { describe, expect, it } from "vitest";
import type { AgentSummary, ListAgentsResponse } from "@traycer/protocol/host";
import { agentListUpgradeV91ToV92 } from "@traycer/protocol/host/agent/contracts";
import {
  listAgentsResponseSchema,
  listAgentsResponseSchemaV91,
} from "@traycer/protocol/host/agent/shared";
import {
  formatAgentListPage,
  formatAgentListResponse,
  formatAgentSelf,
} from "../agent-list-format";

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
    runConfig: null,
    // The `@9.1` session facet. `null` is the row's own "this host cannot
    // know", which is what a GUI chat with no PTY session always answers.
    sessionState: null,
    lastExit: null,
    // The `@9.2` archive flag. `null` is "the answering host does not report
    // it", so a row built without an opinion renders no marker and no legend
    // entry, which keeps every expectation below that predates the flag intact.
    archived: null,
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

function agentLine(output: string, linePrefix: string): string {
  return output.split("\n").find((line) => line.startsWith(linePrefix)) ?? "";
}

describe("formatAgentListResponse heading", () => {
  it("names the task the rows were read from when the listing carries it", () => {
    // Every row is a bare agent id, so a listing forwarded to another agent is
    // only actionable if the text says which task those ids belong to - and an
    // agent can now hold listings from more than one.
    const enriched = {
      ...response([agent({ id: "caller", isSelf: true })], "caller"),
      epicId: "epic-42",
    };

    expect(formatAgentListResponse(enriched).split("\n")[0]).toBe(
      "Agents in task 'epic-42' (relative to you):",
    );
  });

  it("keeps the older wording for a listing that has been through the wire schema", () => {
    // `epicId` is host-side enrichment: the response schema has no such key
    // and strips it (as it does `ownerHostConnectivity` on the rows), and the
    // CLI parses through that schema. Naming a task it cannot know would be
    // worse than not naming one. `archived` is NOT in that group any more: it
    // is a wire field since `agent.list@9.2`.
    const stripped = listAgentsResponseSchema.parse({
      ...response([agent({ id: "caller", isSelf: true })], "caller"),
      epicId: "epic-42",
    });

    expect("epicId" in stripped).toBe(false);
    expect(formatAgentListResponse(stripped).split("\n")[0]).toBe(
      "Agents in epic (relative to you):",
    );
  });
});

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

  it("keeps archive rendering end to end when parsed through the CLI's versioned response schema", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const archived = {
      ...agent({ id: "done", parentId: "caller" }),
      archived: true,
    };
    const parsed = listAgentsResponseSchema.parse(
      response([caller, archived], "caller"),
    );
    const output = formatAgentListResponse(parsed);

    // `archived` is a wire field since `agent.list@9.2`, so the schema the CLI
    // parses through keeps it and the marker and legend line both render.
    expect(parsed.agents[1].archived).toBe(true);
    expect(output).toContain("done [archived] gui/claude");
    expect(output).toContain(
      "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message",
    );
  });

  it("renders no archive marker or legend line for a listing parsed through the frozen @9.1 schema", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const archived = {
      ...agent({ id: "done", parentId: "caller" }),
      archived: true,
    };
    const parsed = listAgentsResponseSchemaV91.parse(
      response([caller, archived], "caller"),
    );
    // The `@9.1` schema has no `archived`, so zod strips it; the upgrade chain
    // is what hands the listing to the formatter, and it fills `null`.
    expect(Object.hasOwn(parsed.agents[1], "archived")).toBe(false);
    const output = formatAgentListResponse(
      agentListUpgradeV91ToV92.upgradeResponse(parsed),
    );

    expect(output).not.toContain("[archived]");
  });

  it("renders every owner-host state the host can report, and explains them", () => {
    // All three words on one listing: an agent choosing whether to address a
    // remote peer needs `connectable` and `offline` told apart, and both told
    // apart from "this row cannot say".
    const caller = agent({ id: "caller", isSelf: true });
    const rows = [
      caller,
      {
        ...agent({ id: "here", parentId: "caller" }),
        ownerHostConnectivity: "connectable",
      },
      {
        ...agent({
          id: "away",
          parentId: "caller",
          isLocal: false,
          hostId: "d2",
        }),
        ownerHostConnectivity: "offline",
      },
      {
        ...agent({
          id: "theirs",
          parentId: "caller",
          isLocal: false,
          hostId: "d3",
        }),
        ownerHostConnectivity: "unknown",
      },
    ];

    const output = formatAgentListResponse(response(rows, "caller"));

    const lineFor = (id: string): string =>
      output.split("\n").find((line) => line.includes(`${id} gui/`)) ?? "";
    expect(lineFor("here")).toContain("owner host: connectable");
    expect(lineFor("away")).toContain("owner host: offline");
    expect(lineFor("theirs")).toContain("owner host: unknown");
    // The caveat matters as much as the words: `unknown` on another user's row
    // means not observable, not down, and a reader told only "unknown" would
    // reasonably assume the latter.
    expect(output).toContain(
      "owner host: <state>: whether the machine running the agent is reachable",
    );
    expect(output).toContain(
      "a row owned by another user is always unknown, because the host directory lists only your own machines - unknown there means not observable, not down",
    );
  });

  it("says nothing about owner hosts when the listing does not carry the field", () => {
    // The versioned wire schema has no `ownerHostConnectivity`, so the CLI
    // path renders exactly what it rendered before - no row token, and no
    // legend line advertising a field this listing cannot express.
    const caller = agent({ id: "caller", isSelf: true });
    const remote = {
      ...agent({
        id: "away",
        parentId: "caller",
        isLocal: false,
        hostId: "d2",
      }),
      ownerHostConnectivity: "offline",
    };
    const parsed = listAgentsResponseSchema.parse(
      response([caller, remote], "caller"),
    );

    const output = formatAgentListResponse(parsed);

    expect(output).not.toContain("owner host:");
  });

  it("ignores an owner-host word this build does not know", () => {
    // A newer host inventing a fourth state must not put an unexplained token
    // in front of a model whose legend cannot describe it. The row degrades to
    // carrying nothing, which is what an older build always did.
    const caller = agent({ id: "caller", isSelf: true });
    const odd = {
      ...agent({
        id: "weird",
        parentId: "caller",
        isLocal: false,
        hostId: "d2",
      }),
      ownerHostConnectivity: "quarantined",
    };

    const output = formatAgentListResponse(response([caller, odd], "caller"));

    expect(output).not.toContain("quarantined");
    expect(output).not.toContain("owner host:");
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

  it("renders model/effort/fast on a GUI row after the surface/harness token", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const configured = agent({
      id: "done",
      parentId: "caller",
      runConfig: {
        model: { kind: "concrete", slug: "gpt-5.6-sol" },
        reasoningEffort: "high",
        fastMode: true,
      },
    });
    const output = formatAgentListResponse(
      response([caller, configured], "caller"),
    );

    expect(output).toContain(
      "done gui/claude model: gpt-5.6-sol effort: high fast",
    );
  });

  it("omits null effort and disabled fast tokens", () => {
    const configured = agent({
      id: "done",
      runConfig: {
        model: { kind: "concrete", slug: "gpt-5.6-sol" },
        reasoningEffort: null,
        fastMode: false,
      },
    });
    const output = formatAgentListResponse(response([configured], "done"));
    const line = agentLine(output, "done gui/claude");

    expect(line).toContain("model: gpt-5.6-sol");
    expect(line).not.toContain("effort:");
    expect(line).not.toContain("fast");
    expect(output).toContain("model: <slug>");
  });

  it("renders provider default for TUI and never renders a fast token", () => {
    const configured = agent({
      id: "term",
      surface: "tui",
      runConfig: {
        model: { kind: "provider-default" },
        reasoningEffort: null,
        fastMode: null,
      },
    });
    const output = formatAgentListResponse(response([configured], "term"));
    const line = agentLine(output, "term tui/claude");

    expect(line).toContain("model: provider default");
    expect(line).not.toContain("null");
    expect(line).not.toContain("fast");
  });

  it("default-fills runConfig to null for a v7 host row without the field", () => {
    const legacy = { ...agent({ id: "legacy", isSelf: true }) };
    delete (legacy as { runConfig?: unknown }).runConfig;
    const parsed = listAgentsResponseSchema.parse(
      response([legacy as AgentSummary], "legacy"),
    );
    const output = formatAgentListResponse(parsed);

    expect(parsed.agents[0].runConfig).toBeNull();
    expect(agentLine(output, "legacy [self] gui/claude")).not.toContain(
      "model:",
    );
    expect(output).not.toContain("model: <slug>");
  });
});

describe("session state token", () => {
  it("renders sleeping with a last-exit parenthetical, and without one when lastExit is null", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const withExit = {
      ...agent({ id: "napping", parentId: "caller" }),
      sessionState: "sleeping" as const,
      lastExit: "user-stop" as const,
    };
    const withoutExit = {
      ...agent({ id: "dozing", parentId: "caller" }),
      sessionState: "sleeping" as const,
      lastExit: null,
    };
    const output = formatAgentListResponse(
      response([caller, withExit, withoutExit], "caller"),
    );

    expect(agentLine(output, "napping gui/")).toContain(
      "session: sleeping (last exit: user-stop)",
    );
    const dozingLine = agentLine(output, "dozing gui/");
    expect(dozingLine).toContain("session: sleeping");
    expect(dozingLine).not.toContain("last exit");
  });

  it("renders stopped and running with no last-exit token, even when lastExit is set", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const stopped = {
      ...agent({ id: "done", parentId: "caller" }),
      sessionState: "stopped" as const,
      lastExit: "user-stop" as const,
    };
    const running = {
      ...agent({ id: "busy", parentId: "caller" }),
      sessionState: "running" as const,
      lastExit: "reaped" as const,
    };
    const output = formatAgentListResponse(
      response([caller, stopped, running], "caller"),
    );

    const stoppedLine = agentLine(output, "done gui/");
    expect(stoppedLine).toContain("session: stopped");
    expect(stoppedLine).not.toContain("last exit");
    const runningLine = agentLine(output, "busy gui/");
    expect(runningLine).toContain("session: running");
    expect(runningLine).not.toContain("last exit");
  });

  it("renders no session token and omits the legend entry when every row's sessionState is null", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const unknown = agent({ id: "unknowable", parentId: "caller" });
    const output = formatAgentListResponse(
      response([caller, unknown], "caller"),
    );

    expect(output).not.toContain("session:");
    expect(output).not.toContain("session: <state>");
  });

  it("degrades a state this build cannot explain to absent, token and legend alike", () => {
    // Unreachable by type today - the enum is CLOSED, and widening it is a new
    // minor - so this stands in for the two ways a value the legend cannot
    // describe still arrives: a newer host that widened the enum, and a summary
    // hand-built past the schema, which leaves the key off entirely.
    //
    // The legend half is the one that needs its own row: gating on
    // `sessionState !== null` instead of on the narrowing would print the
    // explanation for a marker that appears on no line.
    const caller = agent({ id: "caller", isSelf: true });
    const future = { ...agent({ id: "future", parentId: "caller" }) };
    (future as { sessionState: unknown }).sessionState = "hibernating";
    const absent = { ...agent({ id: "keyless", parentId: "caller" }) };
    delete (absent as { sessionState?: unknown }).sessionState;
    const output = formatAgentListResponse(
      response([caller, future, absent], "caller"),
    );

    expect(agentLine(output, "future gui/")).not.toContain("session:");
    expect(agentLine(output, "future gui/")).not.toContain("hibernating");
    expect(agentLine(output, "keyless gui/")).not.toContain("session:");
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("session: <state>");
  });

  it("explains the token and says a sleeping agent resumes and is not dead, once at least one row carries a state", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const sleeping = {
      ...agent({ id: "napping", parentId: "caller" }),
      sessionState: "sleeping" as const,
      lastExit: "reaped" as const,
    };
    const output = formatAgentListResponse(
      response([caller, sleeping], "caller"),
    );

    expect(output).toContain("session: <state>: the agent's own session");
    expect(output).toContain(
      "sleeping (no live session; it RESUMES on your next message or when the agent is opened, so a sleeping peer is still addressable and is not dead)",
    );
  });

  it("says an archived agent is still addressable rather than that a stopped agent is over", () => {
    // The clause this pins shipped as "the agent is over as a record: archived
    // or deleted", which is false about the only case a reader can actually
    // meet. `stopped` is written by the ARCHIVE mutation; the one other writer
    // is the `delete` exit arm, whose record is tombstoned out of the listing
    // before it can be enumerated. And archiving is explicitly recoverable -
    // the archive tool's own description promises that a later user or A2A
    // message unarchives the agent - so the catalog was telling a model both
    // that the peer was finished and that it could still be woken.
    //
    // LITERAL, like the `sleeping` clause above: a paraphrase is what let the
    // finality claim reach a released build CI-green, and a legend that only
    // has to contain the word "archived" would go green on the broken copy.
    const caller = agent({ id: "caller", isSelf: true });
    const stopped = {
      ...agent({ id: "done", parentId: "caller" }),
      sessionState: "stopped" as const,
      lastExit: null,
    };
    const output = formatAgentListResponse(
      response([caller, stopped], "caller"),
    );

    expect(output).toContain(
      "stopped (the agent was archived, or deleted; a stopped row you can still see is almost always the archived case, because a deleted record drops out of the listing. An ARCHIVED agent is not over - it stays addressable, and your next message unarchives and wakes it; a deleted one is gone)",
    );
    expect(output).not.toContain("the agent is over as a record");
  });

  it("says running means a live process, not a mid-turn agent", () => {
    // `active` is the executing-right-now field and this formatter never
    // renders it, so `running` is the listing's ONLY liveness word - and the
    // natural reading of it for an agent is "mid-turn", which it does not mean.
    // An agent idle at a prompt for an hour reads `running`.
    const caller = agent({ id: "caller", isSelf: true });
    const running = {
      ...agent({ id: "busy", parentId: "caller" }),
      sessionState: "running" as const,
      lastExit: null,
    };
    const output = formatAgentListResponse(
      response([caller, running], "caller"),
    );

    expect(output).toContain(
      "running (a live session exists on that host - the agent's process is up; it does NOT say the agent is mid-turn)",
    );
  });

  it("keeps the two sentences that stop a caller misreading an absent state or branching on lastExit", () => {
    // Neither of these was pinned, and both are the load-bearing half of their
    // sentence. Without the first, a row this host cannot observe reads as a
    // dead one - the exact collapse the facet exists to prevent, one arm over.
    // Without the second, a caller branches on `lastExit` to decide whether a
    // peer is revivable, which re-introduces the confusion one level down.
    const caller = agent({ id: "caller", isSelf: true });
    const sleeping = {
      ...agent({ id: "napping", parentId: "caller" }),
      sessionState: "sleeping" as const,
      lastExit: "reaped" as const,
    };
    const output = formatAgentListResponse(
      response([caller, sleeping], "caller"),
    );

    expect(output).toContain(
      "A row with no session token is one this host cannot observe (another machine's agent, a GUI chat, or a record older than the field), which is not the same as stopped",
    );
    expect(output).toContain(
      "is display detail only: all four resume identically",
    );
  });
});

describe("activity token", () => {
  it("renders working or idle on a local row from `active`", () => {
    const output = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true }),
          agent({ id: "busy", active: true }),
          agent({ id: "quiet", active: false }),
        ],
        "caller",
      ),
    );

    expect(agentLine(output, "busy ")).toContain("activity: working");
    expect(agentLine(output, "quiet ")).toContain("activity: idle");
  });

  it("renders no token on a non-local row, whatever `active` says", () => {
    const output = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true }),
          agent({ id: "remote", isLocal: false, active: true }),
        ],
        "caller",
      ),
    );

    expect(agentLine(output, "remote ")).not.toContain("activity:");
  });

  it("explains the token only when a row renders it, and pins the load-bearing phrases", () => {
    const withToken = formatAgentListResponse(
      response(
        [agent({ id: "caller", isSelf: true }), agent({ id: "peer" })],
        "caller",
      ),
    );
    expect(withToken).toContain("activity: <state>:");
    expect(withToken).toContain(
      "a working row may already have ended its turn",
    );
    expect(withToken).toContain("reads idle even while it is still working");
    expect(withToken).toContain("Your own row carries none");
    expect(withToken).toContain("it has NOT necessarily replied to you");
    expect(withToken).toContain("that is not the same as idle");

    const allRemote = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true, isLocal: false }),
          agent({ id: "remote", isLocal: false, active: true }),
        ],
        "caller",
      ),
    );
    expect(allRemote).not.toContain("activity:");

    expect(formatAgentListResponse(response([], "caller"))).not.toContain(
      "activity:",
    );
  });

  it("renders no token on the caller's own row, and no legend line when it is the only local row", () => {
    const output = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true, active: true }),
          agent({ id: "remote", isLocal: false }),
        ],
        "caller",
      ),
    );

    expect(agentLine(output, "caller ")).not.toContain("activity:");
    expect(output).not.toContain("activity: <state>:");
  });

  it("places the token after the location and before the session token", () => {
    const output = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true }),
          agent({
            id: "full",
            active: true,
            folderPaths: ["/repo/wt"],
            isWorktree: true,
            sessionState: "running",
          }),
        ],
        "caller",
      ),
    );
    const line = agentLine(output, "full ");

    expect(line.indexOf("worktree:")).toBeGreaterThan(-1);
    expect(line.indexOf("activity: working")).toBeGreaterThan(
      line.indexOf("worktree:"),
    );
    expect(line.indexOf("session: running")).toBeGreaterThan(
      line.indexOf("activity: working"),
    );
  });

  it("leaves the token and its legend line off a compact listing", () => {
    const output = formatAgentListPage(
      response(
        [
          agent({ id: "caller", isSelf: true }),
          agent({ id: "busy", active: true }),
        ],
        "caller",
      ),
      { detail: "compact", page: null },
    );

    expect(agentLine(output, "busy ")).toBe("busy gui/claude R/S");
    expect(output).not.toContain("activity:");
  });

  it("explains the token only on a page that prints one", () => {
    // Two rows: the caller, then a local peer. The first page of one row
    // prints only the caller, which carries no token.
    const listing = response(
      [
        agent({ id: "caller", isSelf: true }),
        agent({ id: "busy", active: true }),
      ],
      "caller",
    );

    const first = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 0, limit: 1 },
    });
    expect(first).not.toContain("activity:");

    const second = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 1, limit: 1 },
    });
    expect(agentLine(second, "busy ")).toContain("activity: working");
    expect(second).toContain("activity: <state>:");
  });

  it("does not explain the token for a local row no section prints", () => {
    // `a` and `b` are each other's parent, so no root reaches them and the
    // listing prints neither.
    const output = formatAgentListResponse(
      response(
        [
          agent({ id: "caller", isSelf: true }),
          agent({ id: "a", parentId: "b", active: true }),
          agent({ id: "b", parentId: "a" }),
        ],
        "caller",
      ),
    );

    expect(output).not.toContain("activity:");
  });

  it("carries the activity legend line when sending is unavailable", () => {
    const output = formatAgentListResponse({
      ...response(
        [agent({ id: "caller", isSelf: true }), agent({ id: "peer" })],
        "caller",
      ),
      caller: { agentId: "caller", canSendMessages: false },
    });

    expect(output).toContain("Sending is unavailable in this session");
    expect(output).toContain("activity: <state>:");
    expect(output).toContain("that is not the same as idle");
  });
});

const ARCHIVED_LEGEND =
  "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message";
const SHRINK = "archived='exclude' / detail='compact' to shrink the listing.";

/** The agent ids a rendered listing prints, in order, whatever the tree connector. */
function renderedIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const stripped = line.replace(/^(?:\s{3}|│ {2}|├─ |└─ )*/, "");
    const match =
      /^(\S+) (?:\[self\] )?(?:\[archived\] )?(?:"[^"]*" )?gui\//.exec(
        stripped,
      );
    if (match !== null) ids.push(match[1]);
  }
  return ids;
}

function lastLine(output: string): string {
  const lines = output.split("\n");
  return lines[lines.length - 1];
}

function withOwnerHost(row: AgentSummary, word: string): AgentSummary {
  const enriched = { ...row, ownerHostConnectivity: word };
  return enriched;
}

/** A caller `me` plus four top-level agents: five rows, one section each. */
function flatListing(over: (index: number) => Partial<AgentSummary>) {
  const ids = ["me", "a", "b", "c", "d"];
  return response(
    ids.map((id, index) => agent({ id, isSelf: id === "me", ...over(index) })),
    "me",
  );
}

/** Thirteen agents across You / Parent chain / Siblings / Children / Other, with nesting. */
function wideListing(): ListAgentsResponse {
  return response(
    [
      agent({ id: "gp" }),
      agent({ id: "par", parentId: "gp" }),
      agent({ id: "me", parentId: "par", isSelf: true }),
      agent({ id: "sib1", parentId: "par" }),
      agent({ id: "sib1c", parentId: "sib1" }),
      agent({ id: "sib2", parentId: "par" }),
      agent({ id: "c1", parentId: "me" }),
      agent({ id: "c1a", parentId: "c1" }),
      agent({ id: "c1a1", parentId: "c1a" }),
      agent({ id: "c2", parentId: "me" }),
      agent({ id: "o1" }),
      agent({ id: "o2" }),
      agent({ id: "o2a", parentId: "o2" }),
    ],
    "me",
  );
}

describe("formatAgentListPage", () => {
  it("renders a compact row as id, title, surface/harness and capability only", () => {
    const caller = agent({ id: "caller", isSelf: true });
    const kid = withOwnerHost(
      agent({
        id: "kid",
        parentId: "caller",
        title: "Fix login",
        folderPaths: ["/repo"],
        sessionState: "sleeping",
        lastExit: "reaped",
        archived: false,
        runConfig: {
          model: { kind: "concrete", slug: "gpt-5.6-sol" },
          reasoningEffort: "high",
          fastMode: true,
        },
      }),
      "connectable",
    );
    const listing = response([caller, kid], "caller");

    const compact = formatAgentListPage(listing, {
      detail: "compact",
      page: null,
    });

    expect(agentLine(compact, "kid ")).toBe('kid "Fix login" gui/claude R/S');
    for (const token of [
      "dir:",
      "worktree:",
      "model:",
      "effort:",
      "session:",
      "owner host:",
    ]) {
      expect(compact).not.toContain(token);
    }
    // The same fixture at full detail does carry them, so the absence above is
    // the detail switch and not an empty fixture.
    const full = formatAgentListPage(listing, { detail: "full", page: null });
    for (const token of ["dir:", "model:", "session:", "owner host:"]) {
      expect(full).toContain(token);
    }
  });

  it("keeps the [self] and [archived] markers, the capability token and the core legend in compact", () => {
    const caller = agent({ id: "caller", isSelf: true, archived: false });
    const done = agent({ id: "done", parentId: "caller", archived: true });
    const listing = response([caller, done], "caller");

    const compact = formatAgentListPage(listing, {
      detail: "compact",
      page: null,
    });

    expect(agentLine(compact, "caller")).toBe("caller [self] gui/claude");
    expect(agentLine(compact, "done")).toBe("done [archived] gui/claude R/S");
    for (const entry of [
      "[self]: this agent",
      '"<title>": the agent',
      "\nR: the agent has a readable transcript",
      "\nS: the agent can be sent messages to",
      "\nR/S: the agent has a readable transcript and can be sent messages to",
      "\n-: no available action",
      ARCHIVED_LEGEND,
    ]) {
      expect(compact).toContain(entry);
    }

    const noSend = formatAgentListPage(
      {
        ...listing,
        caller: { agentId: "caller", canSendMessages: false },
      },
      { detail: "compact", page: null },
    );
    expect(lastLine(noSend)).toBe("Sending is unavailable in this session");
    expect(noSend).toContain("\n-: the agent has no readable transcript");
  });

  it("prints no [archived] marker or legend line when every row's archived is null", () => {
    const listing = flatListing(() => ({ archived: null }));

    for (const detail of ["full", "compact"] as const) {
      const output = formatAgentListPage(listing, { detail, page: null });
      expect(output).not.toContain("[archived]");
    }
  });

  it("prints the legend line but no marker when every row is archived: false", () => {
    const listing = flatListing(() => ({ archived: false }));

    for (const detail of ["full", "compact"] as const) {
      const output = formatAgentListPage(listing, { detail, page: null });
      expect(output).not.toContain(" [archived] ");
      expect(output).toContain(ARCHIVED_LEGEND);
    }
  });

  it("gates the legend on the rows of the page, not of the listing", () => {
    // Rows by index: me(0) a(1) | b(2) c(3) | d(4). Only `c`, on page 2, reports
    // archive status, carries a runConfig and a session token.
    const listing = flatListing((index) =>
      index === 3
        ? {
            archived: false,
            sessionState: "running",
            runConfig: {
              model: { kind: "concrete", slug: "gpt-5.6-sol" },
              reasoningEffort: null,
              fastMode: null,
            },
          }
        : {},
    );

    const first = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 0, limit: 2 },
    });
    const second = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 2, limit: 2 },
    });

    expect(first).not.toContain("[archived]:");
    expect(first).not.toContain("model: <slug>");
    expect(first).not.toContain("session: <state>");
    expect(second).toContain(ARCHIVED_LEGEND);
    expect(second).toContain("model: <slug>");
    expect(second).toContain("session: <state>");
  });

  it("prints no footer without a page, or when the page holds every row", () => {
    const listing = flatListing(() => ({}));
    const unpaged = formatAgentListPage(listing, {
      detail: "full",
      page: null,
    });
    expect(unpaged).not.toContain("Showing");

    for (const limit of [5, 6, 100]) {
      const output = formatAgentListPage(listing, {
        detail: "full",
        page: { offset: 0, limit },
      });
      expect(output).not.toContain("Showing");
      expect(output).toBe(unpaged);
    }
  });

  it("closes a cut page with a footer naming the next offset and the shrink arguments", () => {
    const output = formatAgentListPage(
      flatListing(() => ({})),
      { detail: "full", page: { offset: 0, limit: 2 } },
    );

    expect(lastLine(output)).toBe(
      `Showing 1-2 of 5 agents; pass offset=2 for the next page, or ${SHRINK}`,
    );
    expect(renderedIds(output)).toEqual(["me", "a"]);
  });

  it("offers no next offset on the last page", () => {
    const listing = flatListing(() => ({}));

    const last = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 4, limit: 2 },
    });
    expect(lastLine(last)).toBe(`Showing 5-5 of 5 agents; pass ${SHRINK}`);
    expect(renderedIds(last)).toEqual(["d"]);

    // A page that ends exactly at the total is the last page too.
    const exact = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 3, limit: 2 },
    });
    expect(lastLine(exact)).toBe(`Showing 4-5 of 5 agents; pass ${SHRINK}`);
  });

  it("says the offset is past the end, with no rows and no footer, at the total and beyond", () => {
    const listing = flatListing(() => ({}));

    for (const offset of [5, 9]) {
      const output = formatAgentListPage(listing, {
        detail: "full",
        page: { offset, limit: 2 },
      });
      expect(output.split("\n")[1]).toBe(
        "No agents on this page: the offset is past the end of the listing, which has 5 agents. Pass offset=0 for the first page.",
      );
      expect(renderedIds(output)).toEqual([]);
      expect(output).not.toContain("Showing");
    }
  });

  it("prints a caller's child on page 2 under Children, and a grandchild keeps its connector", () => {
    // Rows: me(0) | Children: c1(1) g1(2) g2(3) c2(4).
    const listing = response(
      [
        agent({ id: "me", isSelf: true }),
        agent({ id: "c1", parentId: "me" }),
        agent({ id: "g1", parentId: "c1" }),
        agent({ id: "g2", parentId: "c1" }),
        agent({ id: "c2", parentId: "me" }),
      ],
      "me",
    );

    const output = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 3, limit: 2 },
    });
    const lines = output.split("\n");

    expect(lines).toContain("Children (agents you spawned):");
    expect(lines.some((line) => line.startsWith("└─ g2 gui/"))).toBe(true);
    expect(lines.some((line) => line.startsWith("c2 gui/"))).toBe(true);
    expect(renderedIds(output)).toEqual(["g2", "c2"]);
  });

  it("prints no heading for a section with no row on the page", () => {
    const output = formatAgentListPage(
      flatListing(() => ({})),
      { detail: "full", page: { offset: 1, limit: 2 } },
    );

    expect(output).not.toContain("You:");
    expect(output).toContain("Other agents (user-triggered):");
    expect(renderedIds(output)).toEqual(["a", "b"]);
  });

  it("covers every agent exactly once, in the unpaged order, at every page size", () => {
    const listing = wideListing();
    const expected = renderedIds(formatAgentListResponse(listing));
    expect(expected).toHaveLength(13);

    for (const limit of [1, 2, 3, 4, 11, 50]) {
      const collected: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 20; guard += 1) {
        const output = formatAgentListPage(listing, {
          detail: "full",
          page: { offset, limit },
        });
        collected.push(...renderedIds(output));
        if (!lastLine(output).includes("pass offset=")) break;
        offset += limit;
      }
      expect(collected, `limit ${limit}`).toEqual(expected);
    }
  });

  it("counts agent rows only against the limit, across sections", () => {
    // Rows: me(0) par(1) sib(2) c1(3) o1(4); offset 1 limit 3 spans three sections.
    const listing = response(
      [
        agent({ id: "par" }),
        agent({ id: "me", parentId: "par", isSelf: true }),
        agent({ id: "sib", parentId: "par" }),
        agent({ id: "c1", parentId: "me" }),
        agent({ id: "o1" }),
      ],
      "me",
    );

    const output = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 1, limit: 3 },
    });

    expect(renderedIds(output)).toEqual(["par", "sib", "c1"]);
    expect(output).toContain("Parent:");
    expect(output).toContain("Siblings:");
    expect(output).toContain("Children (agents you spawned):");
  });

  it("is byte-identical to the one-argument form when nothing is cut", () => {
    const caller = agent({
      id: "caller",
      isSelf: true,
      title: "Lead",
      archived: false,
      folderPaths: ["/repo"],
    });
    const rich = response(
      [
        caller,
        withOwnerHost(
          agent({
            id: "kid",
            parentId: "caller",
            title: "Child",
            archived: true,
            sessionState: "sleeping",
            lastExit: "reaped",
            runConfig: {
              model: { kind: "concrete", slug: "gpt-5.6-sol" },
              reasoningEffort: "high",
              fastMode: true,
            },
          }),
          "offline",
        ),
        agent({ id: "grandkid", parentId: "kid" }),
        agent({ id: "other" }),
      ],
      "caller",
    );
    const empty = response([], "caller");

    for (const listing of [rich, empty]) {
      const whole = formatAgentListResponse(listing);
      expect(whole).toBe(
        formatAgentListPage(listing, { detail: "full", page: null }),
      );
      expect(whole).toBe(
        formatAgentListPage(listing, {
          detail: "full",
          page: { offset: 0, limit: 1000 },
        }),
      );
    }
  });

  it("renders an empty listing the same at any offset, with no footer", () => {
    for (const offset of [0, 5]) {
      const output = formatAgentListPage(response([], "me"), {
        detail: "full",
        page: { offset, limit: 2 },
      });
      expect(output.split("\n")[1]).toBe("No agents found for scope 'user'.");
      expect(output).not.toContain("Showing");
    }
  });

  it("pages the fallback forest, which has no headings, covering every id once", () => {
    const listing = response(
      [
        agent({ id: "a" }),
        agent({ id: "b", parentId: "a" }),
        agent({ id: "c" }),
        agent({ id: "d", parentId: "c" }),
        agent({ id: "e" }),
      ],
      "missing",
    );
    const expected = renderedIds(formatAgentListResponse(listing));
    expect(expected).toEqual(["a", "b", "c", "d", "e"]);

    const collected: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const output = formatAgentListPage(listing, {
        detail: "full",
        page: { offset, limit: 2 },
      });
      expect(output).not.toContain("You:");
      expect(output).not.toContain("Other agents");
      collected.push(...renderedIds(output));
      if (!lastLine(output).includes("pass offset=")) break;
      offset += 2;
    }
    expect(collected).toEqual(expected);
  });
  it("keeps the bytes a listing with unreachable rows has always had when nothing is cut", () => {
    // `a` and `b` name each other as parent, so no root reaches either and
    // neither is printed. Before pages existed the formatter still printed
    // their section heading and lit the legend from every agent in the
    // response; the expected text below is that output, byte for byte. A
    // page that holds every printable row must print the same thing, because
    // the host tool always passes one.
    const listing = response(
      [
        agent({ id: "me", isSelf: true }),
        agent({
          id: "a",
          parentId: "b",
          archived: true,
          sessionState: "sleeping",
        }),
        agent({ id: "b", parentId: "a" }),
      ],
      "me",
    );
    const expected = [
      "Agents in epic (relative to you):",
      "You:",
      "me [self] gui/claude",
      "",
      "Other agents (user-triggered):",
      "",
      "",
      "Legend:",
      "[self]: this agent, i.e. the caller of agent.list",
      "[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message",
      '"<title>": the agent\'s chat/session title (omitted when untitled)',
      "R: the agent has a readable transcript",
      "S: the agent can be sent messages to",
      "R/S: the agent has a readable transcript and can be sent messages to",
      "-: no available action",
      "dir: <path>: the working directory the agent runs in",
      "worktree: <path>: the agent runs in a dedicated git worktree",
    ].join("\n");

    const unpaged = formatAgentListResponse(listing);
    const sessionLegendStart = unpaged.indexOf("\nsession: <state>:");

    expect(sessionLegendStart).toBeGreaterThan(0);
    expect(unpaged.slice(0, sessionLegendStart)).toBe(expected);
    expect(
      formatAgentListPage(listing, {
        detail: "full",
        page: { offset: 0, limit: 200 },
      }),
    ).toBe(unpaged);
  });

  it("drops a rowless section and its legend entries once the page cuts the listing", () => {
    // The same unreachable pair, but now the page leaves a row out, so the
    // text is a page: no heading without a row under it, and no legend entry
    // for a marker no printed row carries.
    const listing = response(
      [
        agent({ id: "me", isSelf: true }),
        agent({ id: "kid", parentId: "me" }),
        agent({
          id: "a",
          parentId: "b",
          archived: true,
          sessionState: "sleeping",
        }),
        agent({ id: "b", parentId: "a" }),
      ],
      "me",
    );

    const page = formatAgentListPage(listing, {
      detail: "full",
      page: { offset: 0, limit: 1 },
    });

    expect(page).not.toContain("Other agents (user-triggered):");
    expect(page).not.toContain("[archived]:");
    expect(page).not.toContain("session: <state>:");
    expect(page.split("\n").at(-1)).toBe(
      "Showing 1-1 of 2 agents; pass offset=1 for the next page, or archived='exclude' / detail='compact' to shrink the listing.",
    );
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

  it("reports GUI model/effort/fast as separate lines", () => {
    const output = formatAgentSelf(
      agent({
        id: "self",
        isSelf: true,
        runConfig: {
          model: { kind: "concrete", slug: "gpt-5.6-sol" },
          reasoningEffort: "high",
          fastMode: true,
        },
      }),
    );
    expect(output).toContain("model: gpt-5.6-sol");
    expect(output).toContain("effort: high");
    expect(output).toContain("fast: yes");
  });

  it("omits null effort and reports disabled GUI fast mode as no", () => {
    const output = formatAgentSelf(
      agent({
        id: "self",
        runConfig: {
          model: { kind: "concrete", slug: "gpt-5.6-sol" },
          reasoningEffort: null,
          fastMode: false,
        },
      }),
    );
    expect(output).toContain("model: gpt-5.6-sol");
    expect(output).not.toContain("effort:");
    expect(output).toContain("fast: no");
  });

  it("reports TUI provider default and omits the fast line", () => {
    const output = formatAgentSelf(
      agent({
        id: "self",
        surface: "tui",
        runConfig: {
          model: { kind: "provider-default" },
          reasoningEffort: null,
          fastMode: null,
        },
      }),
    );
    expect(output).toContain("model: provider default");
    expect(output).not.toContain("null");
    expect(output).not.toContain("fast:");
  });

  it("renders no run-config lines when runConfig is null", () => {
    const output = formatAgentSelf(agent({ id: "self", runConfig: null }));
    expect(output).not.toContain("model:");
    expect(output).not.toContain("effort:");
    expect(output).not.toContain("fast:");
  });
});
