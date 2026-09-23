import { cleanup, render, screen } from "@testing-library/react";
import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { afterEach, describe, expect, it } from "vitest";
import { ResolvedApprovalSegment } from "@/components/chat/segments/approval-segment";

describe("<ResolvedApprovalSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the approval input summary in the resolved header", () => {
    render(
      <ResolvedApprovalSegment
        headerFindUnitId={null}
        toolName="bash"
        description="OpenCode requests bash permission"
        inputSummary="find . -name '*.sentry' | head -50"
        inputDetail={null}
        decision={{ approved: false, reason: null }}
        variant="card"
        initiallyOpen={false}
      />,
    );

    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("find . -name '*.sentry' | head -50")).toBeTruthy();
  });

  interface RowOptions {
    readonly description: string | null;
    readonly inputSummary: string | null;
    readonly inputDetail: ToolInputDetail | null;
    readonly reason: string | null;
  }

  function renderRow(options: RowOptions): void {
    render(
      <ResolvedApprovalSegment
        headerFindUnitId={null}
        toolName="run_command"
        description={options.description}
        inputSummary={options.inputSummary}
        inputDetail={options.inputDetail}
        decision={{ approved: true, reason: options.reason }}
        variant="card"
        initiallyOpen
      />,
    );
  }

  const COMMAND: ToolInputDetail = { kind: "command", command: "echo hi" };

  it("is not expandable when the header already says everything", () => {
    renderRow({
      description: "echo hi",
      inputSummary: "echo hi",
      inputDetail: COMMAND,
      reason: null,
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Request")).toBeNull();
  });

  it("is expandable when a decision reason exists", () => {
    renderRow({
      description: "echo hi",
      inputSummary: "echo hi",
      inputDetail: COMMAND,
      reason: "Looks safe",
    });
    expect(screen.getByRole("button")).toBeTruthy();
    expect(screen.getByText("Looks safe")).toBeTruthy();
  });

  it.each([
    ["the label", "run_command", "ls", null],
    ["the summary", "ls -la", "ls -la", null],
    [
      "the single panel text",
      "echo hi",
      "echo…",
      { kind: "command", command: "echo hi" } satisfies ToolInputDetail,
    ],
  ])(
    "omits Request when the description repeats %s",
    (_name, description, summary, detail) => {
      renderRow({
        description,
        inputSummary: summary,
        inputDetail: detail,
        reason: "why",
      });
      expect(screen.queryByText("Request")).toBeNull();
    },
  );

  it("shows Request when the description is distinct", () => {
    renderRow({
      description: "Show working tree status",
      inputSummary: "git status",
      inputDetail: null,
      reason: null,
    });
    expect(screen.getByText("Request")).toBeTruthy();
    expect(screen.getByText("Show working tree status")).toBeTruthy();
  });
});
