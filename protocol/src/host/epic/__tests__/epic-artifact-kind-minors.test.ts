import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  commentsListThreadsV10,
  commentsListThreadsV11,
} from "@traycer/protocol/host/comments/contracts";
import {
  epicCreateArtifactV10,
  epicCreateArtifactV11,
  epicCreateCommentThreadV10,
  epicCreateCommentThreadV11,
  epicDeleteCommentThreadV10,
  epicDeleteCommentThreadV11,
  epicDeleteCommentV10,
  epicDeleteCommentV11,
  epicEditCommentV10,
  epicEditCommentV11,
  epicListCommentThreadsV10,
  epicListCommentThreadsV11,
  epicReplyToCommentThreadV10,
  epicReplyToCommentThreadV11,
  epicResolveArtifactByPathV10,
  epicResolveArtifactByPathV11,
  epicSearchArtifactsV10,
  epicSearchArtifactsV11,
  epicSetCommentThreadResolvedV10,
  epicSetCommentThreadResolvedV11,
} from "@traycer/protocol/host/epic/contracts";

/**
 * Eleven unary methods name an artifact kind. `html`, `canvas` and `file` took
 * a minor on each: 1.1 accepts or returns the new kinds, and 1.0 stays frozen
 * on the four markdown kinds, because a released peer cannot decode the rest.
 * The request upgrade is the identity: a 1.0 request is already a valid 1.1
 * request.
 */

const MINOR_BUMPED_METHODS = [
  "epic.createArtifact",
  "epic.createCommentThread",
  "epic.replyToCommentThread",
  "epic.editComment",
  "epic.deleteComment",
  "epic.setCommentThreadResolved",
  "epic.deleteCommentThread",
  "epic.listCommentThreads",
  "epic.resolveArtifactByPath",
  "epic.searchArtifacts",
  "comments.listThreads",
] as const;

// Methods whose RESPONSE carries a kind: the host filters new-kind rows out for
// a 1.0 peer, so the registry has to say the growth is emission-gated.
const RESPONSE_GROWTH_METHODS = [
  "epic.resolveArtifactByPath",
  "epic.searchArtifacts",
  "comments.listThreads",
] as const;

const NEW_KINDS = ["html", "canvas", "file"] as const;

describe("artifact-kind unary minors: registry shape", () => {
  it.each(MINOR_BUMPED_METHODS)(
    "%s keeps 1.0 installed and takes 1.1 above it",
    (method) => {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(1);
      expect(line.versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(line.versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(line.versions[1].contract.schemaVersion).toEqual({
        major: 1,
        minor: 1,
      });
      expect(line.versions[1].upgradeFromPreviousVersion).not.toBeNull();
    },
  );

  it.each(MINOR_BUMPED_METHODS)(
    "%s declares response growth only when its response carries a kind",
    (method) => {
      const entry = hostRpcRegistry[method][1].versions[1];
      const gated =
        "responseGrowthProjectionGated" in entry &&
        entry.responseGrowthProjectionGated === true;
      expect(gated).toBe(
        RESPONSE_GROWTH_METHODS.some((growing) => growing === method),
      );
    },
  );
});

describe("epic.createArtifact@1.1", () => {
  const request = {
    epicId: "epic-1",
    parentId: null,
    artifactType: "spec" as const,
    title: "A page",
  };

  it("upgrades a 1.0 request and a 1.0 response as the identity", () => {
    const upgrade =
      hostRpcRegistry["epic.createArtifact"][1].versions[1]
        .upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(epicCreateArtifactV10.requestSchema.parse(request)).toEqual(request);
    expect(upgrade.upgradeRequest(request)).toBe(request);
    expect(
      epicCreateArtifactV11.requestSchema.safeParse(
        upgrade.upgradeRequest(request),
      ).success,
    ).toBe(true);
  });

  it.each(NEW_KINDS)(
    "1.1 accepts creating a %s artifact, where 1.0 refuses the kind",
    (kind) => {
      const newKindRequest = { ...request, artifactType: kind };
      expect(
        epicCreateArtifactV11.requestSchema.safeParse(newKindRequest).success,
      ).toBe(true);
      expect(
        epicCreateArtifactV10.requestSchema.safeParse(newKindRequest).success,
      ).toBe(false);
    },
  );
});

describe("epic.createCommentThread@1.1", () => {
  const request = {
    epicId: "epic-1",
    artifactType: "spec" as const,
    artifactId: "artifact-1",
    content: { type: "doc" as const, content: [] },
    quotedText: "quoted",
  };

  it("upgrades a 1.0 request as the identity", () => {
    const upgrade =
      hostRpcRegistry["epic.createCommentThread"][1].versions[1]
        .upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(
      epicCreateCommentThreadV10.requestSchema.safeParse(request).success,
    ).toBe(true);
    expect(upgrade.upgradeRequest(request)).toBe(request);
    expect(
      epicCreateCommentThreadV11.requestSchema.safeParse(
        upgrade.upgradeRequest(request),
      ).success,
    ).toBe(true);
  });

  it.each(NEW_KINDS)(
    "1.1 accepts a comment on a %s artifact, where 1.0 refuses the kind",
    (kind) => {
      const newKindRequest = { ...request, artifactType: kind };
      expect(
        epicCreateCommentThreadV11.requestSchema.safeParse(newKindRequest)
          .success,
      ).toBe(true);
      expect(
        epicCreateCommentThreadV10.requestSchema.safeParse(newKindRequest)
          .success,
      ).toBe(false);
    },
  );
});

interface RequestParser {
  safeParse(input: unknown): { success: boolean };
}

interface CommentThreadMethodCase {
  method: string;
  frozenRequest: RequestParser;
  latestRequest: RequestParser;
  // A valid 1.0 request for the method, with a markdown artifact kind.
  request: Record<string, unknown>;
}

const COMMENT_CONTENT = { type: "doc" as const, content: [] };
const COMMENT_THREAD_ADDRESS = {
  epicId: "epic-1",
  artifactType: "spec" as const,
  artifactId: "artifact-1",
};

const COMMENT_THREAD_METHOD_CASES: readonly CommentThreadMethodCase[] = [
  {
    method: "epic.createCommentThread",
    frozenRequest: epicCreateCommentThreadV10.requestSchema,
    latestRequest: epicCreateCommentThreadV11.requestSchema,
    request: {
      ...COMMENT_THREAD_ADDRESS,
      content: COMMENT_CONTENT,
      quotedText: "q",
    },
  },
  {
    method: "epic.replyToCommentThread",
    frozenRequest: epicReplyToCommentThreadV10.requestSchema,
    latestRequest: epicReplyToCommentThreadV11.requestSchema,
    request: {
      ...COMMENT_THREAD_ADDRESS,
      threadId: "thread-1",
      content: COMMENT_CONTENT,
    },
  },
  {
    method: "epic.editComment",
    frozenRequest: epicEditCommentV10.requestSchema,
    latestRequest: epicEditCommentV11.requestSchema,
    request: {
      ...COMMENT_THREAD_ADDRESS,
      threadId: "thread-1",
      commentId: "comment-1",
      content: COMMENT_CONTENT,
    },
  },
  {
    method: "epic.deleteComment",
    frozenRequest: epicDeleteCommentV10.requestSchema,
    latestRequest: epicDeleteCommentV11.requestSchema,
    request: {
      ...COMMENT_THREAD_ADDRESS,
      threadId: "thread-1",
      commentId: "comment-1",
    },
  },
  {
    method: "epic.setCommentThreadResolved",
    frozenRequest: epicSetCommentThreadResolvedV10.requestSchema,
    latestRequest: epicSetCommentThreadResolvedV11.requestSchema,
    request: {
      ...COMMENT_THREAD_ADDRESS,
      threadId: "thread-1",
      resolved: true,
    },
  },
  {
    method: "epic.deleteCommentThread",
    frozenRequest: epicDeleteCommentThreadV10.requestSchema,
    latestRequest: epicDeleteCommentThreadV11.requestSchema,
    request: { ...COMMENT_THREAD_ADDRESS, threadId: "thread-1" },
  },
  {
    method: "epic.listCommentThreads",
    frozenRequest: epicListCommentThreadsV10.requestSchema,
    latestRequest: epicListCommentThreadsV11.requestSchema,
    request: { ...COMMENT_THREAD_ADDRESS },
  },
];

describe("comment-thread requests that name a kind", () => {
  it("covers every comment-thread method the registry bumped", () => {
    const bumpedCommentMethods = MINOR_BUMPED_METHODS.filter((method) =>
      /^epic\.[a-zA-Z]*Comment/.test(method),
    );
    expect(COMMENT_THREAD_METHOD_CASES.map((entry) => entry.method)).toEqual(
      bumpedCommentMethods,
    );
    expect(COMMENT_THREAD_METHOD_CASES).toHaveLength(7);
  });

  describe.each(COMMENT_THREAD_METHOD_CASES)("$method", (entry) => {
    it("accepts a markdown kind on both minors", () => {
      expect(entry.frozenRequest.safeParse(entry.request).success).toBe(true);
      expect(entry.latestRequest.safeParse(entry.request).success).toBe(true);
    });

    it.each(NEW_KINDS)(
      "1.1 accepts artifactType %s, where 1.0 refuses it",
      (kind) => {
        const newKindRequest = { ...entry.request, artifactType: kind };
        expect(entry.latestRequest.safeParse(newKindRequest).success).toBe(
          true,
        );
        expect(entry.frozenRequest.safeParse(newKindRequest).success).toBe(
          false,
        );
      },
    );
  });
});

describe("epic.searchArtifacts filters.kinds", () => {
  const request = {
    epicId: "epic-1",
    query: "needle",
    fields: { title: true, path: true, body: true },
    filters: { kinds: ["spec"], statuses: null, subtreePath: null },
    limit: 10,
  };

  it("accepts a markdown kind filter on both minors", () => {
    expect(
      epicSearchArtifactsV10.requestSchema.safeParse(request).success,
    ).toBe(true);
    expect(
      epicSearchArtifactsV11.requestSchema.safeParse(request).success,
    ).toBe(true);
  });

  it.each(NEW_KINDS)(
    "1.1 accepts a %s kind filter, where 1.0 refuses it",
    (kind) => {
      const newKindRequest = {
        ...request,
        filters: { ...request.filters, kinds: ["spec", kind] },
      };
      expect(
        epicSearchArtifactsV11.requestSchema.safeParse(newKindRequest).success,
      ).toBe(true);
      expect(
        epicSearchArtifactsV10.requestSchema.safeParse(newKindRequest).success,
      ).toBe(false);
    },
  );
});

describe("responses that name a kind", () => {
  it.each(NEW_KINDS)(
    "epic.resolveArtifactByPath@1.1 returns a %s artifact, where 1.0 cannot",
    (kind) => {
      const response = { artifact: { artifactId: "artifact-1", kind } };
      expect(
        epicResolveArtifactByPathV11.responseSchema.safeParse(response).success,
      ).toBe(true);
      expect(
        epicResolveArtifactByPathV10.responseSchema.safeParse(response).success,
      ).toBe(false);
      // "Not an artifact" stays representable on the frozen line.
      expect(
        epicResolveArtifactByPathV10.responseSchema.safeParse({
          artifact: null,
        }).success,
      ).toBe(true);
    },
  );

  it.each(NEW_KINDS)(
    "epic.searchArtifacts@1.1 returns a %s hit, where 1.0 cannot",
    (kind) => {
      const hit = {
        artifactId: "artifact-1",
        kind,
        title: "A page",
        status: null,
        relativePath: "pages/a-page",
        breadcrumb: [],
        sources: ["title"],
        score: 0.5,
        snippets: [],
      };
      const response = { outcome: "ready", results: [hit], truncated: false };
      expect(
        epicSearchArtifactsV11.responseSchema.safeParse(response).success,
      ).toBe(true);
      expect(
        epicSearchArtifactsV10.responseSchema.safeParse(response).success,
      ).toBe(false);
    },
  );

  it.each(NEW_KINDS)(
    "comments.listThreads@1.1 lists a %s artifact, where 1.0 cannot",
    (kind) => {
      const response = {
        artifacts: [
          {
            artifactPath: "pages/a-page",
            kind,
            title: "A page",
            warning: null,
            threads: [],
          },
        ],
      };
      expect(
        commentsListThreadsV11.responseSchema.safeParse(response).success,
      ).toBe(true);
      expect(
        commentsListThreadsV10.responseSchema.safeParse(response).success,
      ).toBe(false);
    },
  );
});
