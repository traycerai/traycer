import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listTerminalsResponseSchemaV23 } from "@traycer/protocol/host/terminal/unary-schemas";
import type { CanonicalTerminalSessionInfoWithLifecycleOwner } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  buildTerminalListCommand,
  formatTerminalListTable,
  type TerminalListRow,
} from "../terminal-list";
import { buildTerminalOutputCommand } from "../terminal-output";
import { callHostRpc } from "../../internal/host-rpc";
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
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

// Neither command reads the context, but `CommandFn` requires one.
const ctx = {} as CommandContext;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRAYCER_EPIC_ID = "epic-1";
});

afterEach(() => {
  delete process.env.TRAYCER_EPIC_ID;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function session(
  overrides: Partial<CanonicalTerminalSessionInfoWithLifecycleOwner>,
): CanonicalTerminalSessionInfoWithLifecycleOwner {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/repo",
    currentCwd: "/work/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1_700_000_000_000,
    title: "build",
    activeProcessName: "vitest",
    lifecycleOwner: "registry",
    ...overrides,
  };
}

function row(overrides: Partial<TerminalListRow>): TerminalListRow {
  return {
    terminalId: "term-1",
    title: "build",
    cwd: "/work/repo",
    currentCwd: "/work/repo",
    status: "running",
    exitCode: null,
    createdAt: 1_700_000_000_000,
    activeProcessName: "vitest",
    ...overrides,
  };
}

describe("formatTerminalListTable", () => {
  it("returns an explicit empty-state line rather than a bare header", () => {
    expect(formatTerminalListTable([])).toBe("No terminals open in this Task.");
  });

  it("renders a header row, one row per terminal, and how to read one", () => {
    const table = formatTerminalListTable([row({})]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("TITLE");
    expect(lines[0]).toContain("STATUS");
    expect(lines[0]).toContain("PROCESS");
    expect(lines[0]).toContain("DIRECTORY");
    expect(lines[1]).toContain("term-1");
    expect(lines[1]).toContain("build");
    expect(lines[1]).toContain("running");
    expect(lines[1]).toContain("vitest");
    expect(lines[1]).toContain("/work/repo");
    expect(table).toContain("traycer terminal output <terminal-id>");
  });

  it("shows the exit code for a finished terminal and a dash for no process", () => {
    const table = formatTerminalListTable([
      row({ status: "exited", exitCode: 1, activeProcessName: null }),
    ]);
    expect(table).toContain("exited(1)");
    expect(table.split("\n")[1]).toContain(" - ");
  });

  it("shows the shell's live directory, not the launch directory", () => {
    const table = formatTerminalListTable([
      row({ cwd: "/work/repo", currentCwd: "/work/repo/packages/api" }),
    ]);
    expect(table).toContain("/work/repo/packages/api");
  });
});

describe("buildTerminalListCommand", () => {
  it("lists the epic's plain terminals and drops terminal-agent sessions", async () => {
    rpcMock.mockResolvedValue({
      sessions: [
        session({ sessionId: "term-shell" }),
        session({ sessionId: "term-agent", sessionKind: "terminal-agent" }),
      ],
      homeCwd: "/home/dev",
    });

    const result = await buildTerminalListCommand({ epicId: null })(ctx);

    expect(rpcMock).toHaveBeenCalledWith("terminal.list", {
      scope: { kind: "epic", epicId: "epic-1" },
    });
    expect(result.data).toEqual({
      terminals: [
        {
          terminalId: "term-shell",
          title: "build",
          cwd: "/work/repo",
          currentCwd: "/work/repo",
          status: "running",
          exitCode: null,
          createdAt: 1_700_000_000_000,
          activeProcessName: "vitest",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
  });

  it("falls back to the working directory's name when the tab was never renamed", async () => {
    rpcMock.mockResolvedValue({
      sessions: [
        session({
          title: null,
          cwd: "/work/api-server",
          currentCwd: "/work/api-server",
        }),
      ],
      homeCwd: "/home/dev",
    });

    const result = await buildTerminalListCommand({ epicId: null })(ctx);

    expect(result.human).toContain("api-server");
  });

  it("names an untitled terminal after the live directory, matching its own DIRECTORY column", async () => {
    rpcMock.mockResolvedValue({
      sessions: [
        session({
          title: null,
          cwd: "/work/repo",
          currentCwd: "/work/repo/packages/api",
        }),
      ],
      homeCwd: "/home/dev",
    });

    const result = await buildTerminalListCommand({ epicId: null })(ctx);

    expect(result.data).toMatchObject({ terminals: [{ title: "api" }] });
  });

  it("parses a v2.3 terminal.list payload without stripping lifecycleOwner", () => {
    // The v1.4-equivalent regression for this method: a stale v2.2 schema
    // strips the additive `lifecycleOwner` field silently (Zod discards
    // unknown keys). The canonical v2.3 parse must keep it, even though the
    // CLI's own row shape does not currently surface it downstream.
    const wireSession = session({ lifecycleOwner: "manager" });
    const parsed = listTerminalsResponseSchemaV23.parse({
      sessions: [wireSession],
      homeCwd: "/home/dev",
    });
    expect(parsed.sessions[0]?.lifecycleOwner).toBe("manager");
  });
});

describe("buildTerminalOutputCommand", () => {
  it("prints where the output landed instead of dumping it", async () => {
    rpcMock.mockResolvedValue({ path: "/tmp/traycer-terminal-output/t1.txt" });

    const result = await buildTerminalOutputCommand({
      epicId: null,
      terminalId: "term-1",
    })(ctx);

    expect(rpcMock).toHaveBeenCalledWith("terminal.readOutput", {
      epicId: "epic-1",
      sessionId: "term-1",
    });
    expect(result.data).toEqual({
      path: "/tmp/traycer-terminal-output/t1.txt",
    });
    expect(result.human).toBe(
      "terminal output written to /tmp/traycer-terminal-output/t1.txt",
    );
    expect(result.exitCode).toBe(0);
  });

  it("forwards an id prefix untouched - the host does the resolving", async () => {
    rpcMock.mockResolvedValue({ path: "/tmp/traycer-terminal-output/t1.txt" });

    await buildTerminalOutputCommand({ epicId: null, terminalId: "term" })(ctx);

    expect(rpcMock).toHaveBeenCalledWith("terminal.readOutput", {
      epicId: "epic-1",
      sessionId: "term",
    });
  });

  it("addresses the Task the caller names rather than the ambient one", async () => {
    rpcMock.mockResolvedValue({ path: "/tmp/traycer-terminal-output/t1.txt" });

    await buildTerminalOutputCommand({
      epicId: "epic-other",
      terminalId: "term-1",
    })(ctx);

    // Same allowance `traycer agent transcript` has: the read is Task-scoped,
    // and which Task is the caller's to say.
    expect(rpcMock).toHaveBeenCalledWith("terminal.readOutput", {
      epicId: "epic-other",
      sessionId: "term-1",
    });
  });
});
