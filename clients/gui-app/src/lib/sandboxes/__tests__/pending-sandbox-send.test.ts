import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  confirmPendingSandboxSendEpic,
  endPendingSandboxSend,
  handPendingSandboxSend,
  pickedRunSettings,
  requestedAgentReadiness,
  returnPendingSandboxMessage,
  returnPendingSandboxSend,
  returnPendingSandboxSendToSandbox,
} from "@/lib/sandboxes/pending-sandbox-send";
import { takeReturnedSandboxRestored } from "@/lib/sandboxes/returned-sandbox";
import {
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
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
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import * as promptHandoff from "@/lib/drafts/unrecorded-prompt-handoff";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { recordMapStorageKey } from "@/lib/persist/keys";
import { runSilentCapableEpicTerminalCreate } from "@/lib/terminals/epic-terminal-silent-create";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  harnessRow,
  opencodeProviderRow,
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
  it.each([
    [{ status: "downloading", percent: 40 }, "waiting"],
    [
      {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: null,
      },
      "setup-failed",
    ],
  ] satisfies ReadonlyArray<readonly [ProviderManagedInstallState, string]>)(
    "requires Managed 2 for a sibling even when OpenCode's external v2 is runnable: %j",
    (state, kind) => {
      const engine = opencodeProviderRow(state, {
        selected: { kind: "custom", path: "/custom/opencode" },
        candidates: [
          {
            kind: "custom",
            path: "/custom/opencode",
            available: true,
            version: "2.0.0",
            versionPending: false,
          },
        ],
      });
      expect(
        requestedAgentReadiness(
          "traycer",
          [harnessRow("traycer", {})],
          [engine],
          null,
        ).kind,
      ).toBe(kind);
      expect(
        requestedAgentReadiness(
          "opencode",
          [harnessRow("opencode", {})],
          [engine],
          null,
        ),
      ).toEqual({ kind: "ready", opencodeLine: 2 });
    },
  );

  it.each(["traycer", "openrouter", "huggingface", "opencode"] as const)(
    "waits for the exact engine %s will launch rather than its legacy installed pack",
    (harnessId) => {
      expect(
        requestedAgentReadiness(
          harnessId,
          [harnessRow(harnessId, {})],
          [
            ...(harnessId === "opencode"
              ? []
              : [providerRow(harnessId, { status: "installed" })]),
            opencodeProviderRow({ status: "downloading", percent: 40 }, {}),
          ],
          null,
        ),
      ).toEqual({ kind: "waiting" });
    },
  );

  it.each([
    [
      "availability pending",
      opencodeProviderRow(
        { status: "installed" },
        { availabilityPending: true },
      ),
    ],
    ["null state", opencodeProviderRow(null, {})],
    ["queued install", opencodeProviderRow({ status: "absent" }, {})],
    [
      "absent lines",
      opencodeProviderRow({ status: "installed" }, { managedLines: undefined }),
    ],
    [
      "empty lines",
      opencodeProviderRow({ status: "installed" }, { managedLines: [] }),
    ],
    ["absent engine provider", undefined],
  ] as const)("waits for positive engine proof: %s", (_label, engine) => {
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [
          providerRow("traycer", { status: "installed" }),
          ...(engine === undefined ? [] : [engine]),
        ],
        null,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it.each(["unavailable candidate", "pending version"] as const)(
    "waits despite an installed line with an %s",
    (reason) => {
      const engine = opencodeProviderRow({ status: "installed" }, {});
      engine.managedLines = engine.managedLines?.map((entry) => ({
        ...entry,
        candidate: {
          ...entry.candidate,
          available: reason !== "unavailable candidate",
          versionPending: reason === "pending version",
        },
      }));
      expect(
        requestedAgentReadiness(
          "traycer",
          [harnessRow("traycer", {})],
          [engine],
          null,
        ),
      ).toEqual({ kind: "waiting" });
    },
  );

  it("uses the destination's explicit line for a new chat and the recorded line for a bound chat", () => {
    const engine = opencodeProviderRow(
      { status: "downloading", percent: 40 },
      { selected: { kind: "bundled", line: 1 } },
    );
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [engine],
        null,
      ),
    ).toEqual({ kind: "ready", opencodeLine: 1 });
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [engine],
        2,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it.each(["path", "custom"] as const)(
    "uses a proven %s engine's version, and waits for its probe",
    (kind) => {
      const selected: ProviderCliState["selected"] =
        kind === "path" ? { kind } : { kind, path: "/custom/opencode" };
      const candidate: ProviderCliCandidate = {
        kind,
        path: "/custom/opencode",
        available: true,
        version: "1.5.0",
        versionPending: false,
      };
      const engine = opencodeProviderRow(
        { status: "downloading", percent: 40 },
        { selected, candidates: [candidate], managedLines: [] },
      );
      expect(
        requestedAgentReadiness(
          "opencode",
          [harnessRow("opencode", {})],
          [engine],
          null,
        ),
      ).toEqual({ kind: "ready", opencodeLine: 1 });
      expect(
        requestedAgentReadiness(
          "opencode",
          [harnessRow("opencode", {})],
          [{ ...engine, candidates: [{ ...candidate, versionPending: true }] }],
          null,
        ),
      ).toEqual({ kind: "waiting" });
      expect(
        requestedAgentReadiness(
          "opencode",
          [harnessRow("opencode", {})],
          [{ ...engine, candidates: [{ ...candidate, version: null }] }],
          null,
        ),
      ).toEqual({ kind: "waiting" });
    },
  );

  it("requires a line-1 sibling's own external proof rather than OpenCode's external candidate", () => {
    const candidate: ProviderCliCandidate = {
      kind: "path",
      path: "/external/opencode",
      available: true,
      version: "1.5.0",
      versionPending: false,
    };
    const engine = opencodeProviderRow(null, {
      selected: { kind: "path" },
      candidates: [candidate],
      managedLines: [],
    });
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [engine],
        null,
      ),
    ).toEqual({ kind: "waiting" });
    const sibling: ProviderCliState = {
      ...providerRow("traycer", null),
      selected: { kind: "path" },
      candidates: [candidate],
    };
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [engine, sibling],
        null,
      ),
    ).toEqual({ kind: "ready", opencodeLine: 1 });
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", {})],
        [
          engine,
          { ...sibling, candidates: [{ ...candidate, versionPending: true }] },
        ],
        null,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("holds a bound OpenCode 2 chat on an external v1 selection, while preserving the host's opposite managed fallback", () => {
    const candidate: ProviderCliCandidate = {
      kind: "custom",
      path: "/external/opencode",
      available: true,
      version: "1.5.0",
      versionPending: false,
    };
    const engine = opencodeProviderRow(
      { status: "installed" },
      {
        selected: { kind: "custom", path: candidate.path },
        candidates: [candidate],
      },
    );
    expect(
      requestedAgentReadiness(
        "opencode",
        [harnessRow("opencode", {})],
        [engine],
        2,
      ),
    ).toEqual({ kind: "waiting" });
    expect(
      requestedAgentReadiness(
        "opencode",
        [harnessRow("opencode", {})],
        [engine],
        null,
      ),
    ).toEqual({ kind: "ready", opencodeLine: 1 });
    expect(
      requestedAgentReadiness(
        "opencode",
        [harnessRow("opencode", {})],
        [{ ...engine, candidates: [{ ...candidate, version: "2.0.0" }] }],
        1,
      ),
    ).toEqual({ kind: "ready", opencodeLine: 1 });
  });

  it("waits on a pending harness probe even when its cached availability is true", () => {
    expect(
      requestedAgentReadiness(
        "traycer",
        [harnessRow("traycer", { availabilityPending: true })],
        [
          providerRow("traycer", { status: "installed" }),
          opencodeProviderRow({ status: "installed" }, {}),
        ],
        null,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("waits until both the catalog and the provider list have answered", () => {
    expect(requestedAgentReadiness("codex", undefined, [], null)).toEqual({
      kind: "waiting",
    });
    expect(requestedAgentReadiness("codex", [], undefined, null)).toEqual({
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
        null,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("is ready for the requested agent once its pack is installed and it is available", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { available: true })],
        [providerRow("codex", { status: "installed" })],
        null,
      ),
    ).toEqual({ kind: "ready", opencodeLine: null });
  });

  it.each([
    ["pre-registry host", undefined],
    ["unmanaged provider", null],
    ["pack not cut over", { status: "absent" }],
    ["managed download", { status: "downloading", percent: 40 }],
    [
      "managed failure",
      {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: null,
      },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, ProviderManagedInstallState | null | undefined]
  >)(
    "uses the non-OpenCode CLI's executable proof while its display version is pending: %s",
    (_label, state) => {
      const provider: ProviderCliState = {
        ...providerRow("claude-code", null),
        selected: { kind: "path" },
        candidates: [
          {
            kind: "path",
            path: "/usr/local/bin/claude",
            available: true,
            version: null,
            versionPending: true,
          },
        ],
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
        managedInstallState: state,
      };
      expect(
        requestedAgentReadiness(
          "claude",
          [harnessRow("claude", {})],
          [provider],
          null,
        ),
      ).toEqual({ kind: "ready", opencodeLine: null });
      expect(
        requestedAgentReadiness(
          "claude",
          [harnessRow("claude", {})],
          [{ ...provider, availabilityPending: true }],
          null,
        ),
      ).toEqual({ kind: "waiting" });
    },
  );

  it("waits while the requested agent's availability is still being probed", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { available: false, availabilityPending: true })],
        [providerRow("codex", null)],
        null,
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
        null,
      ),
    ).toEqual({ kind: "unusable" });
  });

  it("distinguishes an unoffered agent from one the sandbox has turned off", () => {
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("claude", {})],
        [providerRow("codex", null)],
        null,
      ),
    ).toEqual({ kind: "not-offered" });
    expect(
      requestedAgentReadiness(
        "codex",
        [harnessRow("codex", { enabled: false })],
        [providerRow("codex", null)],
        null,
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
      null,
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

  it("returns a send to the task composer when its only modal patch is a caret", async () => {
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
    useNewConversationModalStore.getState().resetForTests();
    try {
      signInAsPendingSendOwner();
      useNewConversationModalStore
        .getState()
        .setSelection("epic-1", { from: 1, to: 1 });
      usePendingSandboxSendStore.getState().add(pendingSend({ id: "send-1" }));
      const owner = holdPendingSandboxSendOwnership("send-1");
      try {
        expect(await owner.ready).toBe(true);

        const returned = returnPendingSandboxSend("send-1");

        expect(returned).toMatchObject({ kind: "task", epicId: "epic-1" });
        expect(
          useNewConversationModalStore.getState().draftPatchesByEpicId[
            "epic-1"
          ],
        ).toMatchObject({
          content: MESSAGE_CONTENT,
          selection: null,
          settings: PICKED_SETTINGS,
        });
        expect(useLandingDraftStore.getState().drafts).toEqual([]);
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      } finally {
        owner.release();
      }
    } finally {
      useNewConversationModalStore.getState().resetForTests();
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

describe("returnPendingSandboxSend for a message to an existing chat", () => {
  const CHAT_ID = "existing-chat";

  async function ownedMessageSend(): Promise<() => void> {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: "send-1",
        request: { kind: "message", chatId: CHAT_ID },
      }),
    );
    const owner = holdPendingSandboxSendOwnership("send-1");
    expect(await owner.ready).toBe(true);
    return owner.release;
  }

  const EMPTY_DOC = { type: "doc" as const, content: [] };
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

  beforeEach(() => {
    // Sibling suites leave a replacement draft in the modal store: this one
    // asserts the return touches none, so it starts from a clean one.
    useNewConversationModalStore.getState().resetForTests();
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, EMPTY_DOC, null);
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
  });

  afterEach(() => {
    if (originalLocks === undefined) {
      Reflect.deleteProperty(navigator, "locks");
    } else {
      Object.defineProperty(navigator, "locks", originalLocks);
    }
  });

  it("gives the message back to that chat's composer, and opens no new-agent modal and saves no landing draft", async () => {
    const release = await ownedMessageSend();

    const returned = await returnPendingSandboxMessage("send-1", false, true);

    expect(returned).toMatchObject({ kind: "chat", chatId: CHAT_ID });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      MESSAGE_CONTENT,
    );
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toBeUndefined();
    release();
  });

  it("keeps a newer draft in that chat's composer and saves the returned message as a closed landing draft", async () => {
    const newer = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "keep my newer draft" }],
        },
      ],
    };
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, newer, null);
    const release = await ownedMessageSend();

    const returned = await returnPendingSandboxMessage("send-1", false, true);

    expect(returned.kind).toBe("landing-draft");
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      newer,
    );
    const saved = useLandingDraftStore.getState().drafts;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      settings: PICKED_SETTINGS,
      closed: true,
    });
    // The handoff appends its Unsent qualification, so the original text is
    // retained rather than the document being equal to it.
    expect(JSON.stringify(saved[0]?.content)).toContain("fix the login bug");
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    release();
  });

  describe("on the chat's sandbox, when the chat's composer holds a newer draft", () => {
    const CHAT_SANDBOX: Extract<StagedSandboxTarget, { kind: "existing" }> = {
      kind: "existing",
      hostId: "sandbox-host",
      sandboxId: "sandbox-1",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    };

    beforeEach(() => {
      useComposerDraftStore.getState().replaceDraft(
        CHAT_ID,
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "keep my newer draft" }],
            },
          ],
        },
        null,
      );
    });

    async function ownedMessageOnItsSandbox(
      stopRequested: boolean,
    ): Promise<() => void> {
      const release = await ownedMessageSend();
      const surfaceKey = pendingSendSurfaceKey("send-1");
      const staged = useStagedSandboxStore.getState();
      staged.stage(surfaceKey, CHAT_SANDBOX);
      staged.report(surfaceKey, {
        clientRequestId: "key-1",
        createdSandboxId: CHAT_SANDBOX.sandboxId,
        createdHostId: CHAT_SANDBOX.hostId,
      });
      if (stopRequested) {
        const { sends } = usePendingSandboxSendStore.getState();
        if (!Object.hasOwn(sends, "send-1"))
          throw new Error("expected the send");
        const send = sends["send-1"];
        usePendingSandboxSendStore.setState({
          sends: { ...sends, "send-1": { ...send, stopRequested } },
        });
      }
      return release;
    }

    it("keeps the sandbox on the landing draft it saves", async () => {
      const release = await ownedMessageOnItsSandbox(false);

      const returned = await returnPendingSandboxMessage("send-1", false, true);

      if (returned.kind !== "landing-draft")
        throw new Error("expected a landing draft");
      expect(
        useLandingDraftStore
          .getState()
          .drafts.find((draft) => draft.id === returned.draftId)
          ?.returnedSandbox,
      ).toMatchObject({ target: CHAT_SANDBOX, clientRequestId: null });
      release();
    });

    it("puts the sandbox on the landing draft as soon as it is listed, while its image reads are still outstanding", async () => {
      const release = await ownedMessageOnItsSandbox(false);
      // The handoff's image reads outlive its bound: the text-only draft is
      // installed and listed in Drafts, and the reads are still running.
      const reads = Promise.withResolvers<void>();
      const listed = Promise.withResolvers<string>();
      vi.spyOn(
        promptHandoff,
        "buildUnrecordedPromptHandoff",
      ).mockImplementation((args) => {
        const recovery = args.recovery;
        if (recovery === undefined) throw new Error("expected a recovery");
        useLandingDraftStore.getState().installLandingDraft({
          id: recovery.draftId,
          content: args.content,
          selection: null,
          lastTouchedAt: 1,
          settings: recovery.settings,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          closed: true,
        });
        listed.resolve(recovery.draftId);
        return Promise.resolve({
          draftId: recovery.draftId,
          readsSettled: reads.promise,
        });
      });
      const returning = returnPendingSandboxMessage("send-1", false, true);
      try {
        const draftId = await listed.promise;

        // Opened from Drafts now, its Send goes to the chat's sandbox.
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((draft) => draft.id === draftId)?.returnedSandbox,
        ).toMatchObject({ target: CHAT_SANDBOX, clientRequestId: null });
        // The pending copy and its images stay until the reads settle.
        expect(
          usePendingSandboxSendStore.getState().sends["send-1"],
        ).toBeDefined();
      } finally {
        reads.resolve();
        await returning;
        vi.restoreAllMocks();
        release();
      }
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    it.each([
      ["after a Stop", true, true],
      ["when the person chose another host", false, false],
    ])(
      "keeps no sandbox on the landing draft %s",
      async (_label, stopRequested, keepsSandbox) => {
        const release = await ownedMessageOnItsSandbox(stopRequested);

        const returned = await returnPendingSandboxMessage(
          "send-1",
          false,
          keepsSandbox,
        );

        if (returned.kind !== "landing-draft")
          throw new Error("expected a landing draft");
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((draft) => draft.id === returned.draftId)
            ?.returnedSandbox,
        ).toBeNull();
        release();
      },
    );
  });
});

/**
 * A give-back writes only the record on the draft that takes the message:
 * the composer showing that draft stages it. Nothing is staged or marked on
 * the composer's surface; an awake sandbox is also the task composer's host.
 */
describe("a message given back to its task's composer on its sandbox", () => {
  const TASK_SURFACE = newConversationSurfaceKey("epic-1");
  const SANDBOX: Extract<StagedSandboxTarget, { kind: "existing" }> = {
    kind: "existing",
    hostId: "sandbox-host",
    sandboxId: "sandbox-1",
    name: "build-box",
    configuration: { kind: "personal" },
    verb: "resume",
  };
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

  beforeEach(() => {
    useNewConversationModalStore.getState().resetForTests();
    useSurfaceHostSelectionStore.setState({ selections: {} });
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
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
  });

  afterEach(() => {
    if (originalLocks === undefined) {
      Reflect.deleteProperty(navigator, "locks");
    } else {
      Object.defineProperty(navigator, "locks", originalLocks);
    }
  });

  async function owned(): Promise<() => void> {
    usePendingSandboxSendStore.getState().add(pendingSend({ id: "send-1" }));
    const owner = holdPendingSandboxSendOwnership("send-1");
    expect(await owner.ready).toBe(true);
    return owner.release;
  }

  function taskRecord() {
    return useNewConversationModalStore.getState().draftPatchesByEpicId[
      "epic-1"
    ]?.returnedSandbox;
  }

  it("records an awake sandbox on the task draft and makes it the composer's host, staging nothing", async () => {
    const release = await owned();

    expect(
      returnPendingSandboxSendToSandbox("send-1", {
        kind: "host",
        target: SANDBOX,
      }).kind,
    ).toBe("task");

    expect(taskRecord()).toMatchObject({
      target: SANDBOX,
      clientRequestId: null,
    });
    expect(
      useSurfaceHostSelectionStore.getState().selections[TASK_SURFACE],
    ).toBe(SANDBOX.hostId);
    expect(readStagedSandbox(TASK_SURFACE)).toBeNull();
    release();
  });

  it.each([
    ["a resting sandbox", { target: SANDBOX, clientRequestId: null }],
    [
      "a create the server may have accepted",
      {
        target: NEW_TARGET,
        clientRequestId: "key-1",
      },
    ],
  ])(
    "records %s on the task draft, and stages, marks and pins nothing",
    async (_label, destination) => {
      const release = await owned();

      expect(
        returnPendingSandboxSendToSandbox("send-1", {
          kind: "stage",
          ...destination,
        }).kind,
      ).toBe("task");

      expect(taskRecord()).toMatchObject(destination);
      expect(readStagedSandbox(TASK_SURFACE)).toBeNull();
      expect(takeReturnedSandboxRestored(TASK_SURFACE, destination)).toBe(
        false,
      );
      expect(
        useSurfaceHostSelectionStore.getState().selections[TASK_SURFACE],
      ).toBeUndefined();
      release();
    },
  );
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
