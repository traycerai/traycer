/**
 * Round-trip parse tests for the `pr.*` host stream surface schemas.
 * Each top-level schema is parsed twice to ensure idempotency and stability.
 */
import { describe, it, expect } from "vitest";
import {
  prSubscribeListForEpicOpenRequestSchema,
  prLightItemSchema,
  prSubscribeListForEpicServerFrameSchema,
  prSubscribeDetailOpenRequestSchema,
  prCheckContextSchema,
  prChecksSectionSchema,
  prActivityItemSchema,
  prActivitySectionSchema,
  prCommitsSectionSchema,
  prDetailCoreSchema,
  prFilesSectionSchema,
  prSubscribeDetailServerFrameSchema,
  prSubscribeClientFrameSchema,
  prStateSchema,
  prLivenessSchema,
  prReviewDecisionSchema,
  prSourceStatusSchema,
  prCheckStatusSchema,
  prCheckConclusionSchema,
  prReviewStateSchema,
} from "@traycer/protocol/host/pr-schemas";
import {
  prSubscribeListForEpicV10,
  prSubscribeDetailV10,
} from "@traycer/protocol/host/pr-contracts";

const BASE_COORDINATES_FIXTURE = {
  owner: "traycerai",
  repo: "traycer-internal",
  prNumber: 4465,
};

const REPO_IDENTIFIER_FIXTURE = {
  owner: "traycerai",
  repo: "traycer-internal",
};

const OWNER_REF_FIXTURE = {
  ownerId: "chat-1",
  ownerKind: "chat" as const,
};

const CHECKS_ROLLUP_FIXTURE = {
  success: 5,
  failure: 1,
  pending: 2,
  total: 8,
};

const ACTOR_FIXTURE = {
  login: "octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
};

const REVIEW_REQUEST_FIXTURE = {
  login: "reviewer-1",
  avatarUrl: null,
  kind: "user" as const,
};

const LIGHT_ITEM_POPULATED_FIXTURE = {
  githubHost: "github.com",
  base: BASE_COORDINATES_FIXTURE,
  prUrl: "https://github.com/traycerai/traycer-internal/pull/4465",
  state: "open" as const,
  liveness: "live" as const,
  observedAt: 1_700_000_000_000,
  isDraft: false,
  title: "feat(host): add notification hooks",
  baseRefName: "development",
  headRefName: "feature/notification-hooks",
  additions: 120,
  deletions: 30,
  checksRollup: CHECKS_ROLLUP_FIXTURE,
  reviewDecision: "approved" as const,
  commentCount: 4,
  updatedAt: 1_700_000_100_000,
  repoIdentifier: REPO_IDENTIFIER_FIXTURE,
  owners: [OWNER_REF_FIXTURE],
};

const LIGHT_ITEM_NULL_ENRICHMENT_FIXTURE = {
  githubHost: null,
  base: null,
  prUrl: null,
  state: "open" as const,
  liveness: "cache-only" as const,
  observedAt: null,
  isDraft: null,
  title: null,
  baseRefName: null,
  headRefName: null,
  additions: null,
  deletions: null,
  checksRollup: null,
  reviewDecision: null,
  commentCount: null,
  updatedAt: null,
  repoIdentifier: REPO_IDENTIFIER_FIXTURE,
  owners: [],
};

describe("prSubscribeListForEpicOpenRequestSchema", () => {
  it("parses and reparses the foreground mode unchanged", () => {
    const fixture = { epicId: "epic-1", mode: "foreground" as const };
    const parsed1 = prSubscribeListForEpicOpenRequestSchema.parse(fixture);
    const parsed2 = prSubscribeListForEpicOpenRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses and reparses the background mode unchanged", () => {
    const fixture = { epicId: "epic-1", mode: "background" as const };
    const parsed1 = prSubscribeListForEpicOpenRequestSchema.parse(fixture);
    const parsed2 = prSubscribeListForEpicOpenRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prLightItemSchema", () => {
  it("parses and reparses a fully populated item with a non-null base unchanged", () => {
    const parsed1 = prLightItemSchema.parse(LIGHT_ITEM_POPULATED_FIXTURE);
    const parsed2 = prLightItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses and reparses an item with a null base unchanged", () => {
    const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, base: null };
    const parsed1 = prLightItemSchema.parse(fixture);
    const parsed2 = prLightItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.base).toBeNull();
  });

  it("parses and reparses every state value unchanged", () => {
    prStateSchema.options.forEach((state) => {
      const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, state };
      const parsed1 = prLightItemSchema.parse(fixture);
      const parsed2 = prLightItemSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.state).toBe(state);
    });
  });

  it("parses and reparses every liveness value unchanged", () => {
    prLivenessSchema.options.forEach((liveness) => {
      const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, liveness };
      const parsed1 = prLightItemSchema.parse(fixture);
      const parsed2 = prLightItemSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.liveness).toBe(liveness);
    });
  });

  it("parses and reparses every reviewDecision value unchanged", () => {
    prReviewDecisionSchema.options.forEach((reviewDecision) => {
      const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, reviewDecision };
      const parsed1 = prLightItemSchema.parse(fixture);
      const parsed2 = prLightItemSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.reviewDecision).toBe(reviewDecision);
    });
  });

  it("parses and reparses the cache-only/never-swept case with every nullable enrichment field null", () => {
    const parsed1 = prLightItemSchema.parse(LIGHT_ITEM_NULL_ENRICHMENT_FIXTURE);
    const parsed2 = prLightItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1).toMatchObject({
      githubHost: null,
      base: null,
      prUrl: null,
      observedAt: null,
      isDraft: null,
      title: null,
      baseRefName: null,
      headRefName: null,
      additions: null,
      deletions: null,
      checksRollup: null,
      reviewDecision: null,
      commentCount: null,
      updatedAt: null,
    });
  });
});

describe("prSubscribeListForEpicServerFrameSchema", () => {
  prSourceStatusSchema.options.forEach((sourceStatus) => {
    it(`parses and reparses a snapshot frame with sourceStatus "${sourceStatus}" unchanged`, () => {
      const fixture = {
        kind: "snapshot" as const,
        hasBinaryPayload: false as const,
        sourceStatus,
        items: [LIGHT_ITEM_POPULATED_FIXTURE],
      };
      const parsed1 = prSubscribeListForEpicServerFrameSchema.parse(fixture);
      const parsed2 = prSubscribeListForEpicServerFrameSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
    });

    it(`parses and reparses an updated frame with sourceStatus "${sourceStatus}" unchanged`, () => {
      const fixture = {
        kind: "updated" as const,
        hasBinaryPayload: false as const,
        sourceStatus,
        items: [LIGHT_ITEM_NULL_ENRICHMENT_FIXTURE],
      };
      const parsed1 = prSubscribeListForEpicServerFrameSchema.parse(fixture);
      const parsed2 = prSubscribeListForEpicServerFrameSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
    });
  });

  it("parses and reparses an error frame unchanged", () => {
    const fixture = {
      kind: "error" as const,
      hasBinaryPayload: false as const,
      message: "gh sweep failed",
      isFatal: false,
    };
    const parsed1 = prSubscribeListForEpicServerFrameSchema.parse(fixture);
    const parsed2 = prSubscribeListForEpicServerFrameSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prSubscribeDetailOpenRequestSchema", () => {
  it("parses and reparses a valid fixture unchanged", () => {
    const fixture = {
      epicId: "epic-1",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer-internal",
      prNumber: 4465,
    };
    const parsed1 = prSubscribeDetailOpenRequestSchema.parse(fixture);
    const parsed2 = prSubscribeDetailOpenRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prCheckContextSchema", () => {
  it("parses and reparses every status value unchanged", () => {
    prCheckStatusSchema.options.forEach((status) => {
      const fixture = {
        name: "ci/build",
        status,
        conclusion: null,
        detailsUrl: "https://github.com/traycerai/traycer-internal/actions",
      };
      const parsed1 = prCheckContextSchema.parse(fixture);
      const parsed2 = prCheckContextSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.status).toBe(status);
    });
  });

  it("parses and reparses every conclusion value unchanged", () => {
    prCheckConclusionSchema.options.forEach((conclusion) => {
      const fixture = {
        name: "ci/build",
        status: "completed" as const,
        conclusion,
        detailsUrl: null,
      };
      const parsed1 = prCheckContextSchema.parse(fixture);
      const parsed2 = prCheckContextSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.conclusion).toBe(conclusion);
    });
  });

  it("parses and reparses a null conclusion (in-progress check) unchanged", () => {
    const fixture = {
      name: "ci/build",
      status: "in_progress" as const,
      conclusion: null,
      detailsUrl: null,
    };
    const parsed1 = prCheckContextSchema.parse(fixture);
    const parsed2 = prCheckContextSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.conclusion).toBeNull();
  });
});

describe("prChecksSectionSchema", () => {
  it("parses and reparses isTruncated: true unchanged", () => {
    const fixture = {
      observedAt: 1_700_000_000_000,
      contexts: [
        {
          name: "ci/build",
          status: "completed" as const,
          conclusion: "success" as const,
          detailsUrl: null,
        },
      ],
      isTruncated: true,
    };
    const parsed1 = prChecksSectionSchema.parse(fixture);
    const parsed2 = prChecksSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.isTruncated).toBe(true);
  });

  it("parses and reparses isTruncated: false with a null observedAt (never swept) unchanged", () => {
    const fixture = {
      observedAt: null,
      contexts: [],
      isTruncated: false,
    };
    const parsed1 = prChecksSectionSchema.parse(fixture);
    const parsed2 = prChecksSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.isTruncated).toBe(false);
    expect(parsed1.observedAt).toBeNull();
  });
});

describe("prActivityItemSchema", () => {
  it("parses and reparses a comment item unchanged", () => {
    const fixture = {
      kind: "comment" as const,
      id: "comment-1",
      author: ACTOR_FIXTURE,
      body: "Looks good to me.",
      createdAt: 1_700_000_000_000,
    };
    const parsed1 = prActivityItemSchema.parse(fixture);
    const parsed2 = prActivityItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses and reparses a comment item with a null author (deleted GitHub user) unchanged", () => {
    const fixture = {
      kind: "comment" as const,
      id: "comment-2",
      author: null,
      body: "This account no longer exists.",
      createdAt: 1_700_000_000_000,
    };
    const parsed1 = prActivityItemSchema.parse(fixture);
    const parsed2 = prActivityItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.author).toBeNull();
  });

  it("parses and reparses every review state on a review item unchanged", () => {
    prReviewStateSchema.options.forEach((state) => {
      const fixture = {
        kind: "review" as const,
        id: "review-1",
        author: ACTOR_FIXTURE,
        body: "Reviewed.",
        state,
        createdAt: 1_700_000_000_000,
      };
      const parsed1 = prActivityItemSchema.parse(fixture);
      const parsed2 = prActivityItemSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      if (parsed1.kind !== "review") throw new Error("expected review");
      expect(parsed1.state).toBe(state);
    });
  });

  it("parses and reparses a review item with a null author (deleted GitHub user) unchanged", () => {
    const fixture = {
      kind: "review" as const,
      id: "review-2",
      author: null,
      body: "Reviewed.",
      state: "approved" as const,
      createdAt: 1_700_000_000_000,
    };
    const parsed1 = prActivityItemSchema.parse(fixture);
    const parsed2 = prActivityItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.author).toBeNull();
  });
});

describe("prActivitySectionSchema", () => {
  it("parses and reparses a section with mixed comment/review items unchanged", () => {
    const fixture = {
      observedAt: 1_700_000_000_000,
      items: [
        {
          kind: "comment" as const,
          id: "comment-1",
          author: ACTOR_FIXTURE,
          body: "Looks good to me.",
          createdAt: 1_700_000_000_000,
        },
        {
          kind: "review" as const,
          id: "review-1",
          author: null,
          body: "Reviewed.",
          state: "changes_requested" as const,
          createdAt: 1_700_000_100_000,
        },
      ],
      isTruncated: true,
    };
    const parsed1 = prActivitySectionSchema.parse(fixture);
    const parsed2 = prActivitySectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses and reparses a never-swept empty section unchanged", () => {
    const fixture = {
      observedAt: null,
      items: [],
      isTruncated: false,
    };
    const parsed1 = prActivitySectionSchema.parse(fixture);
    const parsed2 = prActivitySectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.observedAt).toBeNull();
  });
});

const DETAIL_CORE_POPULATED_FIXTURE = {
  observedAt: 1_700_000_000_000,
  githubHost: "github.com",
  base: BASE_COORDINATES_FIXTURE,
  prUrl: "https://github.com/traycerai/traycer-internal/pull/4465",
  state: "open" as const,
  isDraft: false,
  title: "feat(host): add notification hooks",
  body: "This PR adds notification hooks.",
  author: ACTOR_FIXTURE,
  baseRefName: "development",
  headRefName: "feature/notification-hooks",
  headRefOid: "3ffd8c7ba1234567890abcdef1234567890abcd",
  additions: 120,
  deletions: 30,
  checksRollup: CHECKS_ROLLUP_FIXTURE,
  reviewDecision: "approved" as const,
  reviewRequests: [REVIEW_REQUEST_FIXTURE],
  commentCount: 4,
  updatedAt: 1_700_000_100_000,
  mergedAt: null,
  repoIdentifier: REPO_IDENTIFIER_FIXTURE,
  owners: [OWNER_REF_FIXTURE],
};

describe("prDetailCoreSchema", () => {
  it("parses and reparses a fully populated core unchanged, proving base is never null", () => {
    const parsed1 = prDetailCoreSchema.parse(DETAIL_CORE_POPULATED_FIXTURE);
    const parsed2 = prDetailCoreSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.base).toEqual(BASE_COORDINATES_FIXTURE);
  });

  it("parses and reparses a core with every nullable enrichment field null unchanged", () => {
    const fixture = {
      ...DETAIL_CORE_POPULATED_FIXTURE,
      observedAt: null,
      prUrl: null,
      isDraft: null,
      title: null,
      body: null,
      author: null,
      baseRefName: null,
      headRefName: null,
      headRefOid: null,
      additions: null,
      deletions: null,
      checksRollup: null,
      reviewDecision: null,
      commentCount: null,
      updatedAt: null,
      mergedAt: null,
    };
    const parsed1 = prDetailCoreSchema.parse(fixture);
    const parsed2 = prDetailCoreSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1).toMatchObject({
      observedAt: null,
      prUrl: null,
      isDraft: null,
      title: null,
      body: null,
      author: null,
      baseRefName: null,
      headRefName: null,
      headRefOid: null,
      additions: null,
      deletions: null,
      checksRollup: null,
      reviewDecision: null,
      commentCount: null,
      updatedAt: null,
      mergedAt: null,
    });
    expect(parsed1.base).toEqual(BASE_COORDINATES_FIXTURE);
  });
});

const DETAIL_CHECKS_FIXTURE = {
  observedAt: 1_700_000_000_000,
  contexts: [
    {
      name: "ci/build",
      status: "completed" as const,
      conclusion: "success" as const,
      detailsUrl: null,
    },
  ],
  isTruncated: false,
};

const DETAIL_ACTIVITY_FIXTURE = {
  observedAt: 1_700_000_000_000,
  items: [
    {
      kind: "comment" as const,
      id: "comment-1",
      author: ACTOR_FIXTURE,
      body: "Looks good to me.",
      createdAt: 1_700_000_000_000,
    },
  ],
  isTruncated: false,
};

const DETAIL_FILES_FIXTURE = {
  observedAt: 1_700_000_000_000,
  files: [
    {
      path: "src/index.ts",
      additions: 12,
      deletions: 3,
      changeType: "modified" as const,
    },
  ],
  totalCount: 1,
  isTruncated: false,
};

const DETAIL_COMMITS_FIXTURE = {
  observedAt: 1_700_000_000_000,
  commits: [
    {
      oid: "0123456789abcdef",
      messageHeadline: "feat: add widget",
      author: ACTOR_FIXTURE,
      authorName: "Octo Cat",
      committedAt: 1_700_000_000_000,
    },
  ],
  totalCount: 1,
  isTruncated: false,
};

describe("prFilesSectionSchema", () => {
  it("parses and reparses a populated section unchanged", () => {
    const parsed1 = prFilesSectionSchema.parse(DETAIL_FILES_FIXTURE);
    const parsed2 = prFilesSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses a never-swept section with every nullable field null", () => {
    const parsed = prFilesSectionSchema.parse({
      observedAt: null,
      files: [
        { path: "src/a.ts", additions: null, deletions: null, changeType: null },
      ],
      totalCount: null,
      isTruncated: false,
    });
    expect(parsed.files[0]).toMatchObject({
      additions: null,
      deletions: null,
      changeType: null,
    });
  });
});

describe("prCommitsSectionSchema", () => {
  it("parses and reparses a populated section unchanged", () => {
    const parsed1 = prCommitsSectionSchema.parse(DETAIL_COMMITS_FIXTURE);
    const parsed2 = prCommitsSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses an unlinked commit with a null author but a git author name", () => {
    const parsed = prCommitsSectionSchema.parse({
      observedAt: null,
      commits: [
        {
          oid: "feed",
          messageHeadline: null,
          author: null,
          authorName: "Git Author",
          committedAt: null,
        },
      ],
      totalCount: null,
      isTruncated: true,
    });
    expect(parsed.commits[0]).toMatchObject({
      author: null,
      authorName: "Git Author",
    });
  });
});

describe("prSubscribeDetailServerFrameSchema", () => {
  prSourceStatusSchema.options.forEach((sourceStatus) => {
    prLivenessSchema.options.forEach((liveness) => {
      it(`parses and reparses a snapshot frame with sourceStatus "${sourceStatus}" and liveness "${liveness}" unchanged`, () => {
        const fixture = {
          kind: "snapshot" as const,
          hasBinaryPayload: false as const,
          sourceStatus,
          liveness,
          core: DETAIL_CORE_POPULATED_FIXTURE,
          checks: DETAIL_CHECKS_FIXTURE,
          activity: DETAIL_ACTIVITY_FIXTURE,
          files: DETAIL_FILES_FIXTURE,
          commits: DETAIL_COMMITS_FIXTURE,
        };
        const parsed1 = prSubscribeDetailServerFrameSchema.parse(fixture);
        const parsed2 = prSubscribeDetailServerFrameSchema.parse(parsed1);
        expect(parsed2).toEqual(parsed1);
      });
    });
  });

  it("parses and reparses an updated frame for every sourceStatus unchanged", () => {
    prSourceStatusSchema.options.forEach((sourceStatus) => {
      const fixture = {
        kind: "updated" as const,
        hasBinaryPayload: false as const,
        sourceStatus,
        liveness: "live" as const,
        core: DETAIL_CORE_POPULATED_FIXTURE,
        checks: DETAIL_CHECKS_FIXTURE,
        activity: DETAIL_ACTIVITY_FIXTURE,
        files: DETAIL_FILES_FIXTURE,
        commits: DETAIL_COMMITS_FIXTURE,
      };
      const parsed1 = prSubscribeDetailServerFrameSchema.parse(fixture);
      const parsed2 = prSubscribeDetailServerFrameSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
    });
  });

  it("parses and reparses an error frame unchanged", () => {
    const fixture = {
      kind: "error" as const,
      hasBinaryPayload: false as const,
      message: "gh sweep failed",
      isFatal: true,
    };
    const parsed1 = prSubscribeDetailServerFrameSchema.parse(fixture);
    const parsed2 = prSubscribeDetailServerFrameSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prSubscribeClientFrameSchema", () => {
  it("parses and reparses the refresh variant unchanged", () => {
    const fixture = { kind: "refresh" as const, hasBinaryPayload: false as const };
    const parsed1 = prSubscribeClientFrameSchema.parse(fixture);
    const parsed2 = prSubscribeClientFrameSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("round-trips the same refresh fixture through both contracts' clientFrameSchema", () => {
    const fixture = { kind: "refresh" as const, hasBinaryPayload: false as const };

    const parsedList =
      prSubscribeListForEpicV10.clientFrameSchema.parse(fixture);
    const parsedDetail = prSubscribeDetailV10.clientFrameSchema.parse(fixture);

    expect(parsedList).toEqual(fixture);
    expect(parsedDetail).toEqual(fixture);
    expect(parsedList).toEqual(parsedDetail);
  });
});

describe("pr contract sanity", () => {
  it("has the expected method names and schema versions", () => {
    expect(prSubscribeListForEpicV10.method).toBe("pr.subscribeListForEpic");
    expect(prSubscribeDetailV10.method).toBe("pr.subscribeDetail");
    expect(prSubscribeListForEpicV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(prSubscribeDetailV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });
});
