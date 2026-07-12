import type {
  CommentsListThreadsResponse,
  CommentsSetThreadStatusResponse,
} from "@traycer/protocol/host/comments";
import { describe, expect, it } from "vitest";
import {
  formatCommentsListThreadsXml,
  formatCommentsSetThreadStatusResponse,
} from "../comments-xml-formatting";

function textContent(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

describe("comments XML formatting", () => {
  it("formats structured list responses as escaped traycer comments XML", () => {
    const response: CommentsListThreadsResponse = {
      artifacts: [
        {
          artifactPath: "/tmp/spec-a/index.md",
          kind: "spec",
          title: "Spec & A",
          warning: null,
          threads: [
            {
              thread: {
                threadId: "thread-&",
                resolved: false,
                createdAt: Date.parse("2026-06-17T10:15:00.000Z"),
                data: {
                  createdByUserId: "user-1",
                  createdByHandle: "alice",
                  quotedText: "quote & <tag>",
                },
                comments: [
                  {
                    commentId: "comment-1",
                    content: textContent("body & <tag>"),
                    createdAt: Date.parse("2026-06-17T10:16:00.000Z"),
                    updatedAt: null,
                    author: { userId: "user-1", fallbackHandle: "alice" },
                  },
                ],
              },
              anchorStatus: "present",
              anchorOrder: 4,
              anchorWarning: null,
            },
            {
              thread: {
                threadId: "thread-resolved",
                resolved: true,
                createdAt: Date.parse("2026-06-17T10:20:00.000Z"),
                data: {
                  createdByUserId: "user-2",
                  createdByHandle: null,
                  quotedText: "old wording",
                },
                comments: [
                  {
                    commentId: "comment-2",
                    content: textContent("fixed"),
                    createdAt: Date.parse("2026-06-17T10:21:00.000Z"),
                    updatedAt: Date.parse("2026-06-17T10:22:00.000Z"),
                    author: { userId: "user-2", fallbackHandle: null },
                  },
                ],
              },
              anchorStatus: "unavailable",
              anchorOrder: null,
              anchorWarning: "failed to parse anchor position",
            },
          ],
        },
      ],
    };

    const xml = formatCommentsListThreadsXml({
      response,
      platform: "POSIX",
      query: {
        artifactPaths: null,
        status: "all",
      },
    });

    expect(xml).toBe(`<traycer_comments>

<artifact path="/tmp/spec-a/index.md" kind="spec" title="Spec &amp; A">

<thread id="thread-&amp;" author="alice" created_at="2026-06-17T10:15:00.000Z" status="open">
<quoted_section anchor="present">quote &amp; &lt;tag&gt;</quoted_section>
<comment id="comment-1" n="1" author="alice" created_at="2026-06-17T10:16:00.000Z">
body &amp; &lt;tag&gt;
</comment>
</thread>

<thread id="thread-resolved" user_id="user-2" created_at="2026-06-17T10:20:00.000Z" status="resolved">
<quoted_section anchor="unavailable" reason="failed to parse anchor position">old wording</quoted_section>
<comment id="comment-2" n="1" user_id="user-2" created_at="2026-06-17T10:21:00.000Z" edited_at="2026-06-17T10:22:00.000Z">
fixed
</comment>
</thread>

</artifact>

</traycer_comments>
`);
    expect(xml).not.toContain("generated");
    expect(xml).not.toContain("do not edit");
    expect(xml).not.toContain("total_threads");
  });

  it("formats zero matching list responses as plain text", () => {
    expect(
      formatCommentsListThreadsXml({
        response: { artifacts: [] },
        platform: "POSIX",
        query: {
          artifactPaths: null,
          status: "all",
        },
      }),
    ).toBe("No comments found in the epic.");

    expect(
      formatCommentsListThreadsXml({
        response: {
          artifacts: [
            {
              artifactPath: "/tmp/spec-a/index.md",
              kind: "spec",
              title: "Spec A",
              warning: null,
              threads: [],
            },
          ],
        },
        platform: "POSIX",
        query: {
          artifactPaths: ["/tmp/spec-a/index.md"],
          status: "open",
        },
      }),
    ).toBe("No open comments found in the selected artifacts.");
  });

  it("formats artifact warnings even when no matching threads exist", () => {
    expect(
      formatCommentsListThreadsXml({
        response: {
          artifacts: [
            {
              artifactPath: "/tmp/spec-a/index.md",
              kind: "spec",
              title: "Spec A",
              warning: "artifact comments are not available",
              threads: [],
            },
          ],
        },
        platform: "POSIX",
        query: {
          artifactPaths: ["/tmp/spec-a/index.md"],
          status: "all",
        },
      }),
    ).toBe(`<traycer_comments>

<artifact path="/tmp/spec-a/index.md" kind="spec" title="Spec A">
<warning>artifact comments are not available</warning>

</artifact>

</traycer_comments>
`);
  });

  it("formats set-status responses", () => {
    const response: CommentsSetThreadStatusResponse = {
      updated: [
        {
          artifactPath: "/tmp/spec-a/index.md",
          threadId: "thread-open",
          status: "resolved",
        },
      ],
      failed: [
        {
          artifactPath: "/tmp/spec-a/index.md",
          threadId: "thread-missing",
          reason: "thread not found",
        },
      ],
    };

    expect(formatCommentsSetThreadStatusResponse(response)).toBe(
      [
        "Updated status for 1 threads.",
        "",
        "Failed to update status for 1 threads:",
        "- /tmp/spec-a/index.md thread-missing: thread not found",
      ].join("\n"),
    );
  });
});
