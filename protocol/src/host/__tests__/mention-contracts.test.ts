import { describe, expect, it } from "vitest";

import {
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  mentionGithubCatalogV10,
  mentionGithubSearchV10,
} from "@traycer/protocol/host/mention-contracts";
import {
  githubIssueMentionFilterSchema,
  githubIssueMentionRowSchema,
  githubPullRequestMentionFilterSchema,
  githubPullRequestMentionRowSchema,
  mentionGithubCatalogRequestSchema,
  mentionGithubCatalogResponseSchema,
  mentionGithubSearchRequestSchema,
  mentionGithubSearchResponseSchema,
} from "@traycer/protocol/host/mention-schemas";

const REPOSITORY = {
  githubHost: "github.com",
  owner: "acme",
  repo: "widgets",
};

const ACTOR = {
  login: "octocat",
  avatarUrl: null,
};

const CHECKS_ROLLUP = {
  success: 3,
  failure: 0,
  pending: 1,
  total: 4,
};

const PULL_REQUEST = {
  ...REPOSITORY,
  kind: "pull-request" as const,
  number: 42,
  title: "Improve widgets",
  url: "https://github.com/acme/widgets/pull/42",
  author: ACTOR,
  updatedAt: 1_700_000_000_000,
  buckets: ["review-requested" as const],
  state: "open" as const,
  isDraft: false,
  baseRefName: "main",
  headRefName: "improve-widgets",
  reviewDecision: "review_required" as const,
  checksRollup: CHECKS_ROLLUP,
};

const PULL_REQUEST_WITH_NULL_PREVIEW_FIELDS = {
  ...PULL_REQUEST,
  baseRefName: null,
  headRefName: null,
  reviewDecision: null,
  checksRollup: null,
};

const ISSUE = {
  ...REPOSITORY,
  kind: "issue" as const,
  number: 7,
  title: "Widget bug",
  url: "https://github.com/acme/widgets/issues/7",
  author: null,
  updatedAt: 1_700_000_001_000,
  buckets: ["assigned" as const, "mentions" as const],
  state: "open" as const,
  stateReason: null,
  labels: ["bug"],
  assignees: [ACTOR],
};

const CATALOG_BASE_REQUEST = {
  epicId: null,
  workspacePaths: ["/workspace/widgets"],
  section: "pull-requests" as const,
};

describe("GitHub mention schemas", () => {
  it("accepts all three catalog refresh intents and rejects booleans", () => {
    for (const refresh of ["none", "auto", "manual"] as const) {
      expect(
        mentionGithubCatalogRequestSchema.safeParse({
          ...CATALOG_BASE_REQUEST,
          refresh,
        }).success,
      ).toBe(true);
    }

    for (const refresh of [true, false]) {
      expect(
        mentionGithubCatalogRequestSchema.safeParse({
          ...CATALOG_BASE_REQUEST,
          refresh,
        }).success,
      ).toBe(false);
    }
  });

  it("derives host identity from the connection instead of carrying hostId", () => {
    const parsed = mentionGithubCatalogRequestSchema.parse({
      ...CATALOG_BASE_REQUEST,
      refresh: "none",
      hostId: "host-1",
    });
    const search = mentionGithubSearchRequestSchema.parse({
      ...CATALOG_BASE_REQUEST,
      query: "widgets",
      filter: {
        state: "open",
        involvement: "everyone",
        repository: null,
      },
      hostId: "host-1",
    });

    expect(parsed).not.toHaveProperty("hostId");
    expect(search).not.toHaveProperty("hostId");
  });

  it("accepts both row variants and the catalog response notice shape", () => {
    expect(githubPullRequestMentionRowSchema.parse(PULL_REQUEST)).toEqual(
      PULL_REQUEST,
    );
    expect(githubIssueMentionRowSchema.parse(ISSUE)).toEqual(ISSUE);
    expect(
      mentionGithubCatalogResponseSchema.parse({
        rows: [PULL_REQUEST, ISSUE],
        repositories: [REPOSITORY],
        freshnessAt: 1_700_000_002_000,
        stale: true,
        sourceStatus: "cached",
        notice: { kind: "rate-limited", retryAt: 1_700_000_003_000 },
      }),
    ).toMatchObject({ rows: [PULL_REQUEST, ISSUE], stale: true });
  });

  it("round-trips populated and null pull-request preview fields", () => {
    expect(
      githubPullRequestMentionRowSchema.parse(PULL_REQUEST),
    ).toEqual(PULL_REQUEST);
    expect(
      githubPullRequestMentionRowSchema.parse(
        PULL_REQUEST_WITH_NULL_PREVIEW_FIELDS,
      ),
    ).toEqual(PULL_REQUEST_WITH_NULL_PREVIEW_FIELDS);
  });

  it("requires the pull-request preview fields and rejects omission", () => {
    const { baseRefName: _baseRefName, ...withoutBaseRefName } = PULL_REQUEST;
    expect(
      githubPullRequestMentionRowSchema.safeParse(withoutBaseRefName).success,
    ).toBe(false);

    const { headRefName: _headRefName, ...withoutHeadRefName } = PULL_REQUEST;
    expect(
      githubPullRequestMentionRowSchema.safeParse(withoutHeadRefName).success,
    ).toBe(false);

    const { reviewDecision: _reviewDecision, ...withoutReviewDecision } =
      PULL_REQUEST;
    expect(
      githubPullRequestMentionRowSchema.safeParse(withoutReviewDecision)
        .success,
    ).toBe(false);

    const { checksRollup: _checksRollup, ...withoutChecksRollup } =
      PULL_REQUEST;
    expect(
      githubPullRequestMentionRowSchema.safeParse(withoutChecksRollup)
        .success,
    ).toBe(false);
  });

  it("rejects review decisions outside the existing underscore vocabulary", () => {
    for (const reviewDecision of [
      "approved",
      "changes_requested",
      "review_required",
    ] as const) {
      expect(
        githubPullRequestMentionRowSchema.safeParse({
          ...PULL_REQUEST,
          reviewDecision,
        }).success,
      ).toBe(true);
    }

    for (const reviewDecision of [
      "APPROVED",
      "changes-requested",
      "pending",
      "",
    ]) {
      expect(
        githubPullRequestMentionRowSchema.safeParse({
          ...PULL_REQUEST,
          reviewDecision,
        }).success,
      ).toBe(false);
    }
  });

  it("requires checks-rollup fields to be nonnegative integers", () => {
    expect(
      githubPullRequestMentionRowSchema.safeParse({
        ...PULL_REQUEST,
        checksRollup: CHECKS_ROLLUP,
      }).success,
    ).toBe(true);

    for (const invalidRollup of [
      { ...CHECKS_ROLLUP, success: -1 },
      { ...CHECKS_ROLLUP, failure: 1.5 },
      { ...CHECKS_ROLLUP, pending: "0" },
      { success: 0, failure: 0, pending: 0 },
    ]) {
      expect(
        githubPullRequestMentionRowSchema.safeParse({
          ...PULL_REQUEST,
          checksRollup: invalidRollup,
        }).success,
      ).toBe(false);
    }
  });

  it("requires catalog responses to carry repositories, including empty for no GitHub scope", () => {
    const BASE_CATALOG_RESPONSE = {
      rows: [],
      freshnessAt: null,
      stale: false,
      sourceStatus: "ok" as const,
      notice: null,
    };

    expect(
      mentionGithubCatalogResponseSchema.parse({
        ...BASE_CATALOG_RESPONSE,
        repositories: [],
      }),
    ).toMatchObject({ repositories: [] });

    expect(
      mentionGithubCatalogResponseSchema.parse({
        ...BASE_CATALOG_RESPONSE,
        repositories: [REPOSITORY],
      }),
    ).toMatchObject({ repositories: [REPOSITORY] });

    expect(
      mentionGithubCatalogResponseSchema.safeParse(BASE_CATALOG_RESPONSE)
        .success,
    ).toBe(false);

    expect(
      mentionGithubCatalogResponseSchema.safeParse({
        ...BASE_CATALOG_RESPONSE,
        repositories: [{ githubHost: "github.com", owner: "acme" }],
      }).success,
    ).toBe(false);

    expect(
      mentionGithubCatalogResponseSchema.safeParse({
        ...BASE_CATALOG_RESPONSE,
        repositories: "not-an-array",
      }).success,
    ).toBe(false);
  });

  it("keeps the search response unchanged and without repositories", () => {
    const parsed = mentionGithubSearchResponseSchema.parse({
      rows: [PULL_REQUEST, ISSUE],
      sourceStatus: "ok",
      notice: null,
    });
    expect(parsed).toEqual({
      rows: [PULL_REQUEST, ISSUE],
      sourceStatus: "ok",
      notice: null,
    });
    expect(parsed).not.toHaveProperty("repositories");

    expect(
      mentionGithubSearchResponseSchema.safeParse({
        rows: [PULL_REQUEST, ISSUE],
        repositories: [REPOSITORY],
        sourceStatus: "ok",
        notice: null,
      }).success,
    ).toBe(true);
  });

  it("accepts section-specific search filters and rejects cross-section values", () => {
    expect(
      githubPullRequestMentionFilterSchema.parse({
        state: "merged",
        involvement: "review-requested",
        repository: REPOSITORY,
      }),
    ).toEqual({
      state: "merged",
      involvement: "review-requested",
      repository: REPOSITORY,
    });
    expect(
      githubIssueMentionFilterSchema.parse({
        state: "closed",
        involvement: "mentions",
        repository: null,
      }),
    ).toEqual({ state: "closed", involvement: "mentions", repository: null });

    expect(
      mentionGithubSearchRequestSchema.safeParse({
        ...CATALOG_BASE_REQUEST,
        section: "issues",
        query: "",
        filter: {
          state: "merged",
          involvement: "mentions",
          repository: null,
        },
      }).success,
    ).toBe(false);
    expect(
      mentionGithubSearchRequestSchema.safeParse({
        ...CATALOG_BASE_REQUEST,
        query: "",
        filter: {
          state: "closed",
          involvement: "mentions",
          repository: null,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a search response carrying a non-null notice", () => {
    // The null case is already covered above; a search that came back
    // rate-limited is the one this schema has to carry, because the section
    // chrome renders the notice rather than the rows in that state.
    const notice = { kind: "rate-limited", retryAt: 1_700_000_003_000 };
    expect(
      mentionGithubSearchResponseSchema.parse({
        rows: [PULL_REQUEST, ISSUE],
        sourceStatus: "cached",
        notice,
      }),
    ).toEqual({ rows: [PULL_REQUEST, ISSUE], sourceStatus: "cached", notice });
  });
});

describe("GitHub mention RPC contracts", () => {
  it("registers both canonical v1.0 contracts with the exact schema instances", () => {
    const catalog = hostRpcRegistry["mention.githubCatalog"];
    const search = hostRpcRegistry["mention.githubSearch"];
    const catalogContract = catalog[1].versions[0].contract;
    const searchContract = search[1].versions[0].contract;

    expect(catalogContract).toBe(mentionGithubCatalogV10);
    expect(searchContract).toBe(mentionGithubSearchV10);
    expect(catalogContract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(searchContract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(catalogContract.method).toBe("mention.githubCatalog");
    expect(searchContract.method).toBe("mention.githubSearch");
  });

  it("keeps both additive methods optional and unsupported on older hosts", () => {
    for (const method of [
      "mention.githubCatalog",
      "mention.githubSearch",
    ] as const) {
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }

    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.manifest["mention.githubCatalog"]).toBeUndefined();
    expect(split.manifest["mention.githubSearch"]).toBeUndefined();
    expect(split.optionalManifest["mention.githubCatalog"]).toEqual({
      major: 1,
      minor: 0,
    });
    expect(split.optionalManifest["mention.githubSearch"]).toEqual({
      major: 1,
      minor: 0,
    });
  });
});
