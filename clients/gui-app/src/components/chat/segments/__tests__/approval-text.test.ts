import { describe, expect, it } from "vitest";
import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import {
  approvalCardText,
  resolvedApprovalBodyText,
} from "@/components/chat/segments/approval-text";

const LONG_COMMAND = `echo ${"a".repeat(100)}; rm -rf /tmp/victim`;

function truncatedSummary(command: string): string {
  const summary = deriveToolInputSummary("run_command", { command });
  if (summary === null) throw new Error("expected a summary");
  return summary;
}

function commandDetail(command: string): ToolInputDetail {
  return { kind: "command", command };
}

function fieldsDetail(values: ReadonlyArray<string>): ToolInputDetail {
  return {
    kind: "fields",
    entries: values.map((value, index) => ({
      key: `k${index}`,
      label: `K${index}`,
      value,
    })),
  };
}

describe("approvalCardText", () => {
  it("drops the headline for a blank description and keeps the summary", () => {
    expect(approvalCardText("bash", "git status", "   ", null)).toEqual({
      inputSummary: "git status",
      headline: null,
      inputDetail: null,
    });
  });

  it("drops the headline when the description is the tool name", () => {
    expect(approvalCardText("bash", "git status", " bash ", null)).toEqual({
      inputSummary: "git status",
      headline: null,
      inputDetail: null,
    });
  });

  it("uses the description verbatim when there is no summary", () => {
    expect(approvalCardText("bash", null, "Run  a\nthing", null)).toEqual({
      inputSummary: null,
      headline: "Run  a\nthing",
      inputDetail: null,
    });
  });

  it("drops the headline when the description equals the summary", () => {
    expect(approvalCardText("run_command", "echo hi", "echo hi", null)).toEqual(
      {
        inputSummary: "echo hi",
        headline: null,
        inputDetail: null,
      },
    );
  });

  it("compares a multi-line description to its one-line summary", () => {
    expect(
      approvalCardText(
        "run_command",
        "echo a && echo b",
        "echo a &&\n  echo b",
        null,
      ),
    ).toEqual({
      inputSummary: "echo a && echo b",
      headline: null,
      inputDetail: null,
    });
  });

  it("shows a long command once, in full, when the summary is its truncation", () => {
    const summary = truncatedSummary(LONG_COMMAND);
    expect(summary.endsWith("…")).toBe(true);
    expect(
      approvalCardText(
        "run_command",
        summary,
        LONG_COMMAND,
        commandDetail(LONG_COMMAND),
      ),
    ).toEqual({
      inputSummary: null,
      headline: LONG_COMMAND,
      inputDetail: null,
    });
  });

  it("keeps both when an ellipsis summary's prefix does not match", () => {
    expect(
      approvalCardText("bash", "something else…", "git status", null),
    ).toEqual({
      inputSummary: "something else…",
      headline: "git status",
      inputDetail: null,
    });
  });

  it("does not treat a bare ellipsis as a truncation", () => {
    expect(approvalCardText("bash", "…", "git status", null)).toEqual({
      inputSummary: "…",
      headline: "git status",
      inputDetail: null,
    });
  });

  it("keeps both when the description says something else", () => {
    expect(
      approvalCardText(
        "Bash",
        "git status",
        "Show working tree status",
        commandDetail("git status"),
      ),
    ).toEqual({
      inputSummary: "git status",
      headline: "Show working tree status",
      inputDetail: null,
    });
  });

  it("keeps the cut summary and offers the whole command when the description only shares its prefix", () => {
    const shared = `echo ${"a".repeat(90)}`;
    const command = `${shared}; rm -rf ~`;
    const summary = truncatedSummary(command);
    expect(summary.endsWith("…")).toBe(true);
    expect(
      approvalCardText(
        "run_command",
        summary,
        `${shared} # tidy`,
        commandDetail(command),
      ),
    ).toEqual({
      inputSummary: summary,
      headline: `${shared} # tidy`,
      inputDetail: commandDetail(command),
    });
  });

  it("offers the whole command beside a cut summary and a prose description", () => {
    const command = `cd /Users/someone/${"w".repeat(90)} && ls`;
    const summary = truncatedSummary(command);
    expect(summary.endsWith("…")).toBe(true);
    expect(
      approvalCardText(
        "Bash",
        summary,
        "List the worktree",
        commandDetail(command),
      ),
    ).toEqual({
      inputSummary: summary,
      headline: "List the worktree",
      inputDetail: commandDetail(command),
    });
  });

  it("drops the cut summary for a description that is the whole command collapsed, and still offers the command as written", () => {
    const command = `echo ${"b".repeat(100)}\n  && ls`;
    const summary = truncatedSummary(command);
    expect(
      approvalCardText(
        "run_command",
        summary,
        command.replace(/\s+/g, " "),
        commandDetail(command),
      ),
    ).toEqual({
      inputSummary: null,
      headline: command.replace(/\s+/g, " "),
      inputDetail: commandDetail(command),
    });
  });

  it("offers a short multi-line command whose summary put it on one line", () => {
    const command = "rm -rf build\ntouch done";
    const summary = truncatedSummary(command);
    expect(summary).toBe("rm -rf build touch done");
    expect(
      approvalCardText(
        "run_command",
        summary,
        "Clean the build",
        commandDetail(command),
      ),
    ).toEqual({
      inputSummary: summary,
      headline: "Clean the build",
      inputDetail: commandDetail(command),
    });
  });

  it("drops the cut summary when the description equals a lone field's value", () => {
    const value = `https://example.com/${"c".repeat(100)}`;
    const summary = `${value.slice(0, 79)}…`;
    expect(
      approvalCardText("fetch", summary, value, fieldsDetail([value])),
    ).toEqual({ inputSummary: null, headline: value, inputDetail: null });
  });

  it("keeps the summary for a multi-field detail, which has no single whole text", () => {
    const value = `https://example.com/${"d".repeat(100)}`;
    const summary = `${value.slice(0, 79)}…`;
    expect(
      approvalCardText("fetch", summary, value, fieldsDetail([value, "x"])),
    ).toEqual({
      inputSummary: summary,
      headline: value,
      inputDetail: fieldsDetail([value, "x"]),
    });
  });

  it("keeps the summary when there is no input detail", () => {
    const summary = `${LONG_COMMAND.slice(0, 79)}…`;
    expect(
      approvalCardText("run_command", summary, LONG_COMMAND, null),
    ).toEqual({
      inputSummary: summary,
      headline: LONG_COMMAND,
      inputDetail: null,
    });
  });
});

describe("resolvedApprovalBodyText", () => {
  it("has no request for a null or blank description", () => {
    expect(
      resolvedApprovalBodyText("bash", "ls", null, null).request,
    ).toBeNull();
    expect(
      resolvedApprovalBodyText("bash", "ls", "  ", null).request,
    ).toBeNull();
  });

  it("has no request when the description repeats the label", () => {
    expect(
      resolvedApprovalBodyText("bash", "ls", " bash ", null).request,
    ).toBeNull();
  });

  it("has no request when the description repeats the summary, whitespace-insensitively", () => {
    expect(
      resolvedApprovalBodyText("bash", "echo a b", "echo a\n b", null).request,
    ).toBeNull();
  });

  it("has no request when it repeats the command panel's command", () => {
    const detail = commandDetail("ls -la /very/long\npath");
    const body = resolvedApprovalBodyText(
      "bash",
      "ls -la…",
      "ls -la /very/long path",
      detail,
    );
    expect(body.request).toBeNull();
    expect(body.inputDetail).toEqual(detail);
  });

  it("has no request when it repeats a lone entry's value", () => {
    const detail = fieldsDetail(["https://example.com"]);
    expect(
      resolvedApprovalBodyText(
        "fetch",
        "example…",
        "https://example.com",
        detail,
      ).request,
    ).toBeNull();
  });

  it("keeps the request when the command differs from the description", () => {
    const detail = commandDetail("git status --porcelain");
    const body = resolvedApprovalBodyText(
      "bash",
      "git status…",
      "Show status",
      detail,
    );
    expect(body.request).toBe("Show status");
    expect(body.inputDetail).toEqual(detail);
  });

  it("has no single text for a 2-entry panel, so the request is kept", () => {
    const detail = fieldsDetail(["one", "two"]);
    const body = resolvedApprovalBodyText("tool", "sum", "one", detail);
    expect(body.request).toBe("one");
    expect(body.inputDetail).toEqual(detail);
  });

  it("keeps a distinct description verbatim", () => {
    expect(
      resolvedApprovalBodyText("bash", "ls", "List  files", null).request,
    ).toBe("List  files");
  });

  it("drops the input panel when the header summary already shows it", () => {
    expect(
      resolvedApprovalBodyText(
        "bash",
        "echo hi",
        "echo hi",
        commandDetail("echo hi"),
      ),
    ).toEqual({ request: null, inputDetail: null });
  });
});
