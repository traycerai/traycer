import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import {
  ContextType,
  jsonContentToMarkdown,
} from "../json-content-serializer";

function mentionDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          { type: "mention", attrs },
          { type: "text", text: " before merging." },
        ],
      },
    ],
  };
}

function serialize(
  attrs: Record<string, unknown>,
  mentionFormat: "user" | "llm",
): string {
  return jsonContentToMarkdown(mentionDoc(attrs), {
    mentionFormat,
    platform: "POSIX",
  });
}

describe("GitHub mention serialization", () => {
  // `url` is still optional on the node, so nodes written before it existed -
  // and any caller that omits it - must serialize to the SAME complete
  // reference they always did. Emitting `[url=]` is malformed metadata that
  // hands the agent an empty fallback rather than no fallback.
  it.each([
    [ContextType.GithubPullRequest, "github-pr", 42],
    [ContextType.GithubIssue, "github-issue", 7],
  ] as const)(
    "omits the url metadata entirely for a %s node that carries no url",
    (contextType, marker, number) => {
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${number}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "github.example.test",
          },
          "llm",
        ),
      ).toBe(`See @${marker}:acme/widgets#${number} before merging.`);
    },
  );

  it.each([
    [ContextType.GithubPullRequest, "github-pr", "pull/42"],
    [ContextType.GithubIssue, "github-issue", "issues/7"],
  ] as const)(
    "serializes %s as an agent reference with its URL for the LLM",
    (contextType, marker, path) => {
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${contextType === ContextType.GithubPullRequest ? 42 : 7}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber:
              contextType === ContextType.GithubPullRequest ? 42 : 7,
            githubHost: "github.example.test",
            url: `https://github.com/acme/widgets/${path}`,
          },
          "llm",
        ),
      ).toBe(
        `See @${marker}:acme/widgets#${contextType === ContextType.GithubPullRequest ? 42 : 7} [url=https://github.com/acme/widgets/${path}] before merging.`,
      );
    },
  );

  it.each([
    [ContextType.GithubPullRequest, 42],
    [ContextType.GithubIssue, 7],
  ] as const)("uses the compact repository reference for display (%s)", (contextType, number) => {
    expect(
      serialize(
        {
          contextType,
          organizationLogin: "acme",
          repositoryName: "widgets",
          issueNumber: number,
          url: `https://github.com/acme/widgets/${contextType === ContextType.GithubPullRequest ? "pull" : "issues"}/${number}`,
        },
        "user",
      ),
    ).toBe(`See \`acme/widgets#${number}\` before merging.`);
  });

  it("does not apply file-style validation markers to either GitHub context", () => {
    const validationResults = new Map([
      ["pr:42", { exists: false }],
      ["issue:7", { exists: false, isDeleted: true }],
    ]);

    for (const [contextType, id, number, kind] of [
      [ContextType.GithubPullRequest, "pr:42", 42, "pull"],
      [ContextType.GithubIssue, "issue:7", 7, "issues"],
    ] as const) {
      const attrs = {
        contextType,
        id,
        organizationLogin: "acme",
        repositoryName: "widgets",
        issueNumber: number,
        url: `https://github.com/acme/widgets/${kind}/${number}`,
      };
      // Both markers, in both formats. Asserting only the one the entry cannot
      // produce is the vacuous half of this check: `pr:42` maps to
      // `{ exists: false }`, which only ever emits NOT FOUND, so testing it for
      // DELETED proves nothing about the branch that renders it.
      for (const mentionFormat of ["llm", "user"] as const) {
        const markdown = jsonContentToMarkdown(mentionDoc(attrs), {
          mentionFormat,
          platform: "POSIX",
          validationResults,
        });
        expect(markdown).not.toContain("NOT FOUND");
        expect(markdown).not.toContain("DELETED");
      }
    }
  });
});
