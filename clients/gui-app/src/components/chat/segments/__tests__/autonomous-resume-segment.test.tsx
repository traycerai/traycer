import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomousResumeSegment } from "@/components/chat/segments/autonomous-resume-segment";

const hostQueryMock = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly method: string;
    readonly params: {
      readonly workspacePath: string;
      readonly filePath: string;
      readonly maxBytes: number;
    };
    readonly options: { readonly enabled?: boolean };
  }>,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ request: vi.fn() }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: (typeof hostQueryMock.calls)[number]) => {
    hostQueryMock.calls.push(args);
    if (args.options.enabled !== true) {
      return {
        data: undefined,
        error: null,
        isPending: false,
        isFetching: false,
      };
    }
    return {
      data: {
        workspacePath: args.params.workspacePath,
        filePath: args.params.filePath,
        content: "line one\nline two\n",
        truncated: true,
        error: null,
      },
      error: null,
      isPending: false,
      isFetching: false,
    };
  },
}));

describe("<AutonomousResumeSegment />", () => {
  afterEach(() => {
    cleanup();
    hostQueryMock.calls = [];
  });

  it("never claims a still-running producer finished", () => {
    // `status` is a persisted enum with no value for "running", so a digest
    // from a shell still streaming carries
    // `completed` for older readers. A reader that understands `live` must
    // prefer it - otherwise the most glanceable line in the turn says the
    // command is done while it is still going.
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "monitor",
            title: "build watch",
            status: "completed",
            live: true,
            summary: "still running - 12 new log lines",
            blockId: "",
            outputFile: null,
            mcp: null,
            managedCommand: null,
          },
        ]}
      />,
    );

    expect(screen.queryByText("Shell completed")).toBeNull();
    expect(screen.getByText("Monitor running")).toBeTruthy();
    expect(screen.getByText("12 new log lines")).toBeTruthy();
  });

  it("still reports a terminal outcome once the producer has stopped", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "monitor",
            title: "build watch",
            status: "failed",
            live: false,
            summary: "3 new log lines",
            blockId: "",
            outputFile: null,
            mcp: null,
            managedCommand: null,
          },
        ]}
      />,
    );

    // Kind-only trigger (no `managedCommand` block): the harness's own
    // Monitor tool, which keeps its real name.
    expect(screen.getByText("Monitor failed")).toBeTruthy();
    expect(screen.queryByText("Monitor running")).toBeNull();
    expect(screen.queryByText("Command still running")).toBeNull();
  });

  it("renders an mcp-identified trigger as an MCP tool card with structured identity", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "command",
            title: "probe/slow_op",
            status: "completed",
            summary: 'MCP tool "probe/slow_op" completed',
            blockId: "tool-9",
            outputFile: null,
            mcp: { serverName: "probe", toolName: "slow_op" },
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    expect(screen.getByText("MCP tool completed")).toBeTruthy();
    expect(screen.getByText("probe · slow_op")).toBeTruthy();
    expect(screen.queryByText("Command completed")).toBeNull();
  });

  it("renders a background command resume card that fetches output on expand", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "command",
            title: "bun test",
            status: "completed",
            summary: "Command finished",
            blockId: "tool-1",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "task.output",
            },
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    const commandButton = screen.getByRole("button", {
      name: /Command completed/,
    });
    expect(commandButton).toBeTruthy();
    expect(screen.getByText("Command finished")).toBeTruthy();
    expect(hostQueryMock.calls).toHaveLength(0);

    fireEvent.click(commandButton);

    expect(
      hostQueryMock.calls.map((call) => ({
        method: call.method,
        params: call.params,
        options: call.options,
      })),
    ).toEqual([
      {
        method: "workspace.readFile",
        params: {
          workspacePath: "/tmp/traycer-output",
          filePath: "task.output",
          maxBytes: 500_000,
        },
        options: {
          enabled: true,
          staleTime: 30_000,
          retry: false,
        },
      },
    ]);
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText(/line one/)).toBeTruthy();
    expect(screen.getByText("Output truncated")).toBeTruthy();
  });

  it("renders only the output path for a .pdf output file, without fetching it", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "command",
            title: "generate report",
            status: "completed",
            summary: "Command finished",
            blockId: "tool-3",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "/tmp/traycer-output/report.pdf",
            },
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    const commandButton = screen.getByRole("button", {
      name: /Command completed/,
    });
    fireEvent.click(commandButton);

    expect(screen.getByText("/tmp/traycer-output/report.pdf")).toBeTruthy();
    // No "open it from the file tree" instruction - the output folder is
    // often outside every bound root.
    expect(screen.queryByText(/file tree/)).toBeNull();
    // The query hook is still called (unconditional hook call), but never
    // enabled - a PDF output is never fetched through the text pipeline.
    expect(
      hostQueryMock.calls.some(
        (call) =>
          call.method === "workspace.readFile" && call.options.enabled === true,
      ),
    ).toBe(false);
  });

  it("renders command triggers without output files as non-expandable cards", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "command",
            title: "bun test",
            status: "completed",
            summary: "Command finished",
            blockId: "tool-1",
            outputFile: null,
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    expect(screen.queryByRole("status", { name: "Resumed" })).toBeNull();
    // No captured output file, so the card is a static header - no expand
    // toggle/button, no "Output file unavailable" row.
    expect(
      screen.queryByRole("button", { name: /Command completed/ }),
    ).toBeNull();
    expect(screen.getByText("Command finished")).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
    expect(screen.queryByText("Output file unavailable.")).toBeNull();
    expect(hostQueryMock.calls).toHaveLength(0);
  });

  it("renders shell triggers as non-expandable cards with no output row", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "monitor",
            title: "All updates in ~/.traycer/host/dev/host.log",
            status: "stopped",
            summary: "Monitor stopped",
            blockId: "tool-2",
            outputFile: null,
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    expect(screen.queryByRole("status", { name: "Resumed" })).toBeNull();
    // A monitor trigger never has a capturable output file, so the card is a
    // static header - no expand toggle/button, no "Output file unavailable".
    expect(
      screen.queryByRole("button", { name: /Monitor stopped/ }),
    ).toBeNull();
    expect(
      screen.getByText("All updates in ~/.traycer/host/dev/host.log"),
    ).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
    expect(screen.queryByText("Output file unavailable.")).toBeNull();
    expect(hostQueryMock.calls).toHaveLength(0);
  });

  it("keeps a monitor delivery summary in the same compact card", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "monitor",
            title: "PR checks",
            status: "completed",
            summary: "2 new log lines",
            blockId: "monitor-delivery-1",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "monitor.output",
            },
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    const summary = screen.getByText("2 new log lines");
    const card = summary.closest(".rounded-md");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Monitor completed");
    expect(card?.textContent).toContain("PR checks");
    expect(card?.querySelector("button")).toBeNull();
    expect(hostQueryMock.calls).toHaveLength(0);
  });

  it("renders in-turn monitor deliveries as non-expandable rows", () => {
    render(
      <AutonomousResumeSegment
        variant="row"
        triggers={[
          {
            kind: "monitor",
            title: "PR checks",
            status: "completed",
            summary: "still running - 2 new log lines",
            blockId: "monitor-row-1",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "monitor.output",
            },
            mcp: null,
            managedCommand: null,
            live: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Monitor update")).toBeTruthy();
    expect(screen.getByText("2 new log lines")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the shared radar icon and shell labels for live managed deliveries", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "command",
            title: "watcher",
            status: "completed",
            summary: "still running - 1 new log line",
            blockId: "managed-monitor-1",
            outputFile: null,
            mcp: null,
            managedCommand: {
              commandId: "cmd-monitor",
              monitoring: true,
            },
            live: true,
          },
          {
            kind: "command",
            title: "migration",
            status: "completed",
            summary: "still running - 1 new log line",
            blockId: "managed-shell-1",
            outputFile: null,
            mcp: null,
            managedCommand: {
              commandId: "cmd-shell",
              monitoring: false,
            },
            live: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Monitor running")).toBeTruthy();
    expect(screen.getByText("Shell running")).toBeTruthy();
    expect(document.querySelector("[data-monitor-icon='on']")).not.toBeNull();
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("keeps same-command triggers with distinct blocks across rerenders", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const triggers = [
      {
        kind: "command" as const,
        title: "same command",
        status: "completed" as const,
        summary: "first child",
        blockId: "block-first",
        outputFile: {
          workspacePath: "/tmp/traycer-output",
          filePath: "first.output",
        },
        mcp: null,
        managedCommand: { commandId: "same-command", monitoring: false },
        live: false,
      },
      {
        kind: "command" as const,
        title: "same command",
        status: "completed" as const,
        summary: "second child",
        blockId: "block-second",
        outputFile: {
          workspacePath: "/tmp/traycer-output",
          filePath: "second.output",
        },
        mcp: null,
        managedCommand: { commandId: "same-command", monitoring: false },
        live: false,
      },
    ];

    try {
      const view = render(<AutonomousResumeSegment triggers={triggers} />);

      expect(screen.getByText("first child")).toBeTruthy();
      expect(screen.getByText("second child")).toBeTruthy();
      view.rerender(<AutonomousResumeSegment triggers={[...triggers]} />);
      expect(screen.getByText("first child")).toBeTruthy();
      expect(screen.getByText("second child")).toBeTruthy();
      expect(
        consoleError.mock.calls.some((call) =>
          call.some(
            (value) =>
              typeof value === "string" &&
              /same key|unique ["']key/i.test(value),
          ),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders wakeup triggers as non-expandable cards carrying the prompt", () => {
    render(
      <AutonomousResumeSegment
        triggers={[
          {
            kind: "wakeup",
            title: "Review the deployment",
            status: "completed",
            summary: "Check the health dashboard and summarize alerts.",
            blockId: "wake-tool",
            outputFile: null,
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("Woke on schedule")).toBeTruthy();
    expect(screen.getByText("Review the deployment")).toBeTruthy();
    expect(
      screen.getByText("Check the health dashboard and summarize alerts."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Woke on schedule/ }),
    ).toBeNull();
    expect(hostQueryMock.calls).toHaveLength(0);
  });
});
