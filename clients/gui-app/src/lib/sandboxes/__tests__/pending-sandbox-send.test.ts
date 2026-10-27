import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  confirmPendingSandboxSendEpic,
  endPendingSandboxSend,
  handPendingSandboxSend,
  pickedRunSettings,
  requestedAgentReadiness,
  returnPendingSandboxSend,
} from "@/lib/sandboxes/pending-sandbox-send";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { listDraftInventory } from "@/lib/drafts/draft-inventory";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { recordMapStorageKey } from "@/lib/persist/keys";
import { runSilentCapableEpicTerminalCreate } from "@/lib/terminals/epic-terminal-silent-create";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  harnessRow,
  pendingSend,
  providerRow,
} from "./pending-send-fixtures";

const SURFACE = "landing:window-1";

const DISPATCH_INPUT: PendingSandboxSendDispatch["input"] = {
  epicId: "epic-1",
  hostId: "sandbox-host",
  parentId: null,
  title: "",
  chatId: "chat-1",
  settings: PICKED_SETTINGS,
  workspaceMode: "folderless",
  worktreeIntent: null,
  initialMessage: {
    messageId: "message-1",
    clientActionId: "action-1",
    content: MESSAGE_CONTENT,
    sender: { type: "user", userId: "user-1" },
    settings: PICKED_SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
  },
};

const NEW_TARGET: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "",
  wakeString: null,
};

beforeEach(() => {
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useAuthStore.getState().setSignedOut();
});

describe("requestedAgentReadiness", () => {
  it("waits until both the catalog and the provider list have answered", () => {
    expect(requestedAgentReadiness("codex", undefined, [])).toEqual({
      kind: "waiting",
    });
    expect(requestedAgentReadiness("codex", [], undefined)).toEqual({
      kind: "waiting",
    });
  });

  it("waits while the requested agent's pack downloads, though another agent is ready", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [
          harnessRow("codex", { available: false }),
          harnessRow("claude", { available: true }),
        ],
        [
          providerRow("codex", { status: "downloading", percent: 40 }),
          providerRow("claude-code", null),
        ],
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("is ready for the requested agent once its pack is installed and it is available", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { available: true })],
        [providerRow("codex", { status: "installed" })],
      ),
    ).toEqual({ kind: "ready" });
  });

  it("waits while the requested agent's availability is still being probed", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { available: false, availabilityPending: true })],
        [providerRow("codex", null)],
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("refuses an agent that settled unavailable, and never offers another in its place", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [
          harnessRow("codex", { available: false }),
          harnessRow("claude", { available: true }),
        ],
        [providerRow("codex", null), providerRow("claude-code", null)],
      ),
    ).toEqual({ kind: "unusable" });
  });

  it("distinguishes an unoffered agent from one the sandbox has turned off", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("claude", {})],
        [providerRow("codex", null)],
      ),
    ).toEqual({ kind: "not-offered" });
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { enabled: false })],
        [providerRow("codex", null)],
      ),
    ).toEqual({ kind: "unusable" });
  });

  it("refuses an agent whose install failed with the host's own sentence", () => {
    const readiness = requestedAgentReadiness(
      "codex",
      [harnessRow("codex", { available: false })],
      [
        providerRow("codex", {
          status: "error",
          reason: "disk-full",
          message: "ENOSPC",
          retryAtMs: null,
        }),
      ],
    );

    expect(readiness.kind).toBe("setup-failed");
    if (readiness.kind !== "setup-failed") return;
    expect(readiness.detail).toContain("disk space");
  });
});

describe("handPendingSandboxSend", () => {
  function hand(fromSurfaceKey: string) {
    return handPendingSandboxSend({
      fromSurfaceKey,
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
      content: MESSAGE_CONTENT,
      text: "fix the login bug",
      settings: PICKED_SETTINGS,
      epicConfirmed: false,
      now: 5_000,
    });
  }

  it("hands nothing when the surface has no stage, or its stage is already in its handoff", () => {
    expect(hand(SURFACE)).toBeNull();

    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    useStagedSandboxStore.getState().report(SURFACE, { phase: "handoff" });
    expect(hand(SURFACE)).toBeNull();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
  });

  it("records the message and its pick, and moves the stage, create key and all, under the send", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.report(SURFACE, { ownerId: "draft-a", openTerminal: true });
    const clientRequestId = store.begin(SURFACE, false, 1_000, false);

    const id = hand(SURFACE);

    if (id === null) throw new Error("expected the send to be handed");
    expect(usePendingSandboxSendStore.getState().sends[id]).toEqual({
      id,
      userId: "user-1",
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
      content: MESSAGE_CONTENT,
      text: "fix the login bug",
      settings: PICKED_SETTINGS,
      createdAt: 5_000,
      epicConfirmed: false,
      delivery: null,
      dispatch: null,
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(readStagedSandbox(pendingSendSurfaceKey(id))).toMatchObject({
      phase: "creating",
      clientRequestId,
      sendTaken: true,
      ownerId: null,
      openTerminal: false,
      terminalLaunch: null,
    });
  });

  it("ends a send with its stage and its record, leaving the sandbox it made", () => {
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const id = hand(SURFACE);
    if (id === null) throw new Error("expected the send to be handed");

    endPendingSandboxSend(id);

    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(pendingSendSurfaceKey(id))).toBeNull();
  });
});

describe("returnPendingSandboxSend", () => {
  function signInAsPendingSendOwner(): void {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
  }

  function handUnconfirmedSend(): string {
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const id = handPendingSandboxSend({
      fromSurfaceKey: SURFACE,
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
      content: MESSAGE_CONTENT,
      text: "fix the login bug",
      settings: PICKED_SETTINGS,
      epicConfirmed: false,
      now: 5_000,
    });
    if (id === null) {
      throw new Error("expected the staged message to be handed");
    }
    return id;
  }

  function contentWith(text: string) {
    return {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text }],
        },
      ],
    };
  }

  it.each(["sending", "uncertain"] as const)(
    "does not return a send with a %s create claim",
    (status) => {
      signInAsPendingSendOwner();
      const dispatch = {
        input: DISPATCH_INPUT,
        delivery: {
          chatId: "chat-1",
          hostId: "sandbox-host",
          sandboxId: "sandbox-1",
          readySeconds: 0,
        },
        status,
      };
      const send = { ...pendingSend({ id: "send-1" }), dispatch };
      usePendingSandboxSendStore.getState().add(send);

      const returned = returnPendingSandboxSend(send.id);

      expect(returned).toEqual({ kind: "dispatching" });
      expect(
        usePendingSandboxSendStore.getState().sends[send.id],
      ).toBeDefined();
    },
  );

  it("does not return a send when persisted storage has a claim newer than memory", () => {
    signInAsPendingSendOwner();
    const send = pendingSend({ id: "send-1" });
    const dispatch = {
      input: DISPATCH_INPUT,
      delivery: {
        chatId: "chat-1",
        hostId: "sandbox-host",
        sandboxId: "sandbox-1",
        readySeconds: 0,
      },
      status: "sending" as const,
    };
    usePendingSandboxSendStore.getState().add(send);
    localStorage.setItem(
      recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), send.id),
      JSON.stringify({ ...send, dispatch }),
    );

    const returned = returnPendingSandboxSend(send.id);

    expect(returned).toEqual({ kind: "dispatching" });
    expect(usePendingSandboxSendStore.getState().sends[send.id]).toBeDefined();
  });

  it("returns a send handed here before confirmation without Web Locks", () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Reflect.deleteProperty(navigator, "locks");
    try {
      signInAsPendingSendOwner();
      const id = handUnconfirmedSend();

      const returned = returnPendingSandboxSend(id);

      expect(returned.kind).toBe("landing-draft");
      expect(usePendingSandboxSendStore.getState().sends[id]).toBeUndefined();
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
      ]);
    } finally {
      usePendingSandboxSendStore.setState({ sends: {} });
      useStagedSandboxStore.setState({ bySurface: {} });
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("keeps an unconfirmed send that this no-lock window did not hand", () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Reflect.deleteProperty(navigator, "locks");
    try {
      signInAsPendingSendOwner();
      const send = pendingSend({ id: "send-1", epicConfirmed: false });
      usePendingSandboxSendStore.getState().add(send);

      expect(returnPendingSandboxSend(send.id)).toEqual({ kind: "none" });
      expect(
        usePendingSandboxSendStore.getState().sends[send.id],
      ).toBeDefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    } finally {
      usePendingSandboxSendStore.setState({ sends: {} });
      useStagedSandboxStore.setState({ bySurface: {} });
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it.each([
    ["the owner stays signed in", false, true],
    ["the account changes before the lock is granted", true, false],
  ] as const)(
    "waits for native ownership before confirming when %s",
    async (_scenario, switchAccount, expectedConfirmed) => {
      const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
      const grantNativeLock = Promise.withResolvers<void>();
      const nativeLockReleased = Promise.withResolvers<void>();
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: (
            _name: string,
            _options: LockOptions,
            callback: () => Promise<void>,
          ) =>
            grantNativeLock.promise
              .then(callback)
              .then(() => nativeLockReleased.resolve()),
        },
      });
      try {
        signInAsPendingSendOwner();
        const id = handUnconfirmedSend();
        const owner = holdPendingSandboxSendOwnership(id);
        confirmPendingSandboxSendEpic(id);

        expect(
          usePendingSandboxSendStore.getState().sends[id]?.epicConfirmed,
        ).toBe(false);
        if (switchAccount) {
          useAuthStore
            .getState()
            .setSignedIn(
              { userId: "user-2", userName: "V", email: "v@example.com" },
              { userId: "user-2", username: "V" },
              [],
            );
        }
        grantNativeLock.resolve();
        await owner.ready;

        expect(
          usePendingSandboxSendStore.getState().sends[id]?.epicConfirmed,
        ).toBe(expectedConfirmed);
        signInAsPendingSendOwner();
        endPendingSandboxSend(id);
        owner.release();
        await nativeLockReleased.promise;
      } finally {
        grantNativeLock.resolve();
        usePendingSandboxSendStore.setState({ sends: {} });
        useStagedSandboxStore.setState({ bySurface: {} });
        if (originalLocks === undefined) {
          Reflect.deleteProperty(navigator, "locks");
        } else {
          Object.defineProperty(navigator, "locks", originalLocks);
        }
      }
    },
  );

  it("preserves an occupied task composer and puts an exclusively returned send in a fresh closed landing draft", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (
          _name: string,
          _options: LockOptions,
          callback: () => Promise<void>,
        ) => callback(),
      },
    });
    try {
      signInAsPendingSendOwner();
      const occupiedContent = {
        type: "doc" as const,
        content: [
          {
            type: "paragraph" as const,
            content: [{ type: "text" as const, text: "keep my replacement" }],
          },
        ],
      };
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", occupiedContent);
      useNewConversationModalStore.getState().setSettings("epic-1", {
        ...PICKED_SETTINGS,
        model: "a different model",
      });
      usePendingSandboxSendStore.getState().add(pendingSend({ id: "send-1" }));
      const owner = holdPendingSandboxSendOwnership("send-1");
      expect(await owner.ready).toBe(true);

      const returned = returnPendingSandboxSend("send-1");

      expect(returned.kind).toBe("landing-draft");
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({
        content: occupiedContent,
        settings: { model: "a different model" },
      });
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
      ]);
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      owner.release();
    } finally {
      usePendingSandboxSendStore.setState({ sends: {} });
      useStagedSandboxStore.setState({ bySurface: {} });
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("keeps every exclusively returned message in its own closed landing draft", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (
          _name: string,
          _options: LockOptions,
          callback: () => Promise<void>,
        ) => callback(),
      },
    });
    try {
      signInAsPendingSendOwner();
      // An existing settings-only pick is an occupied modal, even without text.
      useNewConversationModalStore
        .getState()
        .setSettings("epic-1", PICKED_SETTINGS);
      usePendingSandboxSendStore.getState().add(
        pendingSend({
          id: "send-a",
          content: contentWith("first returned message"),
          text: "first returned message",
        }),
      );
      usePendingSandboxSendStore.getState().add(
        pendingSend({
          id: "send-b",
          content: contentWith("second returned message"),
          text: "second returned message",
        }),
      );
      const firstOwner = holdPendingSandboxSendOwnership("send-a");
      const secondOwner = holdPendingSandboxSendOwnership("send-b");
      expect(await firstOwner.ready).toBe(true);
      expect(await secondOwner.ready).toBe(true);

      const first = returnPendingSandboxSend("send-a");
      const second = returnPendingSandboxSend("send-b");

      expect(first.kind).toBe("landing-draft");
      expect(second.kind).toBe("landing-draft");
      if (first.kind !== "landing-draft" || second.kind !== "landing-draft") {
        throw new Error("expected landing drafts");
      }
      expect(first.draftId).not.toBe(second.draftId);
      const rows = listDraftInventory({
        scope: { surface: "landing", activeDraftId: null },
        filter: "current",
        landing: useLandingDraftStore.getState().drafts,
        composer: {},
        newChat: {},
        openChatIds: new Set(),
        liveSessionHostIds: new Set(),
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.draftId,
            kind: "landing",
            preview: "first returned message",
            open: false,
          }),
          expect.objectContaining({
            id: second.draftId,
            kind: "landing",
            preview: "second returned message",
            open: false,
          }),
        ]),
      );
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      firstOwner.release();
      secondOwner.release();
    } finally {
      usePendingSandboxSendStore.setState({ sends: {} });
      useStagedSandboxStore.setState({ bySurface: {} });
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });
});

describe("runSilentCapableEpicTerminalCreate", () => {
  it("adopts the durable terminal the host already created after a duplicate create refusal", async () => {
    const scope = { kind: "epic" as const, epicId: "epic-1" };
    const terminal: PlainTerminalProjection = {
      record: {
        terminalId: "terminal-pending-send",
        hostId: mockLocalHostEntry.hostId,
        scope,
        launch: {
          cwd: "/home/sandbox",
          shellCommand: "/bin/zsh",
          shellArgs: [],
        },
        manualTitle: null,
        revision: 1,
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      },
      runtime: { status: "dormant" },
    };
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "terminal-request",
      handlers: {
        "terminal.plain.create": () => {
          throw new Error("terminal already exists");
        },
        "terminal.plain.list": () => ({
          coverage: "complete-fleet",
          scope,
          terminals: [terminal],
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(new QueryClient()),
      messenger,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );

    await expect(
      runSilentCapableEpicTerminalCreate({
        client: spine.createRequester(mockLocalHostEntry),
        request: {
          terminalId: terminal.record.terminalId,
          scope,
          cwd: "/home/sandbox",
          cols: 80,
          rows: 24,
        },
      }),
    ).resolves.toEqual(terminal);
    expect(messenger.calls.map((call) => call.method)).toEqual([
      "terminal.plain.create",
      "terminal.plain.list",
    ]);
  });
});

describe("pickedRunSettings", () => {
  const SHOWN = {
    harnessId: "claude" as const,
    modelSlug: "claude-sonnet",
    profileId: null,
  };

  it("carries the agent the person picked, not the one this host's toolbar shows in its place", () => {
    expect(
      pickedRunSettings({
        values: {
          selection: {
            harnessId: "codex",
            modelSlug: "gpt-6.1-sol",
            profileId: null,
          },
          permission: "supervised",
          reasoning: "high",
          serviceTier: "",
        },
        selection: SHOWN,
        permission: "full_access",
        reasoning: "low",
        serviceTier: "fast",
      }),
    ).toEqual(PICKED_SETTINGS);
  });

  it("takes the model and settings shown for the same agent when the pick has no model yet", () => {
    expect(
      pickedRunSettings({
        values: {
          selection: { harnessId: "claude", modelSlug: "", profileId: null },
          permission: "supervised",
          reasoning: "high",
          serviceTier: "",
        },
        selection: SHOWN,
        permission: "full_access",
        reasoning: "low",
        serviceTier: "",
      }),
    ).toMatchObject({
      harnessId: "claude",
      model: "claude-sonnet",
      permissionMode: "full_access",
      reasoningEffort: "low",
    });
  });
});

describe("the pick through the run toolbar store, as a sandbox's catalog answers", () => {
  function model(
    harnessId: ModelOption["harnessId"],
    slug: string,
  ): ModelOption {
    return {
      harnessId,
      slug,
      label: slug,
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      defaultServiceTier: null,
      supportedServiceTiers: [],
      deprecationNotice: null,
      metadata: {},
    };
  }

  // A just-created sandbox: Codex's pack is still preparing, so it settles
  // unavailable with nothing pending, and Claude is the only agent ready.
  it("keeps Codex · GPT-6.1-Sol · High when the sandbox's catalog shows Codex unavailable and swaps another agent into the toolbar", () => {
    const store = createComposerToolbarStore({
      purpose: "run",
      reasoningFallback: "model-default",
      seedKey: "landing",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "codex",
          modelSlug: "gpt-6.1-sol",
          profileId: null,
        },
        reasoning: "high",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: "sbx-host",
    });

    store.getState().setCatalog({
      hostId: "sbx-host",
      chatLineCarriesAutoMode: null,
      keepsUnavailablePick: false,
      harnesses: [
        harnessRow("codex", { available: false }),
        harnessRow("claude", { available: true }),
      ],
      modelsHarnessId: "claude",
      models: [model("claude", "claude-sonnet")],
      modelsLoaded: true,
      tuiOnly: false,
    });

    // The toolbar shows the first agent this host can run in Codex's place...
    expect(store.getState().selection.harnessId).toBe("claude");
    // ...and the send still carries the person's own pick.
    expect(pickedRunSettings(store.getState())).toEqual(PICKED_SETTINGS);
  });
});
