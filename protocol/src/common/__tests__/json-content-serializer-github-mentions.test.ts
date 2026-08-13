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
  // hands the agent an empty fallback rather than no fallback. github.com
  // stays bare here too - it is the default every unqualified reference
  // already means, so qualifying it would churn every serialization that was
  // already fine.
  it.each([
    [ContextType.GithubPullRequest, "github-pr", 42],
    [ContextType.GithubIssue, "github-issue", 7],
  ] as const)(
    "omits both the url and the host suffix for a %s node on github.com with no url",
    (contextType, marker, number) => {
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${number}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "github.com",
          },
          "llm",
        ),
      ).toBe(`See @${marker}:acme/widgets#${number} before merging.`);
    },
  );

  // Without a url, the host is the only thing that can disambiguate an
  // enterprise reference from the same coordinates on github.com: the node
  // keeps `githubHost` even when no `url` was ever set, and dropping the
  // suffix here would make an `acme/widgets#42` on ghe.example.com
  // indistinguishable from the same coordinates on github.com.
  it.each([
    [ContextType.GithubPullRequest, "github-pr", 42],
    [ContextType.GithubIssue, "github-issue", 7],
  ] as const)(
    "appends the host suffix for a %s node on an enterprise host with no url",
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
      ).toBe(
        `See @${marker}:acme/widgets#${number} [host=github.example.test] before merging.`,
      );
    },
  );

  // A url already disambiguates the reference on its own, so an enterprise
  // host must not ALSO append its own suffix - that would double-qualify a
  // reference the url alone already resolves unambiguously.
  it.each([
    [ContextType.GithubPullRequest, "github-pr", "pull/42"],
    [ContextType.GithubIssue, "github-issue", "issues/7"],
  ] as const)(
    "prefers the url suffix and omits the host suffix for a %s node on an enterprise host with a url",
    (contextType, marker, path) => {
      const number = contextType === ContextType.GithubPullRequest ? 42 : 7;
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${number}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "github.example.test",
            url: `https://github.example.test/acme/widgets/${path}`,
          },
          "llm",
        ),
      ).toBe(
        `See @${marker}:acme/widgets#${number} [url=https://github.example.test/acme/widgets/${path}] before merging.`,
      );
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

  // Without a url, the host is the only thing that can disambiguate an
  // enterprise reference from the same coordinates on github.com - the same
  // rule the LLM form above follows. The display/user form is what a human
  // reads in the chip and the sent message, so it must not read an
  // enterprise reference as if it were the github.com repository it shares
  // coordinates with.
  it.each([
    [ContextType.GithubPullRequest, 42],
    [ContextType.GithubIssue, 7],
  ] as const)(
    "prefixes the enterprise host in the compact repository reference for display (%s)",
    (contextType, number) => {
      expect(
        serialize(
          {
            contextType,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "github.example.test",
            url: `https://github.example.test/acme/widgets/${contextType === ContextType.GithubPullRequest ? "pull" : "issues"}/${number}`,
          },
          "user",
        ),
      ).toBe(
        `See \`github.example.test/acme/widgets#${number}\` before merging.`,
      );
    },
  );

  // The control: an explicit github.com host must keep the compact reference
  // byte-identical to what it has always been - qualifying the default host
  // would churn every display serialization that was already fine.
  it.each([
    [ContextType.GithubPullRequest, 42],
    [ContextType.GithubIssue, 7],
  ] as const)(
    "keeps the compact reference bare on github.com for display (%s)",
    (contextType, number) => {
      expect(
        serialize(
          {
            contextType,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "github.com",
            url: `https://github.com/acme/widgets/${contextType === ContextType.GithubPullRequest ? "pull" : "issues"}/${number}`,
          },
          "user",
        ),
      ).toBe(`See \`acme/widgets#${number}\` before merging.`);
    },
  );

  // The default-host check goes through `isDefaultGithubMentionHost`, which
  // FOLDS the compare: a node saved with `GitHub.com` (or any other casing)
  // is the default host exactly like `github.com`, and must omit the
  // `[host=]` suffix just as the lowercase spelling does.
  it.each([
    [ContextType.GithubPullRequest, "github-pr", 42],
    [ContextType.GithubIssue, "github-issue", 7],
  ] as const)(
    "omits the host suffix for a %s node on a differently-cased default host with no url",
    (contextType, marker, number) => {
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${number}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "GitHub.com",
          },
          "llm",
        ),
      ).toBe(`See @${marker}:acme/widgets#${number} before merging.`);
    },
  );

  // The display-form sibling of the case above: the same folded compare must
  // omit the prefix, not just the LLM form's suffix.
  it.each([
    [ContextType.GithubPullRequest, 42],
    [ContextType.GithubIssue, 7],
  ] as const)(
    "keeps the compact reference bare for a differently-cased default host in display form (%s)",
    (contextType, number) => {
      expect(
        serialize(
          {
            contextType,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "GitHub.com",
            url: `https://github.com/acme/widgets/${contextType === ContextType.GithubPullRequest ? "pull" : "issues"}/${number}`,
          },
          "user",
        ),
      ).toBe(`See \`acme/widgets#${number}\` before merging.`);
    },
  );

  // The control: a non-default host must still qualify both forms, whatever
  // its own casing, so the fold above cannot be a blanket "never qualify".
  it.each([
    [ContextType.GithubPullRequest, "github-pr", 42],
    [ContextType.GithubIssue, "github-issue", 7],
  ] as const)(
    "still appends the host suffix for a %s node on an enterprise host, verbatim casing and all",
    (contextType, marker, number) => {
      expect(
        serialize(
          {
            contextType,
            id: `${marker}:acme/widgets#${number}`,
            organizationLogin: "acme",
            repositoryName: "widgets",
            issueNumber: number,
            githubHost: "GHE.Corp",
          },
          "llm",
        ),
      ).toBe(
        `See @${marker}:acme/widgets#${number} [host=GHE.Corp] before merging.`,
      );
    },
  );

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
