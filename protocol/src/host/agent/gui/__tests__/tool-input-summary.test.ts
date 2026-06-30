import { describe, expect, it } from "vitest";
import { deriveToolInputSummary } from "../tool-input-summary";

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
});
