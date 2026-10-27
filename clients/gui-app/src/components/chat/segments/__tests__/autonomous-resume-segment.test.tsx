import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  AutonomousResumeSegment,
  type BackgroundEventCardEnding,
} from "@/components/chat/segments/autonomous-resume-segment";
import type {
  BackgroundEventEnding,
  FoldedBackgroundEvent,
} from "@/stores/composer/chat-store";

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
        variant="card"
        ending={null}
        folded={[]}
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
    expect(screen.getByText("Monitor update")).toBeTruthy();
    expect(screen.getByText("12 new log lines")).toBeTruthy();
  });

  it("still reports a terminal outcome once the producer has stopped", () => {
    render(
      <AutonomousResumeSegment
        variant="card"
        ending={null}
        folded={[]}
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
    expect(screen.queryByText("Monitor update")).toBeNull();
    expect(screen.queryByText("Command still running")).toBeNull();
  });

  it("renders an mcp-identified trigger as an MCP tool card with structured identity", () => {
    render(
      <AutonomousResumeSegment
        variant="card"
        ending={null}
        folded={[]}
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

    expect(screen.getByText("Background MCP tool completed")).toBeTruthy();
    expect(screen.getByText("probe · slow_op")).toBeTruthy();
    expect(screen.queryByText("Command completed")).toBeNull();
  });

  it("renders a background command resume card that fetches output on expand", () => {
    render(
      <AutonomousResumeSegment
        variant="card"
        ending={null}
        folded={[]}
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
        variant="card"
        ending={null}
        folded={[]}
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

  // The gate is the document union, not the PDF extension - a Word document
  // output takes the identical path.
  it("renders only the output path for a .docx output file, without fetching it", () => {
    render(
      <AutonomousResumeSegment
        variant="card"
        ending={null}
        folded={[]}
        triggers={[
          {
            kind: "command",
            title: "generate brief",
            status: "completed",
            summary: "Command finished",
            blockId: "tool-4",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "/tmp/traycer-output/brief.docx",
            },
            mcp: null,
            managedCommand: null,
            live: false,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Command completed/ }));

    expect(screen.getByText("/tmp/traycer-output/brief.docx")).toBeTruthy();
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
        variant="card"
        ending={null}
        folded={[]}
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
        variant="card"
        ending={null}
        folded={[]}
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
        variant="card"
        ending={null}
        folded={[]}
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
        ending={null}
        folded={[]}
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
        variant="card"
        ending={null}
        folded={[]}
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
              hostId: null,
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
              hostId: null,
            },
            live: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Monitor update")).toBeTruthy();
    expect(screen.getByText("Shell update")).toBeTruthy();
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
        managedCommand: {
          commandId: "same-command",
          monitoring: false,
          hostId: null,
        },
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
        managedCommand: {
          commandId: "same-command",
          monitoring: false,
          hostId: null,
        },
        live: false,
      },
    ];

    try {
      const view = render(
        <AutonomousResumeSegment
          variant="card"
          ending={null}
          folded={[]}
          triggers={triggers}
        />,
      );

      expect(screen.getByText("first child")).toBeTruthy();
      expect(screen.getByText("second child")).toBeTruthy();
      view.rerender(
        <AutonomousResumeSegment
          variant="card"
          ending={null}
          folded={[]}
          triggers={[...triggers]}
        />,
      );
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
        variant="card"
        ending={null}
        folded={[]}
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

  const MCP_FAILED_TRIGGER: AutonomousResumeTrigger = {
    kind: "command",
    title: "probe/slow_op",
    status: "failed",
    summary: "Connection reset by peer",
    blockId: "tool-10",
    outputFile: null,
    mcp: { serverName: "probe", toolName: "slow_op" },
    managedCommand: null,
    live: false,
  };

  const SUBAGENT_TRIGGER: AutonomousResumeTrigger = {
    kind: "subagent",
    title: "reviewer",
    status: "completed",
    summary: "Review finished with two findings.",
    blockId: "tool-11",
    outputFile: null,
    mcp: null,
    managedCommand: null,
    live: false,
  };

  const MONITOR_UPDATE: AutonomousResumeTrigger = {
    kind: "monitor",
    title: "build watch",
    status: "completed",
    summary: "still running - 4 new log lines",
    blockId: "managed-monitor-1",
    outputFile: null,
    mcp: null,
    managedCommand: {
      commandId: "cmd-monitor",
      monitoring: true,
      hostId: null,
    },
    live: true,
  };

  const foldedEvent = (
    key: string,
    trigger: AutonomousResumeTrigger,
    ending: BackgroundEventEnding,
  ): FoldedBackgroundEvent => ({ key, trigger, ending });

  const NO_REPLY_3S: BackgroundEventEnding = {
    kind: "no-reply",
    elapsedMs: 3_000,
  };

  it("draws a failed background MCP trigger as a static card with its summary previewed", () => {
    render(
      <AutonomousResumeSegment
        triggers={[MCP_FAILED_TRIGGER]}
        variant="card"
        ending={null}
        folded={[]}
      />,
    );

    expect(screen.getByText("Background MCP tool failed")).toBeTruthy();
    expect(screen.getByText("Connection reset by peer")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens a subagent card's result from its disclosure", () => {
    render(
      <AutonomousResumeSegment
        triggers={[SUBAGENT_TRIGGER]}
        variant="card"
        ending={null}
        folded={[]}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Subagent completed/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(
      screen.getAllByText(/Review finished with two findings\./).length,
    ).toBeGreaterThan(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the row variant non-expandable for the same subagent trigger", () => {
    render(
      <AutonomousResumeSegment
        triggers={[SUBAGENT_TRIGGER]}
        variant="row"
        ending={null}
        folded={[]}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  describe("the card's foot", () => {
    const renderFoot = (
      ending: BackgroundEventCardEnding | null,
      folded: ReadonlyArray<FoldedBackgroundEvent>,
    ) =>
      render(
        <AutonomousResumeSegment
          triggers={[MONITOR_UPDATE]}
          variant="card"
          ending={ending}
          folded={folded}
        />,
      );

    it("shows the elapsed time of a turn that drew no reply", () => {
      renderFoot(
        { value: { kind: "no-reply", elapsedMs: 6_000 }, details: null },
        [],
      );

      expect(screen.getByText("No reply · 6s")).toBeTruthy();
    });

    it("puts the turn's details behind the no-reply ending", () => {
      renderFoot(
        {
          value: { kind: "no-reply", elapsedMs: 6_000 },
          details: <span>turn details</span>,
        },
        [],
      );

      expect(screen.getByTestId("background-event-ending").textContent).toBe(
        "No reply · 6s",
      );
    });

    it("says the agent was not resumed when no turn picked the event up", () => {
      renderFoot({ value: { kind: "not-resumed" }, details: null }, []);

      expect(screen.getByText("Agent not resumed")).toBeTruthy();
    });

    it("draws no foot for a card with neither an ending nor earlier events", () => {
      renderFoot(null, []);

      expect(screen.queryByText(/No reply|not resumed|earlier/)).toBeNull();
    });

    it("counts earlier events and says no reply when the card has no ending of its own", () => {
      renderFoot(null, [
        foldedEvent("a#0", MONITOR_UPDATE, NO_REPLY_3S),
        foldedEvent("b#0", MONITOR_UPDATE, NO_REPLY_3S),
      ]);

      expect(screen.getByText("2 earlier updates, no reply")).toBeTruthy();
    });

    it("leaves out ', no reply' when an earlier event was not resumed", () => {
      renderFoot(null, [
        foldedEvent("a#0", MONITOR_UPDATE, NO_REPLY_3S),
        foldedEvent("b#0", MONITOR_UPDATE, { kind: "not-resumed" }),
      ]);

      expect(screen.getByText("2 earlier updates")).toBeTruthy();
    });

    it("leaves out ', no reply' when the card has an ending of its own", () => {
      renderFoot(
        { value: { kind: "no-reply", elapsedMs: 6_000 }, details: null },
        [foldedEvent("a#0", MONITOR_UPDATE, NO_REPLY_3S)],
      );

      expect(screen.getByText("No reply · 6s")).toBeTruthy();
      expect(screen.getByText("1 earlier update")).toBeTruthy();
    });

    it("names earlier scheduled wakes as wakes", () => {
      const wake: AutonomousResumeTrigger = {
        kind: "wakeup",
        title: "check the deploy",
        status: "completed",
        summary: "Scheduled wake fired.",
        blockId: "wake-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
        live: false,
      };
      renderFoot(null, [
        foldedEvent("a#0", wake, NO_REPLY_3S),
        foldedEvent("b#0", wake, NO_REPLY_3S),
      ]);

      expect(screen.getByText("2 earlier wakes, no reply")).toBeTruthy();
    });

    it("names earlier events of mixed kinds as events", () => {
      renderFoot(null, [
        foldedEvent("a#0", MONITOR_UPDATE, NO_REPLY_3S),
        foldedEvent("b#0", SUBAGENT_TRIGGER, NO_REPLY_3S),
      ]);

      expect(screen.getByText("2 earlier events, no reply")).toBeTruthy();
    });

    it("lists the earlier events, oldest first, once the card is opened", () => {
      renderFoot(null, [
        foldedEvent(
          "a#0",
          { ...MONITOR_UPDATE, summary: "still running - first batch" },
          NO_REPLY_3S,
        ),
        foldedEvent(
          "b#0",
          { ...MONITOR_UPDATE, summary: "still running - second batch" },
          { kind: "not-resumed" },
        ),
      ]);

      expect(screen.queryByText("Earlier")).toBeNull();
      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByText("Earlier")).toBeTruthy();
      const items = screen.getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "first batch·No reply · 3s",
        "second batch·Agent not resumed",
      ]);
    });

    it("tells earlier wakes with the same title apart by what each said", () => {
      const wake = (summary: string): AutonomousResumeTrigger => ({
        kind: "wakeup",
        title: "check the deploy",
        status: "completed",
        summary,
        blockId: "wake-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
        live: false,
      });
      renderFoot(null, [
        foldedEvent("a#0", wake("Look at the error rate."), NO_REPLY_3S),
        foldedEvent("b#0", wake("Look at the queue depth."), NO_REPLY_3S),
      ]);

      fireEvent.click(screen.getByRole("button"));

      expect(
        screen.getByText("check the deploy · Look at the error rate."),
      ).toBeTruthy();
      expect(
        screen.getByText("check the deploy · Look at the queue depth."),
      ).toBeTruthy();
    });

    it("opens an earlier subagent's result from its entry", () => {
      renderFoot(null, [
        foldedEvent(
          "a#0",
          { ...SUBAGENT_TRIGGER, summary: "**Two findings** in the diff." },
          NO_REPLY_3S,
        ),
      ]);
      fireEvent.click(screen.getByRole("button"));
      const entry = within(screen.getByRole("listitem")).getByRole("button");

      expect(entry.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Two findings")).toBeNull();
      fireEvent.click(entry);

      expect(entry.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("Two findings")).toBeTruthy();
    });

    it("shows an earlier shell delivery's summary alone and keeps it closed", () => {
      renderFoot(null, [
        foldedEvent(
          "a#0",
          {
            ...MONITOR_UPDATE,
            summary: "still running - 9 new log lines",
            outputFile: {
              workspacePath: "/tmp/traycer-output",
              filePath: "build.log",
            },
          },
          NO_REPLY_3S,
        ),
      ]);
      fireEvent.click(screen.getByRole("button"));

      const entry = screen.getByRole("listitem");
      expect(entry.textContent).toBe("9 new log lines·No reply · 3s");
      expect(within(entry).queryByRole("button")).toBeNull();
    });
  });
});
