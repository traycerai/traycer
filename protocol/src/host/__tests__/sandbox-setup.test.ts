import { describe, expect, it } from "vitest";
import {
  buildConnectionManifest,
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  checkCompatibility,
} from "@traycer/protocol/framework/index";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  sandboxSetupCurrentChatV10,
  sandboxSetupStartRequestSchema,
  sandboxSetupStartResponseSchema,
  sandboxSetupSubscribeOpenRequestSchema,
  sandboxSetupSubscribeServerFrameSchema,
  sandboxSetupVersionActionRequestSchema,
} from "../sandbox-setup";
import {
  desktop154SandboxSetupCatalog,
  sandboxSetupChat,
  sandboxSetupHiddenPanel,
  sandboxSetupId,
  sandboxSetupPanel,
  sandboxSetupQuestions,
  sandboxSetupSettingsHandover,
  sandboxSetupStartRequests,
  sandboxSetupStartResults,
  sandboxSetupTaskCards,
  sandboxSetupTaskFrames,
  sandboxSetupToolSwitch,
  sandboxSetupVersionActions,
  sandboxSetupRunningCard,
  sandboxSetupVersionId,
  sandboxSetupContinueOffer,
  sandboxSetupOtherPersonBusyOffer,
  sandboxSetupOutOfDateVersionFrames,
  sandboxSetupOperationIds,
} from "./__fixtures__/sandbox-setup";

describe("sandbox setup frames", () => {
  it("uses the same offer frame after a normal action or a worktree failure", () => {
    const normalOffer = sandboxSetupSubscribeServerFrameSchema.parse(
      sandboxSetupTaskFrames.offerWithoutSetupChat,
    );
    const besideWorktreeFailureOffer =
      sandboxSetupSubscribeServerFrameSchema.parse({
        ...sandboxSetupTaskFrames.worktreeFailureOffer,
      });

    expect(besideWorktreeFailureOffer).toEqual(normalOffer);
    expect(normalOffer).toMatchObject({
      kind: "task",
      state: { cards: [{ kind: "offer" }] },
    });
  });

  it("carries offer picker presence and absence through setupChat", () => {
    const withoutPicker = sandboxSetupSubscribeServerFrameSchema.parse(
      sandboxSetupTaskFrames.offerWithoutSetupChat,
    );
    const withPicker = sandboxSetupSubscribeServerFrameSchema.parse(
      sandboxSetupTaskFrames.offerWithSetupChat,
    );

    expect(withoutPicker).toMatchObject({ state: { setupChat: null } });
    expect(withPicker).toMatchObject({
      state: { setupChat: sandboxSetupChat },
    });
  });

  it("shows the same question on the running task card and setup panel", () => {
    const task = sandboxSetupSubscribeServerFrameSchema.parse(
      sandboxSetupTaskFrames.runningWithQuestion,
    );
    const panel = sandboxSetupSubscribeServerFrameSchema.parse({
      kind: "setup",
      hasBinaryPayload: false,
      state: sandboxSetupPanel,
    });

    expect(task).toMatchObject({
      state: {
        cards: [
          {
            kind: "running",
            progress: { question: sandboxSetupQuestions.ordinary },
          },
        ],
      },
    });
    expect(panel).toMatchObject({
      kind: "setup",
      state: {
        card: {
          kind: "running",
          progress: { question: sandboxSetupQuestions.ordinary },
        },
      },
    });
  });

  it("accepts ordinary, secret, and tool-version question actions", () => {
    for (const question of Object.values(sandboxSetupQuestions)) {
      expect(
        sandboxSetupSubscribeServerFrameSchema.safeParse({
          kind: "task",
          hasBinaryPayload: false,
          state: {
            setupChat: sandboxSetupChat,
            cards: [
              {
                ...sandboxSetupRunningCard,
                progress: { ...sandboxSetupRunningCard.progress, question },
              },
            ],
            toolSwitches: [],
          },
        }).success,
      ).toBe(true);
    }
  });

  it("represents every check result and secrets as presence only", () => {
    const parsedPanel = sandboxSetupSubscribeServerFrameSchema.parse({
      kind: "setup",
      hasBinaryPayload: false,
      state: sandboxSetupPanel,
    });
    expect(parsedPanel).toMatchObject({
      state: {
        checks: [
          { result: "running" },
          { result: "passed" },
          { result: "failed" },
          { result: "skipped" },
        ],
        secrets: [
          { name: "NPM_TOKEN", set: false },
          { name: "DEPLOY_TOKEN", set: true },
        ],
      },
    });
  });

  it("covers approved and tool updates", () => {
    const state = sandboxSetupSubscribeServerFrameSchema.parse({
      kind: "task",
      hasBinaryPayload: false,
      state: {
        setupChat: sandboxSetupChat,
        cards: [sandboxSetupTaskCards.approved],
        toolSwitches: [sandboxSetupToolSwitch],
      },
    });
    expect(state).toMatchObject({
      state: {
        cards: [{ kind: "approved" }],
        toolSwitches: [
          {
            changes: [{ tool: "node", previous: "20.0.0", current: "22.0.0" }],
          },
        ],
      },
    });
  });

  it("keeps Continue offer context person-read and sends only its linked version context", () => {
    const offer = sandboxSetupSubscribeServerFrameSchema.parse(
      sandboxSetupContinueOffer.frame,
    );
    const request = sandboxSetupStartRequestSchema.parse(
      sandboxSetupContinueOffer.hostAction,
    );

    expect(offer).toMatchObject({ state: { cards: [{ kind: "offer" }] } });
    expect(request.source).toEqual({
      kind: "continue",
      ...sandboxSetupContinueOffer.personRead,
    });
  });

  it("keeps the offer visible while another person's setup is already running", () => {
    expect(
      sandboxSetupSubscribeServerFrameSchema.parse(
        sandboxSetupOtherPersonBusyOffer.frame,
      ),
    ).toMatchObject({ state: { setupChat: null, cards: [{ kind: "offer" }] } });
    expect(
      sandboxSetupStartRequestSchema.parse(
        sandboxSetupOtherPersonBusyOffer.hostAction,
      ),
    ).toEqual(sandboxSetupOtherPersonBusyOffer.hostAction);
    expect(
      sandboxSetupStartResponseSchema.parse(
        sandboxSetupOtherPersonBusyOffer.hostResult,
      ),
    ).toEqual({ kind: "refused", code: "setup_already_running" });
  });

  it("links ready, waiting, and out-of-date frames to the same version", () => {
    const frames = sandboxSetupOutOfDateVersionFrames.map((frame) =>
      sandboxSetupSubscribeServerFrameSchema.parse(frame),
    );
    expect(frames).toMatchObject([
      { state: { cards: [{ kind: "ready", versionId: expect.any(String) }] } },
      {
        state: { cards: [{ kind: "waiting", versionId: expect.any(String) }] },
      },
      {
        state: {
          cards: [{ kind: "out-of-date", versionId: expect.any(String) }],
        },
      },
    ]);
    const versionIds = frames.flatMap((frame) =>
      frame.kind === "task" && frame.state !== null
        ? frame.state.cards.flatMap((card) =>
            "versionId" in card ? [card.versionId] : [],
          )
        : [],
    );
    expect(versionIds).toEqual([
      sandboxSetupVersionId,
      sandboxSetupVersionId,
      sandboxSetupVersionId,
    ]);
  });

  it("clears hidden and unavailable task and panel views", () => {
    expect(
      sandboxSetupSubscribeServerFrameSchema.parse(
        sandboxSetupTaskFrames.unavailable,
      ),
    ).toEqual(sandboxSetupTaskFrames.unavailable);
    expect(
      sandboxSetupSubscribeServerFrameSchema.parse({
        kind: "setup",
        hasBinaryPayload: false,
        state: sandboxSetupHiddenPanel,
      }),
    ).toMatchObject({ kind: "setup", state: { card: null } });
    expect(
      sandboxSetupSubscribeServerFrameSchema.parse({
        kind: "setup",
        hasBinaryPayload: false,
        state: null,
      }),
    ).toEqual({ kind: "setup", hasBinaryPayload: false, state: null });
  });
});

describe("sandbox setup actions and return branches", () => {
  it("parses each start source including Continue context and Fix handover", () => {
    for (const request of Object.values(sandboxSetupStartRequests)) {
      expect(sandboxSetupStartRequestSchema.parse(request)).toEqual(request);
    }
  });

  it("uses one settings handover and one setup chat across three checked-out repositories", () => {
    const requests = sandboxSetupSettingsHandover.requests.map((request) =>
      sandboxSetupStartRequestSchema.parse(request),
    );
    const results = sandboxSetupSettingsHandover.results.map((result) =>
      sandboxSetupStartResponseSchema.parse(result),
    );
    const retry = sandboxSetupStartRequestSchema.parse(
      sandboxSetupSettingsHandover.retryRequest,
    );

    expect(new Set(requests.map((request) => request.setupId))).toEqual(
      new Set([sandboxSetupId]),
    );
    expect(new Set(requests.map((request) => request.repository.repo))).toEqual(
      new Set(["traycer", "website", "docs"]),
    );
    const operationIds = requests.map((request) => request.operationId);
    expect(operationIds).toEqual([
      sandboxSetupOperationIds.handoverTraycer,
      sandboxSetupOperationIds.handoverWebsite,
      sandboxSetupOperationIds.handoverDocs,
    ]);
    expect(new Set(operationIds).size).toBe(3);
    expect(retry.operationId).toBe(operationIds[0]);
    expect(
      new Set(
        results.map((result) =>
          result.kind === "accepted" ? result.setupChat.chatId : "",
        ),
      ),
    ).toEqual(new Set([sandboxSetupChat.chatId]));
  });

  it("accepts the successful start result and every refusal code", () => {
    for (const result of Object.values(sandboxSetupStartResults)) {
      expect(sandboxSetupStartResponseSchema.parse(result)).toEqual(result);
    }
  });

  it("accepts each version-action outcome and both guarded refusals", () => {
    for (const action of Object.values(sandboxSetupVersionActions)) {
      expect(sandboxSetupVersionActionRequestSchema.parse(action)).toEqual(
        action,
      );
    }
  });

  it("keeps task/setup subscription opens distinct and current chat nullable", () => {
    expect(
      sandboxSetupSubscribeOpenRequestSchema.parse({
        kind: "task",
        epicId: "epic-1",
      }),
    ).toEqual({
      kind: "task",
      epicId: "epic-1",
    });
    expect(
      sandboxSetupSubscribeOpenRequestSchema.parse({
        ...sandboxSetupChat,
        kind: "setup",
      }),
    ).toEqual({ ...sandboxSetupChat, kind: "setup" });
    expect(
      sandboxSetupCurrentChatV10.responseSchema.parse({ setupChat: null }),
    ).toEqual({
      setupChat: null,
    });
  });
});

describe("Desktop 1.5.4 released compatibility", () => {
  it("negotiates released unary and stream catalog entries with production compatibility functions", () => {
    const currentUnary = buildConnectionManifest(
      hostRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const currentStreams = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const oldUnaryConnection = selectConnectionManifestForPeer(
      hostRpcRegistry,
      { "terminal.list": currentUnary["terminal.list"] },
      desktop154SandboxSetupCatalog.unary,
    );
    const releasedStreamPeer = desktop154SandboxSetupCatalog.stream;
    const oldStreamOpenAck = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      { "chat.subscribe": currentStreams["chat.subscribe"] },
      releasedStreamPeer,
    );

    expect(oldUnaryConnection["terminal.list"]).toMatchObject({
      major: 1,
      minor: 0,
    });
    expect(
      checkCompatibility(
        hostRpcRegistry,
        oldUnaryConnection,
        desktop154SandboxSetupCatalog.unary,
        "host",
      ),
    ).toEqual({ ok: true });
    expect(
      checkCompatibility(
        hostRpcRegistry,
        desktop154SandboxSetupCatalog.unary,
        oldUnaryConnection,
        "client",
      ),
    ).toEqual({ ok: true });

    expect(oldStreamOpenAck["chat.subscribe"]).toEqual(
      currentStreams["chat.subscribe"],
    );
    expect(Object.keys(oldStreamOpenAck)).not.toContain(
      "sandboxSetup.subscribe",
    );
    expect(Object.keys(releasedStreamPeer)).not.toContain(
      "sandboxSetup.subscribe",
    );
    expect(currentStreams["sandboxSetup.subscribe"]).toBeDefined();
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        oldStreamOpenAck,
        releasedStreamPeer,
        "host",
        "chat.subscribe",
      ),
    ).toEqual({ ok: true });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        releasedStreamPeer,
        oldStreamOpenAck,
        "client",
        "chat.subscribe",
      ),
    ).toEqual({ ok: true });
  });

  it("keeps sandbox setup unary methods optional and its stream sibling off the old floor", () => {
    const methodNames = [
      "sandboxSetup.currentChat",
      "sandboxSetup.start",
      "sandboxSetup.versionAction",
    ] as const;
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    for (const method of methodNames) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(split.manifest[method]).toBeUndefined();
      expect(split.optionalManifest[method]).toEqual({ major: 1, minor: 0 });
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    }
    expect(Object.keys(desktop154SandboxSetupCatalog.stream)).not.toContain(
      "sandboxSetup.subscribe",
    );
  });
});
