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
    expect(approvalCardText("bash", "git status", "   ")).toEqual({
      inputSummary: "git status",
      headline: null,
    });
  });

  it("drops the headline when the description is the tool name", () => {
    expect(approvalCardText("bash", "git status", " bash ")).toEqual({
      inputSummary: "git status",
      headline: null,
    });
  });

  it("uses the description verbatim when there is no summary", () => {
    expect(approvalCardText("bash", null, "Run  a\nthing")).toEqual({
      inputSummary: null,
      headline: "Run  a\nthing",
    });
  });

  it("drops the headline when the description equals the summary", () => {
    expect(approvalCardText("run_command", "echo hi", "echo hi")).toEqual({
      inputSummary: "echo hi",
      headline: null,
    });
  });

  it("compares a multi-line description to its one-line summary", () => {
    expect(
      approvalCardText(
        "run_command",
        "echo a && echo b",
        "echo a &&\n  echo b",
      ),
    ).toEqual({ inputSummary: "echo a && echo b", headline: null });
  });

  it("shows a long command once, in full, when the summary is its truncation", () => {
    const summary = truncatedSummary(LONG_COMMAND);
    expect(summary.endsWith("…")).toBe(true);
    expect(approvalCardText("run_command", summary, LONG_COMMAND)).toEqual({
      inputSummary: null,
      headline: LONG_COMMAND,
    });
  });

  it("keeps both when an ellipsis summary's prefix does not match", () => {
    expect(approvalCardText("bash", "something else…", "git status")).toEqual({
      inputSummary: "something else…",
      headline: "git status",
    });
  });

  it("does not treat a bare ellipsis as a truncation", () => {
    expect(approvalCardText("bash", "…", "git status")).toEqual({
      inputSummary: "…",
      headline: "git status",
    });
  });

  it("keeps both when the description says something else", () => {
    expect(
      approvalCardText("Bash", "git status", "Show working tree status"),
    ).toEqual({
      inputSummary: "git status",
      headline: "Show working tree status",
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
