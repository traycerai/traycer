import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentListCommand } from "../agent-list";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return { ...actual, callHostRpc: vi.fn() };
});

const rpcMock = vi.mocked(callHostRpc);

/**
 * The row WITHOUT `agent.list@9.1`'s session facet, split out so the expected
 * JSON below can be assembled in the order zod EMITS rather than the order a
 * fixture happens to be written in - see `EXPECTED_DEFAULT_FILLED_DATA`.
 */
const LEGACY_ROW_BEFORE_SESSION_FACET = {
  id: "agent-parent",
  parentId: null,
  hostId: "host-1",
  isLocal: true,
  surface: "gui" as const,
  harnessId: "codex" as const,
  isSelf: true,
  title: "Parent",
  capabilities: { readTranscript: true, sendMessage: true },
  active: false,
  folderPaths: ["/repo"],
  isWorktree: false,
};

const LEGACY_LIST_RESPONSE = {
  caller: { agentId: "agent-parent", canSendMessages: true },
  scope: "user" as const,
  agents: [
    {
      ...LEGACY_ROW_BEFORE_SESSION_FACET,
      // `agent.list@9.1`'s session facet. Required on the canonical row and
      // supplied by the upgrade path for an older host, so a mock that stands
      // in for the TRANSPORT - which is what `callHostRpc` is here - has to
      // carry it. A GUI chat has no PTY session, so `null` is its answer.
      sessionState: null,
      lastExit: null,
      // `agent.list@9.2`'s archive flag. The `@9.1 -> @9.2` upgrade fills
      // `null` for an older host ("never asked"), and this mock stands in for
      // the transport that has already run that chain.
      archived: null,
    },
  ],
};

const LEGACY_HUMAN_OUTPUT = `Agents in epic (relative to you):
You:
agent-parent [self] "Parent" gui/codex dir: /repo

Legend:
[self]: this agent, i.e. the caller of agent.list
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
S: the agent can be sent messages to
R/S: the agent has a readable transcript and can be sent messages to
-: no available action
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree`;

// Key ORDER is load-bearing: the assertions below compare `JSON.stringify`
// bytes, and zod emits in schema-declaration order - `runConfig` comes from
// the `@9.0` row, the session facet extends it at `@9.1` and `archived` at
// `@9.2`, so they trail `runConfig` in that order however the fixture above
// happens to be written.
const EXPECTED_DEFAULT_FILLED_DATA = {
  ...LEGACY_LIST_RESPONSE,
  agents: [
    {
      ...LEGACY_ROW_BEFORE_SESSION_FACET,
      runConfig: null,
      sessionState: null,
      lastExit: null,
      archived: null,
    },
  ],
};

function makeCtx(json: boolean): CommandContext {
  return {
    runtime: {
      json,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function buildCommand() {
  return buildAgentListCommand({
    epicId: "epic-1",
    senderAgentId: "agent-parent",
    all: false,
    live: false,
    compact: false,
  });
}

function buildCommandWith(flags: { live: boolean; compact: boolean }) {
  return buildAgentListCommand({
    epicId: "epic-1",
    senderAgentId: "agent-parent",
    all: false,
    live: flags.live,
    compact: flags.compact,
  });
}

/** The legacy listing with the caller row plus one extra row per entry. */
function listingWith(
  callerArchived: boolean | null,
  extra: ReadonlyArray<{
    id: string;
    archived: boolean | null;
  }>,
) {
  return {
    ...LEGACY_LIST_RESPONSE,
    agents: [
      { ...LEGACY_LIST_RESPONSE.agents[0], archived: callerArchived },
      ...extra.map((row) => ({
        ...LEGACY_LIST_RESPONSE.agents[0],
        id: row.id,
        isSelf: false,
        parentId: "agent-parent",
        title: row.id,
        archived: row.archived,
      })),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent list run config", () => {
  it("returns structured runConfig and renders its tokens from the single agent.list call", async () => {
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      ],
    });

    const result = await buildCommand()(makeCtx(false));

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.list", {
      epicId: "epic-1",
      senderAgentId: "agent-parent",
      scope: "user",
    });
    expect(result.data).toMatchObject({
      agents: [
        {
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      ],
    });
    expect(result.human).toContain(
      "gui/codex model: gpt-5.6-codex effort: high fast",
    );
  });

  it("keeps human output byte-identical for a v7 host row without runConfig", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const result = await buildCommand()(makeCtx(false));

    expect(result.human).toBe(LEGACY_HUMAN_OUTPUT);
    expect(result.data).toEqual(EXPECTED_DEFAULT_FILLED_DATA);
  });

  it("keeps JSON output byte-identical after default-fill for a v7 host row without runConfig", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const result = await buildCommand()(makeCtx(true));

    expect(JSON.stringify(result.data)).toBe(
      JSON.stringify(EXPECTED_DEFAULT_FILLED_DATA),
    );
  });

  it("keeps human and JSON output byte-identical for a bridged v6 response", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const humanResult = await buildCommand()(makeCtx(false));
    const jsonResult = await buildCommand()(makeCtx(true));

    expect(humanResult.human).toBe(LEGACY_HUMAN_OUTPUT);
    expect(JSON.stringify(jsonResult.data)).toBe(
      JSON.stringify(EXPECTED_DEFAULT_FILLED_DATA),
    );
  });
});

describe("agent list session facet", () => {
  it("renders an archived row with its marker and legend line, and keeps the not-over wording", async () => {
    // `archived` is a wire field since `agent.list@9.2`, so the schema this
    // command parses through keeps it: an archived agent reaches a CLI reader
    // with `[archived]` on the row, the legend line explaining it, and
    // `archived: true` in `--json`.
    //
    // The `stopped` clause still may not assert finality: it shipped as "the
    // agent is over as a record", which is an unqualified death claim about an
    // agent a message would wake.
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          archived: true,
          sessionState: "stopped",
          lastExit: null,
        },
      ],
    });

    const result = await buildCommand()(makeCtx(false));

    expect(result.data).toHaveProperty("agents.0.archived", true);
    expect(result.human).toContain("[archived]");
    expect(result.human).toContain("\n[archived]: the agent/chat is archived");
    expect(result.human).toContain("session: stopped");
    expect(result.human).toContain(
      "An ARCHIVED agent is not over - it stays addressable, and your next message unarchives and wakes it; a deleted one is gone",
    );
    expect(result.human).not.toContain("the agent is over as a record");
  });

  it("says no [archived] anywhere for an older host, and still carries the not-over wording", async () => {
    // A host older than `agent.list@9.2` reaches the CLI with `archived: null`
    // on every row: there is no marker to draw and no legend line to explain
    // one, so the `stopped` clause is the ONLY thing said about the row and
    // must keep qualifying it.
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          archived: null,
          sessionState: "stopped",
          lastExit: null,
        },
      ],
    });

    const result = await buildCommand()(makeCtx(false));

    expect(result.data).toHaveProperty("agents.0.archived", null);
    expect(result.human).not.toContain("[archived]");
    expect(result.human).toContain("session: stopped");
    expect(result.human).toContain(
      "An ARCHIVED agent is not over - it stays addressable, and your next message unarchives and wakes it; a deleted one is gone",
    );
  });
});

describe("agent list archived flag in --json", () => {
  it("carries archived as true, false and null exactly as sent", async () => {
    rpcMock.mockResolvedValue(
      listingWith(null, [
        { id: "gone", archived: true },
        { id: "here", archived: false },
        { id: "unknown", archived: null },
      ]),
    );

    const result = await buildCommand()(makeCtx(true));

    expect(result.data).toMatchObject({
      agents: [
        { id: "agent-parent", archived: null },
        { id: "gone", archived: true },
        { id: "here", archived: false },
        { id: "unknown", archived: null },
      ],
    });
  });
});

describe("agent list --live", () => {
  it("drops archived rows from both the data and the text, and leaves the request unchanged", async () => {
    rpcMock.mockResolvedValue(
      listingWith(false, [
        { id: "gone", archived: true },
        { id: "here", archived: false },
      ]),
    );

    const result = await buildCommandWith({ live: true, compact: false })(
      makeCtx(false),
    );

    expect(rpcMock).toHaveBeenCalledWith("agent.list", {
      epicId: "epic-1",
      senderAgentId: "agent-parent",
      scope: "user",
    });
    expect(result.data).toMatchObject({
      agents: [{ id: "agent-parent" }, { id: "here" }],
    });
    expect(JSON.stringify(result.data)).not.toContain('"gone"');
    expect(result.human).toContain("here ");
    expect(result.human).not.toContain("gone");
    expect(result.human).not.toContain("[archived] ");
  });

  it("rejects with HOST_UNSUPPORTED when any row's archived is null", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const run = buildCommandWith({ live: true, compact: false })(
      makeCtx(false),
    );

    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toMatchObject({
      exitCode: 1,
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
      message: expect.stringContaining(
        "this Host does not report archive status yet",
      ),
    });
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("Update the Host, or drop --live"),
    });
  });

  it("rejects a mixed listing, one row false and one null", async () => {
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        { ...LEGACY_LIST_RESPONSE.agents[0], archived: false },
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          id: "agent-old",
          isSelf: false,
          archived: null,
        },
      ],
    });

    await expect(
      buildCommandWith({ live: true, compact: false })(makeCtx(false)),
    ).rejects.toMatchObject({
      exitCode: 1,
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
    });
  });

  it("does not reject archived: null rows without --live", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    await expect(
      buildCommandWith({ live: false, compact: false })(makeCtx(false)),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("agent list --compact", () => {
  it("drops folders and model from the text and leaves the data alone", async () => {
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: null,
            fastMode: null,
          },
        },
      ],
    });

    const full = await buildCommand()(makeCtx(false));
    const compact = await buildCommandWith({ live: false, compact: true })(
      makeCtx(false),
    );

    expect(full.human).toContain("dir: /repo");
    expect(full.human).toContain("model: gpt-5.6-codex");
    expect(compact.human).not.toContain("dir:");
    expect(compact.human).not.toContain("model:");
    expect(compact.human).toContain('agent-parent [self] "Parent" gui/codex');
    expect(compact.data).toEqual(full.data);
  });

  it("combines with --live: archived rows go, the rest print compact", async () => {
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        { ...LEGACY_LIST_RESPONSE.agents[0], archived: false },
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          id: "gone",
          isSelf: false,
          parentId: "agent-parent",
          title: "gone",
          archived: true,
        },
      ],
    });

    const result = await buildCommandWith({ live: true, compact: true })(
      makeCtx(false),
    );

    expect(result.data).toMatchObject({ agents: [{ id: "agent-parent" }] });
    expect(JSON.stringify(result.data)).not.toContain('"gone"');
    expect(result.human).not.toContain("gone");
    expect(result.human).not.toContain("dir:");
    expect(result.human).toContain('agent-parent [self] "Parent" gui/codex');
  });
});
