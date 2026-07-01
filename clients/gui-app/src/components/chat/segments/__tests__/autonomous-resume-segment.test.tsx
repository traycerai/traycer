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

  it("renders monitor triggers as non-expandable cards with no output row", () => {
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
          },
        ]}
      />,
    );

    expect(screen.queryByRole("status", { name: "Resumed" })).toBeNull();
    // Monitor never has a capturable output file, so the card is a static
    // header - no expand toggle/button, no "Output file unavailable" row.
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
});
