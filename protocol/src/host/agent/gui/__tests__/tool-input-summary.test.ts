import { describe, expect, it } from "vitest";
import { deriveToolInputSummary, toSummaryLine } from "../tool-input-summary";

const EXISTING_REGISTRY_SNAPSHOTS = [
  {
    toolName: "read_file",
    input: { path: "src/a.ts", startLine: 3, endLine: 9 },
    expectedSummary: "src/a.ts:3-9",
  },
  {
    toolName: "write_file",
    input: { path: "src/new.ts" },
    expectedSummary: "src/new.ts",
  },
  {
    toolName: "edit_file",
    input: { filePath: "src/edit.ts", start: 2, end: 4 },
    expectedSummary: "src/edit.ts:2-4",
  },
  {
    toolName: "list_files",
    input: { dir: "src/components" },
    expectedSummary: "src/components",
  },
  {
    toolName: "glob",
    input: { pattern: "**/*.ts" },
    expectedSummary: "**/*.ts",
  },
  {
    toolName: "grep",
    input: { query: "TODO", path: "src" },
    expectedSummary: "TODO in src",
  },
  {
    toolName: "bash",
    input: { metadata: { command: "git status" } },
    expectedSummary: "git status",
  },
  {
    toolName: "run_command",
    input: { cmd: "bun run test" },
    expectedSummary: "bun run test",
  },
  {
    toolName: "web_fetch",
    input: { url: "https://example.com" },
    expectedSummary: "https://example.com",
  },
  {
    toolName: "web_search",
    input: { query: "release notes", path: "docs" },
    expectedSummary: "release notes in docs",
  },
  {
    toolName: "traycer_list_comment_threads",
    input: { artifactPaths: ["a/index.md", "b/index.md"], status: "open" },
    expectedSummary: "2 artifacts, open",
  },
  {
    toolName: "traycer_set_comment_thread_status",
    input: {
      updates: [{ threadIds: ["t1", "t2"], status: "resolved" }],
    },
    expectedSummary: "2 threads -> resolved",
  },
] as const;

const NEW_REGISTRY_SAMPLES = [
  {
    toolName: "CronCreate",
    input: {
      cron: "0 9 * * 1",
      prompt: "Review open pull requests",
      recurring: true,
      durable: true,
    },
    expectedSummary: "0 9 * * 1 · Review open pull requests",
  },
  {
    toolName: "CronList",
    input: {},
    expectedSummary: "Lists scheduled tasks",
  },
  {
    toolName: "CronDelete",
    input: { id: "job-123" },
    expectedSummary: "Deletes scheduled task job-123",
  },
  {
    toolName: "EnterWorktree",
    input: { name: "feature/cleanup" },
    expectedSummary: "feature/cleanup",
  },
  {
    toolName: "ExitWorktree",
    input: { action: "keep" },
    expectedSummary: "Keeps the worktree",
  },
  {
    toolName: "EnterPlanMode",
    input: {},
    expectedSummary: "Enters plan mode",
  },
  {
    toolName: "TaskGet",
    input: { taskId: "task-123" },
    expectedSummary: "Reads task task-123",
  },
  {
    toolName: "ReportFindings",
    input: {
      level: "high",
      findings: [
        {
          file: "src/a.ts",
          line: 42,
          summary: "Reject invalid origins",
          failure_scenario:
            "A request with an untrusted origin is accepted without validation.",
        },
        {
          file: "src/b.ts",
          summary: "Prevent stale writes",
          failure_scenario:
            "An older revision overwrites a newer revision after a delayed save.",
        },
      ],
    },
    expectedSummary: "2 findings",
  },
  {
    toolName: "Artifact",
    input: {
      action: "publish",
      file_path: "/tmp/migration-review.html",
      title: "Migration Review",
      icon: "map",
    },
    expectedSummary: "Migration Review",
  },
  {
    toolName: "PushNotification",
    input: {
      message: "The deployment finished successfully.",
      status: "proactive",
    },
    expectedSummary: "The deployment finished successfully.",
  },
  {
    toolName: "RemoteTrigger",
    input: { action: "run", trigger_id: "trigger-42" },
    expectedSummary: "run trigger trigger-42",
  },
  {
    toolName: "SendFeedback",
    input: {
      type: "idea",
      title: "Support custom themes",
      details: [
        "What happened: Custom colors reset after restart.",
        "What the user said: Keep the selected colors.",
        "Repro: Select custom colors and restart the app.",
        "Evidence: None",
      ].join("\n"),
    },
    expectedSummary: "Support custom themes",
  },
  {
    toolName: "ProposeGoal",
    input: { condition: "All protocol tests pass", ask_user: true },
    expectedSummary: "All protocol tests pass",
  },
  {
    toolName: "ReadNotifications",
    input: {},
    expectedSummary: "Reads notifications",
  },
  {
    toolName: "SubagentHandback",
    input: { message: "Reviewed the workspace; all invariants hold." },
    expectedSummary:
      "Hands a report back to the caller: Reviewed the workspace; all invariants hold.",
  },
] as const;

const EXACT_ALIAS_SAMPLES = [
  ["Read", { path: "src/a.ts", startLine: 3, endLine: 9 }, "src/a.ts:3-9"],
  ["Write", { path: "src/new.ts" }, "src/new.ts"],
  ["Edit", { filePath: "src/edit.ts", start: 2, end: 4 }, "src/edit.ts:2-4"],
  ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
  ["Grep", { pattern: "TODO", path: "src" }, "TODO in src"],
  ["Bash", { metadata: { command: "git status" } }, "git status"],
  ["WebFetch", { url: "https://example.com" }, "https://example.com"],
  [
    "WebSearch",
    { query: "release notes", path: "docs" },
    "release notes in docs",
  ],
] as const;

describe("tool summary registry compatibility", () => {
  it.each(EXISTING_REGISTRY_SNAPSHOTS)(
    "keeps the pre-change summary from old-shape persisted input for $toolName",
    ({ toolName, input, expectedSummary }) => {
      // Old-shape tool-call blocks persisted the raw `input`; migration reads
      // that field before removing it and derives the summary again.
      const oldShapeBlock = { toolName, input, output: "persisted result" };
      expect(
        deriveToolInputSummary(oldShapeBlock.toolName, oldShapeBlock.input),
      ).toBe(expectedSummary);
    },
  );

  it.each(NEW_REGISTRY_SAMPLES)(
    "summarizes realistic $toolName input",
    ({ toolName, input, expectedSummary }) => {
      expect(deriveToolInputSummary(toolName, input)).toBe(expectedSummary);
    },
  );

  it("summarizes an Artifact by its file name when it has no title", () => {
    expect(
      deriveToolInputSummary("Artifact", {
        action: "upload_asset",
        url: "https://artifacts.example/review",
        file_paths: ["/tmp/diagram.png"],
      }),
    ).toBe("diagram.png");
  });

  it.each(EXACT_ALIAS_SAMPLES)(
    "resolves the exact Claude alias %s",
    (toolName, input, expectedSummary) => {
      expect(deriveToolInputSummary(toolName, input)).toBe(expectedSummary);
    },
  );

  it("does not apply a registry alias to an MCP-prefixed name ending in its target", () => {
    expect(
      deriveToolInputSummary("mcp__server__web_search", {
        query: "release notes",
        path: "docs",
      }),
    ).toBe("docs");
  });

  it("keeps TaskOutput and REPL on the generic fallback", () => {
    expect(
      deriveToolInputSummary("TaskOutput", {
        task_id: "task-123",
        block: true,
        timeout: 30_000,
      }),
    ).toBeNull();
    expect(
      deriveToolInputSummary("REPL", {
        title: "Check the page",
        code: "await page.title()",
      }),
    ).toBe("Check the page");
  });

  it("keeps SubagentHandback's fixed prefix and applies the 80-unit cap", () => {
    const summary = deriveToolInputSummary("SubagentHandback", {
      message: "x".repeat(60),
    });
    expect(summary).toBe(
      `Hands a report back to the caller: ${"x".repeat(44)}…`,
    );
    expect(summary?.length).toBe(80);
  });
});

describe("deriveToolInputSummary", () => {
  it("summarizes OpenCode shell approvals from nested metadata command", () => {
    expect(
      deriveToolInputSummary("bash", {
        type: "bash",
        metadata: { command: "find . -name '*.sentry' | head -50" },
        pattern: ["find . -name '*.sentry'", "head -50"],
      }),
    ).toBe("find . -name '*.sentry' | head -50");
  });

  it("summarizes comment thread list inputs", () => {
    expect(
      deriveToolInputSummary("traycer_list_comment_threads", {
        artifactPaths: null,
        status: "all",
      }),
    ).toBe("all artifacts, all");

    expect(
      deriveToolInputSummary("traycer_list_comment_threads", {
        artifactPaths: ["spec-a/index.md", "ticket-b/index.md"],
        status: "open",
      }),
    ).toBe("2 artifacts, open");
  });

  it("summarizes comment thread status updates", () => {
    expect(
      deriveToolInputSummary("traycer_set_comment_thread_status", {
        updates: [
          {
            artifactPath: "spec-a/index.md",
            threadIds: ["thread-1", "thread-2"],
            status: "resolved",
          },
          {
            artifactPath: "ticket-b/index.md",
            threadIds: ["thread-3"],
            status: "resolved",
          },
        ],
      }),
    ).toBe("3 threads -> resolved");
  });

  it("keeps the registry's own summaries for the lowercase tool names", () => {
    expect(
      deriveToolInputSummary("read_file", {
        path: "src/a.ts",
        startLine: 3,
        endLine: 9,
      }),
    ).toBe("src/a.ts:3-9");
    expect(deriveToolInputSummary("grep", { query: "TODO", path: "src" })).toBe(
      "TODO in src",
    );
    expect(
      deriveToolInputSummary("bash", {
        description: "Push",
        command: "git push",
      }),
    ).toBe("git push");
    expect(
      deriveToolInputSummary("web_fetch", { url: "https://example.com" }),
    ).toBe("https://example.com");
    expect(deriveToolInputSummary("glob", { pattern: "**/*.ts" })).toBe(
      "**/*.ts",
    );
  });

  it("passes a string input through", () => {
    expect(deriveToolInputSummary("Anything", "  ls -la  ")).toBe("ls -la");
  });
});

describe("deriveToolInputSummary: the generic ranking", () => {
  it("summarizes Claude's Edit by its file_path even when it is sent last", () => {
    expect(
      deriveToolInputSummary("Edit", {
        old_string: "const a = 1;",
        new_string: "const a = 2;",
        file_path: "/repo/src/a.ts",
      }),
    ).toBe("/repo/src/a.ts");
  });

  it.each([
    ["absolute_path", "Read"],
    ["notebook_path", "NotebookEdit"],
    ["directory", "list_directory"],
  ] as const)(
    "ranks %s above an earlier agent-authored string",
    (key, toolName) => {
      expect(
        deriveToolInputSummary(toolName, {
          description: "Look at the thing",
          [key]: "/repo/target",
        }),
      ).toBe("/repo/target");
    },
  );

  it("summarizes Claude's Bash by its command, not its description", () => {
    expect(
      deriveToolInputSummary("Bash", {
        description: "Force-push the branch",
        command: "git push --force",
      }),
    ).toBe("git push --force");
  });

  it("summarizes Claude's Task by its description, the accepted agent-authored case", () => {
    expect(
      deriveToolInputSummary("Task", {
        description: "Audit the resolvers",
        prompt: "Read every resolver and report which ones skip validation.",
        subagent_type: "general-purpose",
      }),
    ).toBe("Audit the resolvers");
  });

  it("joins a Codex argv command with spaces", () => {
    expect(
      deriveToolInputSummary("command", {
        threadId: "thread-7f3a",
        command: ["git", "push", "--force"],
      }),
    ).toBe("git push --force");
  });

  it("summarizes a real execCommandApproval by its command, not the cwd beside it", () => {
    expect(
      deriveToolInputSummary("command", {
        conversationId: "thread-real-123",
        callId: "call-exec-1",
        approvalId: null,
        command: ["bun", "test", "--watch"],
        cwd: "/tmp/project",
        reason: "Needs approval",
        parsedCmd: [],
      }),
    ).toBe("bun test --watch");
  });

  it("summarizes a string command beside a cwd by the command", () => {
    expect(
      deriveToolInputSummary("command", {
        kind: "command",
        threadId: "thread-7f3a",
        turnId: "turn-1",
        itemId: "cmd-1",
        reason: "Needs approval",
        command: "bun test",
        cwd: "/tmp/project",
      }),
    ).toBe("bun test");
  });

  it("quotes an argv element that is not a bare shell word", () => {
    expect(
      deriveToolInputSummary("command", {
        command: ["bash", "-lc", "git push --force"],
      }),
    ).toBe('bash -lc "git push --force"');
    expect(
      deriveToolInputSummary("command", {
        argv: ["grep", "a|b", "notes.txt"],
      }),
    ).toBe('grep "a|b" notes.txt');
  });

  it("does not take an argv array with a non-string element, or with no content", () => {
    expect(
      deriveToolInputSummary("command", {
        threadId: "thread-7f3a",
        command: ["rm", 1],
        reason: "Needs approval",
      }),
    ).toBe("Needs approval");
    expect(
      deriveToolInputSummary("command", {
        command: [" ", ""],
        reason: "Needs approval",
      }),
    ).toBe("Needs approval");
  });

  it("skips an array under a key that is not a command key", () => {
    expect(
      deriveToolInputSummary("Search", {
        pattern: ["a", "b"],
        name: "finder",
      }),
    ).toBe("finder");
  });

  it("falls back to the cwd, not the thread id, when Codex omits the command", () => {
    const summary = deriveToolInputSummary("command", {
      kind: "command",
      threadId: "thread-7f3a",
      turnId: "turn-1",
      itemId: "cmd-1",
      cwd: "/tmp/project",
    });
    expect(summary).toBe("/tmp/project");
  });

  it("never falls back to an id, in any case or spelling", () => {
    expect(
      deriveToolInputSummary("command", {
        threadId: "thread-7f3a",
        turnId: "turn-1",
        itemId: "cmd-1",
        reason: "Needs approval",
      }),
    ).toBe("Needs approval");
    expect(
      deriveToolInputSummary("mcp_tool", {
        ID: "row-1",
        SessionID: "session-1",
        conversationid: "conversation-1",
        CALLID: "call-1",
        toolCallId: "tool-call-1",
        tool_use_id: "toolu_1",
        note: "the real content",
      }),
    ).toBe("the real content");
    expect(
      deriveToolInputSummary("mcp_tool", {
        threadId: "thread-7f3a",
        sessionId: "session-1",
      }),
    ).toBeNull();
  });
});

describe("the 80-unit cap never cuts through a surrogate pair", () => {
  // `SUMMARY_MAX` is 80 UTF-16 units, so the cut keeps units 0-78 and then
  // appends the ellipsis as unit 79.
  const CUT_ACROSS_PAIR = `${"a".repeat(78)}\u{1F600}${"b".repeat(25)}`;

  function expectWellFormedCap(summary: string | null): string {
    if (summary === null) throw new Error("expected a summary");
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("\u2026")).toBe(true);
    expect(summary.isWellFormed()).toBe(true);
    const beforeEllipsis = summary.charCodeAt(summary.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    return summary;
  }

  it("drops a pair the cut would split, for the reviewer's Bash repro", () => {
    const summary = expectWellFormedCap(
      deriveToolInputSummary("Bash", { command: CUT_ACROSS_PAIR }),
    );
    expect(summary).toBe(`${"a".repeat(78)}\u2026`);
  });

  it("keeps a pair that sits wholly inside the cut, at units 76-77", () => {
    const summary = expectWellFormedCap(
      deriveToolInputSummary("Bash", {
        command: `${"a".repeat(76)}\u{1F600}${"b".repeat(30)}`,
      }),
    );
    expect(summary).toBe(`${"a".repeat(76)}\u{1F600}b\u2026`);
    expect(summary.length).toBe(80);
  });

  it("applies the same cut through toSummaryLine", () => {
    const summary = expectWellFormedCap(toSummaryLine(CUT_ACROSS_PAIR));
    expect(summary).toBe(`${"a".repeat(78)}\u2026`);
  });

  it("applies the same cut to a path through the generic pass", () => {
    const summary = expectWellFormedCap(
      deriveToolInputSummary("Edit", {
        old_string: "a",
        new_string: "b",
        file_path: `/repo/${"d".repeat(72)}\u{1F600}/file.ts`,
      }),
    );
    expect(summary).toBe(`/repo/${"d".repeat(72)}\u2026`);
  });
});
