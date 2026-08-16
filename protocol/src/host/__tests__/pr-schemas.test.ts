/**
 * Round-trip parse tests for the `pr.*` host stream surface schemas.
 * Each top-level schema is parsed twice to ensure idempotency and stability.
 */
import { describe, it, expect } from "vitest";
import {
  prBaseCoordinatesSchema,
  prSubscribeListForEpicOpenRequestSchema,
  prLightItemSchema,
  prSubscribeListForEpicServerFrameSchema,
  prSubscribeDetailOpenRequestSchema,
  prCheckContextSchema,
  prChecksSectionSchema,
  prActivityItemSchema,
  prActivitySectionSchema,
  prReviewThreadsSectionSchema,
  prCommitsSectionSchema,
  prDetailCoreSchema,
  prFilesSectionSchema,
  prSubscribeDetailServerFrameSchema,
  prSubscribeClientFrameSchema,
  prStateSchema,
  prLivenessSchema,
  prRepoRoleSchema,
  prReviewDecisionSchema,
  prSourceStatusSchema,
  prCheckStatusSchema,
  prCheckConclusionSchema,
  prReviewStateSchema,
  prGetLocalDiffRequestSchema,
  prGetLocalDiffResponseSchema,
  prGetLocalDiffSummaryRequestSchema,
  prGetLocalDiffSummaryResponseSchema,
  prGetLocalDiffSummaryResponseV11Schema,
  prGetLocalFileDiffRequestSchema,
  prGetLocalFileDiffRequestV11Schema,
  prGetLocalFileDiffResponseSchema,
  prLocalDiffFileSchema,
  prLocalDiffSummaryFileSchema,
  prLocalDiffSummaryFileV11Schema,
  prLocalDiffOidSchema,
  prLinkGroupKeySchema,
  prRepoIdentifierSchema,
  DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET,
  DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
} from "@traycer/protocol/host/pr-schemas";
import {
  prSubscribeListForEpicV10,
  prSubscribeDetailV10,
  prGetLocalDiffV10,
  prGetLocalDiffSummaryV10,
  prGetLocalDiffSummaryV11,
  prGetLocalDiffSummaryUpgradeV10ToV11,
  prGetLocalFileDiffV10,
  prGetLocalFileDiffV11,
  prGetLocalFileDiffUpgradeV10ToV11,
} from "@traycer/protocol/host/pr-contracts";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

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
  repoRole: "superproject" as const,
  linkGroupKey: "/Users/dev/worktrees/traycer-jolly-fox",
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
  repoRole: "submodule" as const,
  linkGroupKey: null,
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

  it("parses and reparses every repoRole value unchanged", () => {
    prRepoRoleSchema.options.forEach((repoRole) => {
      const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, repoRole };
      const parsed1 = prLightItemSchema.parse(fixture);
      const parsed2 = prLightItemSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
      expect(parsed1.repoRole).toBe(repoRole);
    });
  });

  it("rejects a repoRole outside the pair, so a third role cannot arrive unnoticed", () => {
    const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, repoRole: "nested" };
    expect(() => prLightItemSchema.parse(fixture)).toThrow();
  });

  it("keeps linkGroupKey nullable so an entry with no stable path still lists", () => {
    const fixture = { ...LIGHT_ITEM_POPULATED_FIXTURE, linkGroupKey: null };
    const parsed1 = prLightItemSchema.parse(fixture);
    const parsed2 = prLightItemSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.linkGroupKey).toBeNull();
  });

  it("requires both link fields - an item that omits them is not a valid row", () => {
    const { repoRole, linkGroupKey, ...withoutLinkFields } =
      LIGHT_ITEM_POPULATED_FIXTURE;
    expect(repoRole).toBe("superproject");
    expect(linkGroupKey).not.toBeNull();
    expect(() => prLightItemSchema.parse(withoutLinkFields)).toThrow();
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
        notice: null,
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
        notice: null,
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

describe("prBaseCoordinatesSchema", () => {
  it("parses a valid fixture unchanged", () => {
    expect(prBaseCoordinatesSchema.parse(BASE_COORDINATES_FIXTURE)).toEqual(
      BASE_COORDINATES_FIXTURE,
    );
  });

  it("rejects an empty owner or repo, and a zero/negative prNumber", () => {
    expect(() =>
      prBaseCoordinatesSchema.parse({ ...BASE_COORDINATES_FIXTURE, owner: "" }),
    ).toThrow();
    expect(() =>
      prBaseCoordinatesSchema.parse({ ...BASE_COORDINATES_FIXTURE, repo: "" }),
    ).toThrow();
    expect(() =>
      prBaseCoordinatesSchema.parse({
        ...BASE_COORDINATES_FIXTURE,
        prNumber: 0,
      }),
    ).toThrow();
    expect(() =>
      prBaseCoordinatesSchema.parse({
        ...BASE_COORDINATES_FIXTURE,
        prNumber: -1,
      }),
    ).toThrow();
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

  it("rejects an empty githubHost/owner/repo, and a zero/negative prNumber", () => {
    const fixture = {
      epicId: "epic-1",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer-internal",
      prNumber: 4465,
    };
    expect(() =>
      prSubscribeDetailOpenRequestSchema.parse({ ...fixture, githubHost: "" }),
    ).toThrow();
    expect(() =>
      prSubscribeDetailOpenRequestSchema.parse({ ...fixture, owner: "" }),
    ).toThrow();
    expect(() =>
      prSubscribeDetailOpenRequestSchema.parse({ ...fixture, repo: "" }),
    ).toThrow();
    expect(() =>
      prSubscribeDetailOpenRequestSchema.parse({ ...fixture, prNumber: 0 }),
    ).toThrow();
  });
});

describe("prCheckContextSchema", () => {
  it("parses and reparses every status value unchanged", () => {
    prCheckStatusSchema.options.forEach((status) => {
      const fixture = {
        name: "ci/build",
        workflowName: null,
        event: null,
        appName: null,
        appLogoUrl: null,
        description: null,
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

  it("accepts GitHub's full CheckStatusState set, including pending/requested/waiting", () => {
    const expected = [
      "queued",
      "in_progress",
      "completed",
      "pending",
      "requested",
      "waiting",
    ] as const;

    // The SET, not just its members. Asserting only that each listed value
    // parses says nothing about a seventh being added: a new status would
    // reach the client with no copy written for it and this test would stay
    // green. Set equality makes adding one to the schema fail here first.
    expect([...prCheckStatusSchema.options].sort()).toEqual(
      [...expected].sort(),
    );
    expected.forEach((status) => {
      expect(prCheckStatusSchema.parse(status)).toBe(status);
    });
  });

  it("accepts GitHub's startup_failure conclusion", () => {
    expect(prCheckConclusionSchema.parse("startup_failure")).toBe(
      "startup_failure",
    );
  });

  it("parses and reparses every conclusion value unchanged", () => {
    prCheckConclusionSchema.options.forEach((conclusion) => {
      const fixture = {
        name: "ci/build",
        workflowName: null,
        event: null,
        appName: null,
        appLogoUrl: null,
        description: null,
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
      workflowName: null,
      event: null,
      appName: null,
      appLogoUrl: null,
      description: null,
      status: "in_progress" as const,
      conclusion: null,
      detailsUrl: null,
    };
    const parsed1 = prCheckContextSchema.parse(fixture);
    const parsed2 = prCheckContextSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.conclusion).toBeNull();
  });

  it("carries the workflow, event and app that separate two jobs named alike", () => {
    // `name` is the JOB name and is not unique: one reusable workflow reports
    // `build` once per package. Only `workflowName` tells the rows apart.
    const base = {
      name: "build",
      event: "pull_request",
      appName: "GitHub Actions",
      appLogoUrl: "https://avatars/actions.png",
      description: null,
      status: "completed" as const,
      conclusion: "success" as const,
      detailsUrl: null,
    };
    const host = prCheckContextSchema.parse({
      ...base,
      workflowName: "Build Host",
    });
    const gui = prCheckContextSchema.parse({
      ...base,
      workflowName: "Build GUI",
    });
    expect(host.name).toBe(gui.name);
    expect(host.workflowName).not.toBe(gui.workflowName);
    expect(prCheckContextSchema.parse(host)).toEqual(host);
  });

  it("keeps every new field nullable - a check outside a workflow has none", () => {
    // A third-party app's check belongs to no workflow run, and a commit
    // status has no app record at all.
    const parsed = prCheckContextSchema.parse({
      name: "Mintlify Deployment",
      workflowName: null,
      event: null,
      appName: "Mintlify",
      appLogoUrl: null,
      description: "Skipping deployment",
      status: "completed" as const,
      conclusion: "skipped" as const,
      detailsUrl: null,
    });
    expect(parsed.workflowName).toBeNull();
    expect(parsed.event).toBeNull();
    expect(parsed.description).toBe("Skipping deployment");
    expect(prCheckContextSchema.parse(parsed)).toEqual(parsed);
  });
});

describe("prChecksSectionSchema", () => {
  it("parses and reparses isTruncated: true unchanged", () => {
    const fixture = {
      observedAt: 1_700_000_000_000,
      contexts: [
        {
          name: "ci/build",
          workflowName: null,
          event: null,
          appName: null,
          appLogoUrl: null,
          description: null,
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

describe("prReviewThreadsSectionSchema", () => {
  const thread = {
    id: "PRRT_1",
    reviewId: "PRR_1",
    path: "src/domain/git/git-service.ts",
    line: 1141,
    originalLine: 1120,
    side: "right" as const,
    subject: "line" as const,
    isResolved: false,
    isOutdated: false,
    diffHunk: "@@ -1139,3 +1139,4 @@\n+  const cap = 5;",
    comments: [
      {
        id: "PRRC_1",
        author: ACTOR_FIXTURE,
        body: "This cap is not enforced offline.",
        createdAt: 1_700_000_000_000,
        url: "https://github.com/acme/widgets/pull/7#discussion_r1",
      },
      {
        id: "PRRC_2",
        author: null,
        body: "Confirmed - fixed in 3d2f8a8a.",
        createdAt: 1_700_000_100_000,
        url: null,
      },
    ],
    totalCommentCount: 5,
  };

  it("parses and reparses a populated thread unchanged", () => {
    const fixture = {
      observedAt: 1_700_000_000_000,
      threads: [thread],
      isTruncated: true,
    };
    const parsed1 = prReviewThreadsSectionSchema.parse(fixture);
    const parsed2 = prReviewThreadsSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("carries a null line beside a real originalLine - an outdated thread", () => {
    // GitHub returns `line: null` once the code the thread pointed at has
    // moved or gone, and `originalLine` is then the only anchor left. A schema
    // that required `line` would reject exactly the threads most worth reading.
    const parsed = prReviewThreadsSectionSchema.parse({
      observedAt: 1_700_000_000_000,
      threads: [{ ...thread, line: null, isOutdated: true }],
      isTruncated: false,
    });
    expect(parsed.threads[0]?.line).toBeNull();
    expect(parsed.threads[0]?.originalLine).toBe(1120);
  });

  it("carries a null reviewId - a thread whose review left the window", () => {
    const parsed = prReviewThreadsSectionSchema.parse({
      observedAt: 1_700_000_000_000,
      threads: [{ ...thread, reviewId: null }],
      isTruncated: false,
    });
    expect(parsed.threads[0]?.reviewId).toBeNull();
  });

  it("carries a null diffHunk without dropping the thread", () => {
    const parsed = prReviewThreadsSectionSchema.parse({
      observedAt: 1_700_000_000_000,
      threads: [{ ...thread, diffHunk: null }],
      isTruncated: false,
    });
    expect(parsed.threads[0]?.diffHunk).toBeNull();
    expect(parsed.threads[0]?.comments).toHaveLength(2);
  });

  it("keeps totalCommentCount independent of the carried comments", () => {
    // The cap clips replies; the true count is what lets the UI say how many
    // it is not showing rather than silently pretending there are two.
    const parsed = prReviewThreadsSectionSchema.parse({
      observedAt: 1_700_000_000_000,
      threads: [thread],
      isTruncated: false,
    });
    expect(parsed.threads[0]?.comments).toHaveLength(2);
    expect(parsed.threads[0]?.totalCommentCount).toBe(5);
  });

  it("rejects a side or subject outside the closed set", () => {
    for (const bad of [{ side: "middle" }, { subject: "hunk" }]) {
      expect(() =>
        prReviewThreadsSectionSchema.parse({
          observedAt: null,
          threads: [{ ...thread, ...bad }],
          isTruncated: false,
        }),
      ).toThrow();
    }
  });

  it("parses and reparses a never-swept empty section unchanged", () => {
    const fixture = { observedAt: null, threads: [], isTruncated: false };
    const parsed1 = prReviewThreadsSectionSchema.parse(fixture);
    const parsed2 = prReviewThreadsSectionSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
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
  repoRole: "superproject" as const,
  linkGroupKey: "/Users/dev/worktrees/traycer-jolly-fox",
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
      name: "build",
      workflowName: "Build Host",
      event: "pull_request",
      appName: "GitHub Actions",
      appLogoUrl: "https://avatars/actions.png",
      description: null,
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

const DETAIL_REVIEW_THREADS_FIXTURE = {
  observedAt: 1_700_000_000_000,
  threads: [
    {
      id: "PRRT_1",
      reviewId: "PRR_1",
      path: "src/a.ts",
      line: 22,
      originalLine: 22,
      side: "right" as const,
      subject: "line" as const,
      isResolved: false,
      isOutdated: false,
      diffHunk: "@@ -20,3 +20,4 @@\n+const cap = 5;",
      comments: [
        {
          id: "PRRC_1",
          author: ACTOR_FIXTURE,
          body: "This cap is not enforced offline.",
          createdAt: 1_700_000_000_000,
          url: "https://github.com/acme/widgets/pull/7#discussion_r1",
        },
      ],
      totalCommentCount: 1,
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
        {
          path: "src/a.ts",
          additions: null,
          deletions: null,
          changeType: null,
        },
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

describe("prSourceNoticeSchema on both stream frames", () => {
  const NOTICES = [
    { kind: "rate-limited" as const, retryAt: 1_726_000_000_000 },
    // `retryAt: null` is the fresh-restart-mid-limit case, and it has to
    // survive the wire intact: collapsing it to a number would turn "we do
    // not know when GitHub resets" into a specific promise.
    { kind: "rate-limited" as const, retryAt: null },
    { kind: "backing-off" as const, retryAt: 1_726_000_000_000 },
    { kind: "backing-off" as const, retryAt: null },
  ];

  NOTICES.forEach((notice) => {
    it(`round-trips a list frame carrying notice ${notice.kind}/${String(notice.retryAt)}`, () => {
      const parsed = prSubscribeListForEpicServerFrameSchema.parse({
        kind: "updated" as const,
        hasBinaryPayload: false as const,
        // A pause is `cached` PLUS a notice - never its own sourceStatus.
        sourceStatus: "cached" as const,
        notice,
        items: [LIGHT_ITEM_POPULATED_FIXTURE],
      });
      expect(parsed.kind === "updated" ? parsed.notice : null).toEqual(notice);
    });

    it(`round-trips a detail frame carrying notice ${notice.kind}/${String(notice.retryAt)}`, () => {
      const parsed = prSubscribeDetailServerFrameSchema.parse({
        kind: "updated" as const,
        hasBinaryPayload: false as const,
        sourceStatus: "cached" as const,
        notice,
        liveness: "live" as const,
        core: DETAIL_CORE_POPULATED_FIXTURE,
        checks: DETAIL_CHECKS_FIXTURE,
        activity: DETAIL_ACTIVITY_FIXTURE,
        reviewThreads: DETAIL_REVIEW_THREADS_FIXTURE,
        files: DETAIL_FILES_FIXTURE,
        commits: DETAIL_COMMITS_FIXTURE,
      });
      expect(parsed.kind === "updated" ? parsed.notice : null).toEqual(notice);
    });
  });

  it("rejects a notice kind the client has no copy for", () => {
    expect(
      prSubscribeListForEpicServerFrameSchema.safeParse({
        kind: "updated" as const,
        hasBinaryPayload: false as const,
        sourceStatus: "cached" as const,
        notice: { kind: "throttled", retryAt: null },
        items: [],
      }).success,
    ).toBe(false);
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
          notice: null,
          liveness,
          core: DETAIL_CORE_POPULATED_FIXTURE,
          checks: DETAIL_CHECKS_FIXTURE,
          activity: DETAIL_ACTIVITY_FIXTURE,
          reviewThreads: DETAIL_REVIEW_THREADS_FIXTURE,
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
        notice: null,
        liveness: "live" as const,
        core: DETAIL_CORE_POPULATED_FIXTURE,
        checks: DETAIL_CHECKS_FIXTURE,
        activity: DETAIL_ACTIVITY_FIXTURE,
        reviewThreads: DETAIL_REVIEW_THREADS_FIXTURE,
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
    const fixture = {
      kind: "refresh" as const,
      hasBinaryPayload: false as const,
    };
    const parsed1 = prSubscribeClientFrameSchema.parse(fixture);
    const parsed2 = prSubscribeClientFrameSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("round-trips the same refresh fixture through both contracts' clientFrameSchema", () => {
    const fixture = {
      kind: "refresh" as const,
      hasBinaryPayload: false as const,
    };

    const parsedList =
      prSubscribeListForEpicV10.clientFrameSchema.parse(fixture);
    const parsedDetail = prSubscribeDetailV10.clientFrameSchema.parse(fixture);

    expect(parsedList).toEqual(fixture);
    expect(parsedDetail).toEqual(fixture);
    expect(parsedList).toEqual(parsedDetail);
  });
});

const LOCAL_DIFF_REQUEST_FIXTURE = {
  epicId: "epic-1",
  linkGroupKey: "/Users/dev/worktrees/traycer-jolly-fox",
  repoIdentifier: REPO_IDENTIFIER_FIXTURE,
  repoRole: "superproject" as const,
  baseRefName: "development",
  headRefName: "feature/notification-hooks",
  expectedHeadOid: "a".repeat(40),
  ignoreWhitespace: false,
  byteBudget: DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET,
};

const LOCAL_DIFF_FILE_FIXTURE = {
  path: "traycer-host/src/domain/git/git-service.ts",
  previousPath: null,
  status: "modified" as const,
  insertions: 157,
  deletions: 0,
  isBinary: false,
  patch: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
};

describe("prGetLocalDiffRequestSchema", () => {
  it("parses and reparses a populated request unchanged", () => {
    const parsed1 = prGetLocalDiffRequestSchema.parse(
      LOCAL_DIFF_REQUEST_FIXTURE,
    );
    const parsed2 = prGetLocalDiffRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("defaults byteBudget so a caller may omit it", () => {
    const { byteBudget, ...withoutBudget } = LOCAL_DIFF_REQUEST_FIXTURE;
    expect(byteBudget).toBe(DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET);
    const parsed = prGetLocalDiffRequestSchema.parse(withoutBudget);
    expect(parsed.byteBudget).toBe(DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET);
  });

  it("accepts a null expectedHeadOid - unknown is not stale", () => {
    const parsed = prGetLocalDiffRequestSchema.parse({
      ...LOCAL_DIFF_REQUEST_FIXTURE,
      expectedHeadOid: null,
    });
    expect(parsed.expectedHeadOid).toBeNull();
  });

  it("rejects an empty ref name rather than letting it reach argv", () => {
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        baseRefName: "",
      }),
    ).toThrow();
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        headRefName: "",
      }),
    ).toThrow();
  });

  it("carries no hostId - the host it runs on is the only host it could mean", () => {
    const parsed = prGetLocalDiffRequestSchema.parse({
      ...LOCAL_DIFF_REQUEST_FIXTURE,
      hostId: "host-1",
    });
    expect(parsed).not.toHaveProperty("hostId");
  });

  it("rejects an empty linkGroupKey - the host cannot resolve it to a directory", () => {
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        linkGroupKey: "",
      }),
    ).toThrow();
  });

  it("rejects an empty repoIdentifier owner or repo - they cannot be matched against a binding", () => {
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        repoIdentifier: { ...REPO_IDENTIFIER_FIXTURE, owner: "" },
      }),
    ).toThrow();
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        repoIdentifier: { ...REPO_IDENTIFIER_FIXTURE, repo: "" },
      }),
    ).toThrow();
  });

  it("REQUIRES a non-empty epicId - it is the authorization scope, not a hint", () => {
    // The host gates this method on the caller's role in `epicId` and matches
    // it against the binding that vouches for `linkGroupKey`. An absent or
    // empty value must fail at the boundary rather than reach a resolver that
    // would then have nothing to authorize against.
    const { epicId, ...withoutEpicId } = LOCAL_DIFF_REQUEST_FIXTURE;
    expect(epicId).toBe("epic-1");
    expect(() => prGetLocalDiffRequestSchema.parse(withoutEpicId)).toThrow();
    expect(() =>
      prGetLocalDiffRequestSchema.parse({
        ...LOCAL_DIFF_REQUEST_FIXTURE,
        epicId: "",
      }),
    ).toThrow();
  });
});

describe("prLinkGroupKeySchema / prRepoIdentifierSchema stay permissive", () => {
  // `pr.getLocalDiff` tightens `linkGroupKey`/`owner`/`repo` to `.min(1)` on
  // its OWN request fields, not on these shared schemas - the stream frames
  // (`prLightItemSchema`, `prDetailCoreSchema`) legitimately carry an empty
  // `linkGroupKey` for an entry with no stable local path, and a repo
  // identifier that predates this stricter request shape. Tightening the
  // shared schemas instead would silently break those frames.
  it("prLinkGroupKeySchema still accepts an empty string", () => {
    expect(prLinkGroupKeySchema.parse("")).toBe("");
  });

  it("prRepoIdentifierSchema still accepts empty owner and repo", () => {
    expect(prRepoIdentifierSchema.parse({ owner: "", repo: "" })).toEqual({
      owner: "",
      repo: "",
    });
  });
});

describe("prGetLocalDiffResponseSchema", () => {
  it("parses and reparses a diff response unchanged", () => {
    const fixture = {
      kind: "diff" as const,
      runningDir: "/Users/dev/worktrees/traycer-jolly-fox",
      resolvedBaseRef: "origin/development",
      baseOid: "b".repeat(40),
      mergeBaseOid: "c".repeat(40),
      localHeadOid: "a".repeat(40),
      isStale: false,
      files: [LOCAL_DIFF_FILE_FIXTURE],
      isTruncated: false,
    };
    const parsed1 = prGetLocalDiffResponseSchema.parse(fixture);
    const parsed2 = prGetLocalDiffResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses and reparses every unavailable reason unchanged", () => {
    for (const reason of [
      "no-local-checkout",
      "repo-mismatch",
      "ref-unavailable",
      "no-merge-base",
      "git-unavailable",
    ] as const) {
      const parsed1 = prGetLocalDiffResponseSchema.parse({
        kind: "unavailable",
        reason,
      });
      const parsed2 = prGetLocalDiffResponseSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
    }
  });

  it("rejects an unavailable reason outside the closed set", () => {
    expect(() =>
      prGetLocalDiffResponseSchema.parse({
        kind: "unavailable",
        reason: "something-else",
      }),
    ).toThrow();
  });

  it("keeps a file's patch and counts independently nullable", () => {
    // A truncated sweep yields `patch: null` with REAL counts; a binary file
    // yields null counts with a real (empty) patch. Collapsing either pair
    // would lose the distinction the UI renders differently.
    const truncated = prLocalDiffFileSchema.parse({
      ...LOCAL_DIFF_FILE_FIXTURE,
      patch: null,
    });
    expect(truncated.patch).toBeNull();
    expect(truncated.insertions).toBe(157);

    const binary = prLocalDiffFileSchema.parse({
      ...LOCAL_DIFF_FILE_FIXTURE,
      insertions: null,
      deletions: null,
      isBinary: true,
    });
    expect(binary.isBinary).toBe(true);
    expect(binary.insertions).toBeNull();
  });

  it("carries a rename's pre-image path", () => {
    const renamed = prLocalDiffFileSchema.parse({
      ...LOCAL_DIFF_FILE_FIXTURE,
      status: "renamed",
      previousPath: "old/path.ts",
    });
    expect(renamed.previousPath).toBe("old/path.ts");
  });
});

describe("pr contract sanity", () => {
  it("has the expected method names and schema versions", () => {
    expect(prSubscribeListForEpicV10.method).toBe("pr.subscribeListForEpic");
    expect(prSubscribeDetailV10.method).toBe("pr.subscribeDetail");
    expect(prGetLocalDiffV10.method).toBe("pr.getLocalDiff");
    expect(prGetLocalDiffSummaryV10.method).toBe("pr.getLocalDiffSummary");
    expect(prGetLocalFileDiffV10.method).toBe("pr.getLocalFileDiff");
    expect(prSubscribeListForEpicV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(prSubscribeDetailV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(prGetLocalDiffV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(prGetLocalDiffSummaryV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(prGetLocalFileDiffV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });
});

const LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE = {
  epicId: LOCAL_DIFF_REQUEST_FIXTURE.epicId,
  linkGroupKey: LOCAL_DIFF_REQUEST_FIXTURE.linkGroupKey,
  repoIdentifier: LOCAL_DIFF_REQUEST_FIXTURE.repoIdentifier,
  repoRole: LOCAL_DIFF_REQUEST_FIXTURE.repoRole,
  baseRefName: LOCAL_DIFF_REQUEST_FIXTURE.baseRefName,
  headRefName: LOCAL_DIFF_REQUEST_FIXTURE.headRefName,
  expectedHeadOid: LOCAL_DIFF_REQUEST_FIXTURE.expectedHeadOid,
  ignoreWhitespace: LOCAL_DIFF_REQUEST_FIXTURE.ignoreWhitespace,
};

const LOCAL_FILE_DIFF_REQUEST_FIXTURE = {
  epicId: "epic-1",
  linkGroupKey: "/Users/dev/worktrees/traycer-jolly-fox",
  repoIdentifier: REPO_IDENTIFIER_FIXTURE,
  repoRole: "superproject" as const,
  mergeBaseOid: "c".repeat(40),
  headOid: "a".repeat(40),
  path: "traycer-host/src/domain/git/git-service.ts",
  previousPath: null,
  ignoreWhitespace: false,
  byteBudget: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
};

describe("prGetLocalDiffSummaryRequestSchema", () => {
  it("is the monolith request minus byteBudget - parses without it and strips nothing else", () => {
    const parsed = prGetLocalDiffSummaryRequestSchema.parse(
      LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE,
    );
    expect(parsed).toEqual(LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE);
    expect(parsed).not.toHaveProperty("byteBudget");

    const fromMonolith = prGetLocalDiffSummaryRequestSchema.parse(
      LOCAL_DIFF_REQUEST_FIXTURE,
    );
    expect(fromMonolith).toEqual(LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE);
    expect(fromMonolith).not.toHaveProperty("byteBudget");
  });

  it("parses and reparses a populated request unchanged", () => {
    const parsed1 = prGetLocalDiffSummaryRequestSchema.parse(
      LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE,
    );
    const parsed2 = prGetLocalDiffSummaryRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prLocalDiffOidSchema", () => {
  it("accepts exactly 40- and 64-char lowercase hex", () => {
    expect(prLocalDiffOidSchema.parse("a".repeat(40))).toBe("a".repeat(40));
    expect(prLocalDiffOidSchema.parse("0123456789abcdef".repeat(4))).toBe(
      "0123456789abcdef".repeat(4),
    );
    expect(prLocalDiffOidSchema.parse("b".repeat(64))).toBe("b".repeat(64));
  });

  it("rejects abbreviations, uppercase, ref names, and revision expressions", () => {
    for (const value of [
      "a".repeat(7),
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
      "a".repeat(39) + "F",
      "HEAD",
      "main",
      "refs/heads/main",
      "a..b",
      `${"a".repeat(20)}..${"b".repeat(18)}`,
    ]) {
      expect(() => prLocalDiffOidSchema.parse(value)).toThrow();
    }
  });
});

describe("prGetLocalDiffSummaryResponseSchema", () => {
  it("parses and reparses a summary response unchanged", () => {
    const fixture = {
      kind: "summary" as const,
      runningDir: "/Users/dev/worktrees/traycer-jolly-fox",
      resolvedBaseRef: "origin/development",
      baseOid: "b".repeat(40),
      mergeBaseOid: "c".repeat(40),
      localHeadOid: "a".repeat(40),
      isStale: false,
      files: [
        {
          path: LOCAL_DIFF_FILE_FIXTURE.path,
          previousPath: LOCAL_DIFF_FILE_FIXTURE.previousPath,
          status: LOCAL_DIFF_FILE_FIXTURE.status,
          insertions: LOCAL_DIFF_FILE_FIXTURE.insertions,
          deletions: LOCAL_DIFF_FILE_FIXTURE.deletions,
          isBinary: LOCAL_DIFF_FILE_FIXTURE.isBinary,
        },
      ],
    };
    const parsed1 = prGetLocalDiffSummaryResponseSchema.parse(fixture);
    const parsed2 = prGetLocalDiffSummaryResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("rejects empty path and previousPath in a summary file", () => {
    // The client forwards a summary file's path and previousPath verbatim
    // into pr.getLocalFileDiff requests, whose schema requires min(1) (path)
    // and min(1) | null (previousPath). The summary states the SAME rules so
    // a parse-valid summary can never build a request-invalid ask. (The
    // released monolith file schema stays looser - its files never feed a
    // request.)
    const renamed = prLocalDiffSummaryFileSchema.parse({
      path: "new/path.ts",
      previousPath: "old/path.ts",
      status: "renamed",
      insertions: 1,
      deletions: 1,
      isBinary: false,
    });
    expect(renamed.previousPath).toBe("old/path.ts");
    expect(
      prLocalDiffSummaryFileSchema.safeParse({
        ...renamed,
        previousPath: "",
      }).success,
    ).toBe(false);
    expect(
      prLocalDiffSummaryFileSchema.safeParse({
        ...renamed,
        path: "",
      }).success,
    ).toBe(false);
    expect(
      prLocalDiffFileSchema.safeParse({
        ...renamed,
        path: "",
        previousPath: "",
        patch: null,
      }).success,
    ).toBe(true);
  });

  it("parses and reparses every unavailable reason unchanged", () => {
    for (const reason of [
      "no-local-checkout",
      "repo-mismatch",
      "ref-unavailable",
      "no-merge-base",
      "git-unavailable",
    ] as const) {
      const parsed1 = prGetLocalDiffSummaryResponseSchema.parse({
        kind: "unavailable",
        reason,
      });
      const parsed2 = prGetLocalDiffSummaryResponseSchema.parse(parsed1);
      expect(parsed2).toEqual(parsed1);
    }
  });
});

describe("prGetLocalFileDiffRequestSchema", () => {
  it("defaults byteBudget to the 256 KiB per-file budget and accepts null", () => {
    const { byteBudget, ...withoutBudget } = LOCAL_FILE_DIFF_REQUEST_FIXTURE;
    expect(byteBudget).toBe(DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET);
    expect(prGetLocalFileDiffRequestSchema.parse(withoutBudget).byteBudget).toBe(
      DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
    );
    expect(
      prGetLocalFileDiffRequestSchema.parse({
        ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
        byteBudget: null,
      }).byteBudget,
    ).toBeNull();
  });

  it("parses and reparses a populated request unchanged", () => {
    const parsed1 = prGetLocalFileDiffRequestSchema.parse(
      LOCAL_FILE_DIFF_REQUEST_FIXTURE,
    );
    const parsed2 = prGetLocalFileDiffRequestSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("prGetLocalFileDiffResponseSchema", () => {
  it("keeps patch non-nullable and truncatedAfterBytes nullable", () => {
    const parsed = prGetLocalFileDiffResponseSchema.parse({
      kind: "diff",
      patch: "",
      isBinary: false,
      isTruncated: false,
      truncatedAfterBytes: null,
    });
    expect(parsed).toEqual({
      kind: "diff",
      patch: "",
      isBinary: false,
      isTruncated: false,
      truncatedAfterBytes: null,
    });

    expect(() =>
      prGetLocalFileDiffResponseSchema.parse({
        kind: "diff",
        patch: null,
        isBinary: false,
        isTruncated: false,
        truncatedAfterBytes: null,
      }),
    ).toThrow();
  });

  it("parses and reparses a truncated file-diff response unchanged", () => {
    const fixture = {
      kind: "diff" as const,
      patch: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
      isBinary: false,
      isTruncated: true,
      truncatedAfterBytes: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
    };
    const parsed1 = prGetLocalFileDiffResponseSchema.parse(fixture);
    const parsed2 = prGetLocalFileDiffResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("pr split RPC contracts", () => {
  it("registers both canonical v1.0 contracts with the exact schema instances", () => {
    const summary = hostRpcRegistry["pr.getLocalDiffSummary"];
    const fileDiff = hostRpcRegistry["pr.getLocalFileDiff"];
    const summaryContract = summary[1].versions[0].contract;
    const fileDiffContract = fileDiff[1].versions[0].contract;

    expect(summaryContract).toBe(prGetLocalDiffSummaryV10);
    expect(fileDiffContract).toBe(prGetLocalFileDiffV10);
    expect(summaryContract.requestSchema).toBe(
      prGetLocalDiffSummaryRequestSchema,
    );
    expect(summaryContract.responseSchema).toBe(
      prGetLocalDiffSummaryResponseSchema,
    );
    expect(fileDiffContract.requestSchema).toBe(
      prGetLocalFileDiffRequestSchema,
    );
    expect(fileDiffContract.responseSchema).toBe(
      prGetLocalFileDiffResponseSchema,
    );
    expect(summaryContract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(fileDiffContract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(summaryContract.method).toBe("pr.getLocalDiffSummary");
    expect(fileDiffContract.method).toBe("pr.getLocalFileDiff");
  });

  it("keeps both additive methods optional and unsupported on older hosts", () => {
    for (const method of [
      "pr.getLocalDiffSummary",
      "pr.getLocalFileDiff",
    ] as const) {
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }

    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.manifest["pr.getLocalDiffSummary"]).toBeUndefined();
    expect(split.manifest["pr.getLocalFileDiff"]).toBeUndefined();
    expect(split.optionalManifest["pr.getLocalDiffSummary"]).toEqual({
      major: 1,
      minor: 1,
    });
    expect(split.optionalManifest["pr.getLocalFileDiff"]).toEqual({
      major: 1,
      minor: 1,
    });
  });
});

describe("pr split RPC v1.1 byte-path registry entries", () => {
  it("registers the v1.1 contracts as latestMinor with the exact exported instances", () => {
    const summary = hostRpcRegistry["pr.getLocalDiffSummary"];
    const fileDiff = hostRpcRegistry["pr.getLocalFileDiff"];

    expect(summary[1].latestMinor).toBe(1);
    expect(fileDiff[1].latestMinor).toBe(1);

    const summaryV11 = summary[1].versions[1];
    const fileDiffV11 = fileDiff[1].versions[1];

    expect(summaryV11.contract).toBe(prGetLocalDiffSummaryV11);
    expect(fileDiffV11.contract).toBe(prGetLocalFileDiffV11);
    expect(summaryV11.upgradeFromPreviousVersion).toBe(
      prGetLocalDiffSummaryUpgradeV10ToV11,
    );
    expect(fileDiffV11.upgradeFromPreviousVersion).toBe(
      prGetLocalFileDiffUpgradeV10ToV11,
    );
    expect(summaryV11.contract.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(fileDiffV11.contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});

describe("prGetLocalDiffSummaryUpgradeV10ToV11", () => {
  it("upgradeRequest is identity - the request shape is unchanged at 1.1", () => {
    const request = prGetLocalDiffSummaryRequestSchema.parse(
      LOCAL_DIFF_SUMMARY_REQUEST_FIXTURE,
    );
    expect(prGetLocalDiffSummaryUpgradeV10ToV11.upgradeRequest(request)).toBe(
      request,
    );
  });

  it("fills null byte-path sidecars on every file of a v1.0 summary response, leaving everything else identical", () => {
    const v10 = prGetLocalDiffSummaryResponseSchema.parse({
      kind: "summary",
      runningDir: "/tmp/worktrees/widgets",
      resolvedBaseRef: "origin/development",
      baseOid: "b".repeat(40),
      mergeBaseOid: "c".repeat(40),
      localHeadOid: "a".repeat(40),
      isStale: false,
      files: [
        {
          path: LOCAL_DIFF_FILE_FIXTURE.path,
          previousPath: LOCAL_DIFF_FILE_FIXTURE.previousPath,
          status: LOCAL_DIFF_FILE_FIXTURE.status,
          insertions: LOCAL_DIFF_FILE_FIXTURE.insertions,
          deletions: LOCAL_DIFF_FILE_FIXTURE.deletions,
          isBinary: LOCAL_DIFF_FILE_FIXTURE.isBinary,
        },
      ],
    });
    if (v10.kind !== "summary") throw new Error("expected a summary fixture");

    const upgraded = prGetLocalDiffSummaryUpgradeV10ToV11.upgradeResponse(v10);

    expect(upgraded.kind).toBe("summary");
    if (upgraded.kind !== "summary") return;
    expect(upgraded.files).toEqual([
      { ...v10.files[0], pathBytes: null, previousPathBytes: null },
    ]);
    expect(() =>
      prGetLocalDiffSummaryResponseV11Schema.parse(upgraded),
    ).not.toThrow();
  });

  it("passes an unavailable v1.0 response through unchanged", () => {
    for (const reason of [
      "no-local-checkout",
      "repo-mismatch",
      "ref-unavailable",
      "no-merge-base",
      "git-unavailable",
    ] as const) {
      const unavailable = prGetLocalDiffSummaryResponseSchema.parse({
        kind: "unavailable",
        reason,
      });
      const upgraded =
        prGetLocalDiffSummaryUpgradeV10ToV11.upgradeResponse(unavailable);
      expect(upgraded).toEqual(unavailable);
    }
  });
});

describe("prGetLocalFileDiffUpgradeV10ToV11", () => {
  it("fills null byte-path sidecars on a v1.0 request", () => {
    const request = prGetLocalFileDiffRequestSchema.parse(
      LOCAL_FILE_DIFF_REQUEST_FIXTURE,
    );
    const upgraded =
      prGetLocalFileDiffUpgradeV10ToV11.upgradeRequest(request);
    expect(upgraded).toEqual({
      ...request,
      pathBytes: null,
      previousPathBytes: null,
    });
    expect(() =>
      prGetLocalFileDiffRequestV11Schema.parse(upgraded),
    ).not.toThrow();
  });

  it("upgradeResponse is identity - the response shape is unchanged at 1.1", () => {
    const response = prGetLocalFileDiffResponseSchema.parse({
      kind: "diff",
      patch: "",
      isBinary: false,
      isTruncated: false,
      truncatedAfterBytes: null,
    });
    expect(prGetLocalFileDiffUpgradeV10ToV11.upgradeResponse(response)).toBe(
      response,
    );
  });
});

const SUMMARY_FILE_V11_BASE_FIXTURE = {
  path: LOCAL_DIFF_FILE_FIXTURE.path,
  previousPath: null,
  status: LOCAL_DIFF_FILE_FIXTURE.status,
  insertions: LOCAL_DIFF_FILE_FIXTURE.insertions,
  deletions: LOCAL_DIFF_FILE_FIXTURE.deletions,
  isBinary: LOCAL_DIFF_FILE_FIXTURE.isBinary,
};

describe("prLocalDiffSummaryFileV11Schema", () => {
  it("accepts a non-null token string, independently per side", () => {
    const parsed = prLocalDiffSummaryFileV11Schema.parse({
      ...SUMMARY_FILE_V11_BASE_FIXTURE,
      pathBytes: "dG9rZW4=",
      previousPathBytes: null,
    });
    expect(parsed.pathBytes).toBe("dG9rZW4=");
    expect(parsed.previousPathBytes).toBeNull();
  });

  it("accepts null, independently per side", () => {
    const parsed = prLocalDiffSummaryFileV11Schema.parse({
      ...SUMMARY_FILE_V11_BASE_FIXTURE,
      pathBytes: null,
      previousPathBytes: "dG9rZW4=",
    });
    expect(parsed.pathBytes).toBeNull();
    expect(parsed.previousPathBytes).toBe("dG9rZW4=");
  });

  it("rejects an empty string for either sidecar rather than treating it as a real (empty) token", () => {
    expect(
      prLocalDiffSummaryFileV11Schema.safeParse({
        ...SUMMARY_FILE_V11_BASE_FIXTURE,
        pathBytes: "",
        previousPathBytes: null,
      }).success,
    ).toBe(false);
    expect(
      prLocalDiffSummaryFileV11Schema.safeParse({
        ...SUMMARY_FILE_V11_BASE_FIXTURE,
        pathBytes: null,
        previousPathBytes: "",
      }).success,
    ).toBe(false);
  });

  it("rejects every noncanonical alias of a token at the schema, so an alias can never become a distinct identity", () => {
    // Each decodes (forgivingly) to bytes whose canonical encoding differs:
    // missing padding, url-safe alphabet, embedded whitespace, trailing
    // junk, nonzero padding bits, and a plainly non-base64 string.
    const aliases = ["/w", "_w==", " dG9rZW4=", "dG9rZW4=junk", "Yf==", "not-base64"];
    for (const alias of aliases) {
      expect(
        prLocalDiffSummaryFileV11Schema.safeParse({
          ...SUMMARY_FILE_V11_BASE_FIXTURE,
          pathBytes: alias,
          previousPathBytes: null,
        }).success,
      ).toBe(false);
      expect(
        prGetLocalFileDiffRequestV11Schema.safeParse({
          ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
          pathBytes: null,
          previousPathBytes: alias,
        }).success,
      ).toBe(false);
    }
    // The canonical spelling of the first alias's bytes IS accepted.
    expect(
      prLocalDiffSummaryFileV11Schema.safeParse({
        ...SUMMARY_FILE_V11_BASE_FIXTURE,
        pathBytes: "/w==",
        previousPathBytes: null,
      }).success,
    ).toBe(true);
  });
});

describe("prGetLocalFileDiffRequestV11Schema", () => {
  it("accepts a non-null token string and null, independently per side", () => {
    const withToken = prGetLocalFileDiffRequestV11Schema.parse({
      ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
      pathBytes: "dG9rZW4=",
      previousPathBytes: null,
    });
    expect(withToken.pathBytes).toBe("dG9rZW4=");
    expect(withToken.previousPathBytes).toBeNull();

    const withPreviousToken = prGetLocalFileDiffRequestV11Schema.parse({
      ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
      pathBytes: null,
      previousPathBytes: "dG9rZW4=",
    });
    expect(withPreviousToken.pathBytes).toBeNull();
    expect(withPreviousToken.previousPathBytes).toBe("dG9rZW4=");
  });

  it("rejects an empty string for either sidecar", () => {
    expect(
      prGetLocalFileDiffRequestV11Schema.safeParse({
        ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
        pathBytes: "",
        previousPathBytes: null,
      }).success,
    ).toBe(false);
    expect(
      prGetLocalFileDiffRequestV11Schema.safeParse({
        ...LOCAL_FILE_DIFF_REQUEST_FIXTURE,
        pathBytes: null,
        previousPathBytes: "",
      }).success,
    ).toBe(false);
  });
});
