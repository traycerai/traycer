import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  commentsListThreadsV10,
  commentsListThreadsV11,
  commentsListThreadsV12,
} from "@traycer/protocol/host/comments/contracts";
import {
  epicCreateArtifactV10,
  epicCreateArtifactV11,
  epicCreateCommentThreadV10,
  epicCreateCommentThreadV11,
  epicCreateCommentThreadV12,
  epicDeleteCommentThreadV10,
  epicDeleteCommentThreadV11,
  epicDeleteCommentV10,
  epicDeleteCommentV11,
  epicEditCommentV10,
  epicEditCommentV11,
  epicListCommentThreadsV10,
  epicListCommentThreadsV11,
  epicListCommentThreadsV12,
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

// Comment anchors took a second minor (1.2) on the methods whose request
// carries one or whose response lists threads, and the canvas-point anchor
// a third (1.3).
const ANCHOR_MINOR_METHODS: readonly string[] = [
  "epic.createCommentThread",
  "epic.listCommentThreads",
  "comments.listThreads",
];

describe("artifact-kind unary minors: registry shape", () => {
  it.each(MINOR_BUMPED_METHODS)(
    "%s keeps 1.0 installed and takes 1.1 above it",
    (method) => {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(
        ANCHOR_MINOR_METHODS.includes(method) ? 3 : 1,
      );
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

describe("anchor fields on listed threads", () => {
  const thread = {
    threadId: "thread-1",
    resolved: false,
    createdAt: 1,
    comments: [],
    data: { createdByUserId: "user-1" },
  };
  const anchoredData = {
    anchorKind: "text" as const,
    artboard: "board-1",
    elementId: "tid-1",
    startOffset: 2,
    endOffset: 9,
    label: "Hero heading",
  };
  const anchoredThread = {
    ...thread,
    data: { ...thread.data, ...anchoredData },
  };

  it("1.2 returns the anchor fields on a thread of epic.listCommentThreads", () => {
    const parsed = epicListCommentThreadsV12.responseSchema.parse({
      threads: [anchoredThread],
    });
    expect(parsed.threads[0]?.data).toMatchObject(anchoredData);
  });

  it("1.1 of epic.listCommentThreads stays frozen and drops the anchor fields", () => {
    const parsed = epicListCommentThreadsV11.responseSchema.parse({
      threads: [anchoredThread],
    });
    expect(parsed.threads[0]?.data).toEqual(thread.data);
  });

  it("1.2 still reads a thread that carries no anchor", () => {
    const parsed = epicListCommentThreadsV12.responseSchema.parse({
      threads: [thread],
    });
    expect(parsed.threads[0]?.data).toEqual(thread.data);
  });

  it("1.2 refuses a negative anchor offset or an unknown anchor kind", () => {
    for (const data of [
      { ...anchoredThread.data, startOffset: -1 },
      { ...anchoredThread.data, anchorKind: "page" },
    ]) {
      expect(
        epicListCommentThreadsV12.responseSchema.safeParse({
          threads: [{ ...thread, data }],
        }).success,
      ).toBe(false);
    }
  });

  describe("comments.listThreads", () => {
    const response = {
      artifacts: [
        {
          artifactPath: "pages/a-page",
          kind: "html",
          title: "A page",
          warning: null,
          threads: [
            {
              thread: anchoredThread,
              anchorStatus: "missing",
              anchorOrder: null,
              anchorWarning: null,
            },
          ],
        },
      ],
    };

    it("1.2 returns the anchor fields next to the computed anchor status", () => {
      const parsed = commentsListThreadsV12.responseSchema.parse(response);
      const listed = parsed.artifacts[0]?.threads[0];
      expect(listed?.anchorStatus).toBe("missing");
      expect(listed?.thread.data).toMatchObject(anchoredData);
    });

    it("1.1 stays frozen and drops the anchor fields but keeps the status", () => {
      const parsed = commentsListThreadsV11.responseSchema.parse(response);
      const listed = parsed.artifacts[0]?.threads[0];
      expect(listed?.anchorStatus).toBe("missing");
      expect(listed?.thread.data).toEqual(thread.data);
    });
  });
});

describe("epic.createCommentThread@1.2", () => {
  const request = {
    epicId: "epic-1",
    artifactType: "html" as const,
    artifactId: "artifact-1",
    content: { type: "doc" as const, content: [] },
    quotedText: "quoted",
  };
  const element = {
    kind: "element" as const,
    artboard: "board-1",
    elementId: "tid-1",
    label: "Hero heading",
  };
  const text = {
    kind: "text" as const,
    artboard: "board-1",
    elementId: "tid-1",
    label: "Hero heading",
    startOffset: 2,
    endOffset: 9,
  };

  it("takes 1.2 above 1.1 in the registry", () => {
    const line = hostRpcRegistry["epic.createCommentThread"][1];
    expect(line.latestMinor).toBe(3);
    expect(line.versions[2].contract.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
  });

  it("makes the anchor optional, so a request without one still parses", () => {
    expect(
      epicCreateCommentThreadV12.requestSchema.safeParse(request).success,
    ).toBe(true);
  });

  it.each([
    ["artifact", { kind: "artifact" as const }],
    ["element", element],
    ["text", text],
  ])("1.2 accepts a %s anchor and keeps it", (_name, anchor) => {
    const parsed = epicCreateCommentThreadV12.requestSchema.parse({
      ...request,
      anchor,
    });
    expect(parsed.anchor).toEqual(anchor);
  });

  it.each([
    ["an unknown kind", { kind: "page" }],
    ["an element anchor without a label", { ...element, label: undefined }],
    [
      "an element anchor without an artboard",
      { ...element, artboard: undefined },
    ],
    [
      "an element anchor without an element id",
      { ...element, elementId: undefined },
    ],
    ["a text anchor without offsets", { ...text, startOffset: undefined }],
    ["a negative start offset", { ...text, startOffset: -1 }],
    ["a fractional start offset", { ...text, startOffset: 1.5 }],
    [
      "an end offset before the start",
      { ...text, startOffset: 5, endOffset: 4 },
    ],
  ])("1.2 refuses %s", (_name, anchor) => {
    expect(
      epicCreateCommentThreadV12.requestSchema.safeParse({
        ...request,
        anchor,
      }).success,
    ).toBe(false);
  });

  it("accepts a collapsed text range, where the end equals the start", () => {
    expect(
      epicCreateCommentThreadV12.requestSchema.safeParse({
        ...request,
        anchor: { ...text, startOffset: 4, endOffset: 4 },
      }).success,
    ).toBe(true);
  });

  it("1.1 stays frozen: it strips the anchor instead of carrying it", () => {
    const parsed = epicCreateCommentThreadV11.requestSchema.parse({
      ...request,
      anchor: element,
    });
    expect(parsed).toEqual(request);
    expect("anchor" in parsed).toBe(false);
  });

  it("upgrades a 1.1 request as the identity", () => {
    const upgrade =
      hostRpcRegistry["epic.createCommentThread"][1].versions[2]
        .upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.1 to 1.2 upgrade path");
    const parsed = epicCreateCommentThreadV11.requestSchema.parse(request);
    const upgraded = upgrade.upgradeRequest(parsed);
    expect(upgraded).toBe(parsed);
    expect(
      epicCreateCommentThreadV12.requestSchema.safeParse(upgraded).success,
    ).toBe(true);
  });
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
    latestRequest: epicCreateCommentThreadV12.requestSchema,
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
    latestRequest: epicListCommentThreadsV12.requestSchema,
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
