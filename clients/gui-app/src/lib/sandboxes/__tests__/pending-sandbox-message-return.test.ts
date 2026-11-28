import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  buildUnrecordedPromptHandoff,
  type PromptHandoffOutcome,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { composerCanvasAnnotationsKey } from "@/lib/persist";
import { setMobileApp } from "@/lib/mobile-app";
import { canvasAnnotationRecordSchema } from "@traycer/protocol/persistence/epic/schemas";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import {
  readSavedWholeDraft,
  saveUnsentWholeDraft,
} from "@/lib/drafts/save-unsent-whole-draft";
import {
  draftComposerHeadSchemaV11,
  projectDraftRunSettingsV11,
  type DraftComposerHeadV11,
} from "@traycer/protocol/persistence/draft/schemas";
import {
  DRAFT_HEAD_DIALECT,
  DRAFT_HEAD_SCHEMA_VERSION_V11,
} from "@traycer/protocol/persistence/draft/version";
import {
  pendingSandboxRecoveryDraftId,
  resumePendingSandboxMessageReturn,
  returnPendingSandboxMessage,
} from "@/lib/sandboxes/pending-sandbox-send";
import { handLandingSandboxSend } from "@/components/home/hooks/landing-sandbox-send-handoff";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  pendingSend,
} from "./pending-send-fixtures";

vi.mock("@/lib/drafts/unrecorded-prompt-handoff", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/drafts/unrecorded-prompt-handoff")
  >()),
  buildUnrecordedPromptHandoff: vi.fn(),
}));

// Defaults to the real save: only the whole-draft case below swaps it.
vi.mock("@/lib/drafts/save-unsent-whole-draft", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/save-unsent-whole-draft")
    >();
  return {
    ...actual,
    saveUnsentWholeDraft: vi.fn(actual.saveUnsentWholeDraft),
    readSavedWholeDraft: vi.fn(actual.readSavedWholeDraft),
  };
});

const handoff = vi.mocked(buildUnrecordedPromptHandoff);
const saveWhole = vi.mocked(saveUnsentWholeDraft);
const readSaved = vi.mocked(readSavedWholeDraft);

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const OCCUPIED_DOC = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: "keep my newer draft" }],
    },
  ],
};

/**
 * Cancelling a pending message to an existing chat returns it asynchronously:
 * to that chat's own composer when it is free (with the sidecars and a
 * qualification of what the pending send carried that cannot return), or
 * through the unrecorded-prompt handoff to a saved draft when it is not.
 * Real stores throughout; a focused file because the handoff and the image
 * reads are the only boundaries it may need to hold.
 */

const CHAT_ID = "existing-chat";
const SEND_ID = "send-1";

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "annotation-1",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.test",
  pageUrl: "https://example.test/page",
  pageTitle: "Example",
  source: {
    kind: "browser",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/page",
    pageTitle: "Example",
  },
  capturedAt: 1,
  comment: "this button",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "c".repeat(64),
  droppedElementCount: 0,
};

const CANVAS_CARD = canvasAnnotationRecordSchema.parse({
  kind: "browser-annotation",
  annotationId: "canvas-card",
  source: {
    kind: "canvas",
    artifactId: "artifact-1",
    boardPath: "boards/home.html",
    canvasPage: null,
    artifactTitle: "Study",
  },
  capturedAt: 1,
  comment: "note",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: null,
  imageHash: null,
});

const INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat-staged",
        source: "main",
        carryUncommittedChanges: false,
      },
    },
  ],
};

const EMPTY_DOC = { type: "doc" as const, content: [] };
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

async function ownedMessageSend(
  request: Parameters<typeof pendingSend>[0]["request"],
): Promise<() => void> {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
      [],
    );
  usePendingSandboxSendStore
    .getState()
    .add(pendingSend({ id: SEND_ID, request }));
  const owner = holdPendingSandboxSendOwnership(SEND_ID);
  expect(await owner.ready).toBe(true);
  return owner.release;
}

beforeEach(() => {
  handoff.mockReset();
  // Restores the real implementations the factory wrapped.
  saveWhole.mockReset();
  readSaved.mockReset();
  localStorage.clear();
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  // clearDraft drops the annotation sidecar too: an earlier case's annotations
  // would otherwise make this composer read as occupied.
  useComposerDraftStore.getState().clearDraft(CHAT_ID);
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

describe("returnPendingSandboxMessage into a free chat composer", () => {
  it("returns the text and its annotations to that chat, names the chat, and removes the pending record", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      browserAnnotations: [ANNOTATION],
    });

    const returned = await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(returned).toMatchObject({ kind: "chat", chatId: CHAT_ID });
    const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(draft?.content).toEqual(MESSAGE_CONTENT);
    expect(draft?.browserAnnotations).toEqual([ANNOTATION]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    release();
  });

  it("on the installed phone keeps the pending send when the Canvas sidecar cannot be written, then returns the exact card on retry", async () => {
    setMobileApp(true);
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      browserAnnotations: [CANVAS_CARD],
    });
    const realSetItem = Storage.prototype.setItem.bind(window.localStorage);
    // Only the sidecar's own write fails; the pending record still persists.
    const blocked = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key, value) => {
        if (key === composerCanvasAnnotationsKey("mobile")) {
          throw new Error("quota");
        }
        realSetItem(key, value);
      });
    try {
      expect(await returnPendingSandboxMessage(SEND_ID, false, true)).toEqual({
        kind: "none",
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      const untouched = useComposerDraftStore.getState().drafts[CHAT_ID];
      expect(untouched?.browserAnnotations ?? []).toEqual([]);
      expect(untouched?.content).toEqual(EMPTY_DOC);

      blocked.mockRestore();
      expect(await resumePendingSandboxMessageReturn(SEND_ID)).toMatchObject({
        kind: "chat",
        chatId: CHAT_ID,
      });
      const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
      expect(draft?.browserAnnotations).toEqual([CANVAS_CARD]);
      expect(draft?.content).toEqual(MESSAGE_CONTENT);
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    } finally {
      blocked.mockRestore();
      setMobileApp(false);
      release();
    }
  });

  it("answers the same promise to a second Cancel while the first is still returning", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });

    const first = returnPendingSandboxMessage(SEND_ID, false, true);
    const second = returnPendingSandboxMessage(SEND_ID, false, true);

    expect(second).toBe(first);
    await first;
    expect(Object.keys(useComposerDraftStore.getState().drafts)).toContain(
      CHAT_ID,
    );
    release();
  });

  it("never wakes or stages again: a returned message leaves no staged sandbox and no pending record behind", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      worktreeIntent: INTENT,
    });

    await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
    release();
  });
});

describe("returnPendingSandboxMessage qualifies what cannot come back", () => {
  it("appends the staged worktree paths and branch and a re-pick to the restored text, and stages nothing", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      worktreeIntent: INTENT,
    });

    await returnPendingSandboxMessage(SEND_ID, false, true);

    const rendered = JSON.stringify(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.content,
    );
    expect(rendered).toContain("/repo");
    expect(rendered).toContain("feat-staged");
    expect(rendered.toLowerCase()).toContain("pick");
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
    release();
  });

  it("leaves a message without a worktree intent unqualified", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });

    await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      MESSAGE_CONTENT,
    );
    release();
  });
});

const FILE_CONTENT: JsonContent = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph" as const,
      content: [
        {
          type: "fileAttachment" as const,
          attrs: {
            id: "file-1",
            hash: "e".repeat(64),
            fileName: "notes.txt",
            mediaType: "text/plain",
            size: 3,
          },
        },
      ],
    },
  ],
};

async function ownedFileMessageSend(
  request: Parameters<typeof pendingSend>[0]["request"],
): Promise<() => void> {
  const release = await ownedMessageSend(request);
  usePendingSandboxSendStore.setState((state) => ({
    sends: {
      ...state.sends,
      [SEND_ID]: { ...state.sends[SEND_ID], content: FILE_CONTENT },
    },
  }));
  return release;
}

describe("returnPendingSandboxMessage through the unrecorded-prompt handoff", () => {
  // A native app returns locally a message that names a file.
  beforeEach(() => setMobileApp(true));
  afterEach(() => setMobileApp(false));

  it("hands an occupied composer's message over with its stable recovery draft and keeps the pending record until the import and its reads settle", async () => {
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, OCCUPIED_DOC, null);
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      browserAnnotations: [CANVAS_CARD],
    });
    const outcome = deferred<PromptHandoffOutcome>();
    const reads = deferred<void>();
    handoff.mockReturnValue(outcome.promise);

    const returning = returnPendingSandboxMessage(SEND_ID, false, true);

    expect(handoff).toHaveBeenCalledTimes(1);
    const input = handoff.mock.calls[0][0];
    expect(input.recovery).toEqual({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      settings: PICKED_SETTINGS,
    });
    expect(input.content).toEqual(FILE_CONTENT);
    expect(input.browserAnnotations).toEqual([CANVAS_CARD]);
    expect(input.reasonIsRemovedProfile).toBe(false);
    // Held: the record is still the message's only copy.
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    outcome.resolve({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: reads.promise,
    });
    await Promise.resolve();
    await Promise.resolve();
    // The text is installed but the image reads are not done: still held.
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    reads.resolve();
    const returned = await returning;
    expect(returned).toEqual({
      kind: "landing-draft",
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    release();
  });

  it("a background Stop (saveInDrafts) always takes the handoff, even for an empty composer", async () => {
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    handoff.mockResolvedValue({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });

    const returned = await returnPendingSandboxMessage(SEND_ID, true, true);

    expect(returned).toEqual({
      kind: "landing-draft",
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
    });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      EMPTY_DOC,
    );
    release();
  });

  it("a second Cancel while the import is held joins the first promise and starts no second handoff", async () => {
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, OCCUPIED_DOC, null);
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    const outcome = deferred<PromptHandoffOutcome>();
    handoff.mockReturnValue(outcome.promise);

    const first = returnPendingSandboxMessage(SEND_ID, false, true);
    const second = returnPendingSandboxMessage(SEND_ID, false, true);

    expect(second).toBe(first);
    expect(handoff).toHaveBeenCalledTimes(1);
    outcome.resolve({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });
    await first;
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    release();
  });

  it("persists returnRequested before the import starts, so a reload can resume it", async () => {
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, OCCUPIED_DOC, null);
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    const outcome = deferred<PromptHandoffOutcome>();
    handoff.mockReturnValue(outcome.promise);

    const returning = returnPendingSandboxMessage(SEND_ID, true, true);

    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.returnRequested,
    ).toEqual({ saveInDrafts: true, destination: null });
    // Settle it: a per-id return left pending would be joined by every later
    // case that reuses this send id.
    outcome.resolve({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });
    await returning;
    release();
  });
  it("a replayed return requested without saving still takes the handoff when a newer draft now holds the composer", async () => {
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    usePendingSandboxSendStore.setState((state) => ({
      sends: {
        ...state.sends,
        [SEND_ID]: {
          ...state.sends[SEND_ID],
          returnRequested: { saveInDrafts: false },
        },
      },
    }));
    // The person typed something new after the first request was recorded.
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, OCCUPIED_DOC, null);
    handoff.mockResolvedValue({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });

    const returned = await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(returned).toEqual({
      kind: "landing-draft",
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
    });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      OCCUPIED_DOC,
    );
    release();
  });
  it("an ended send (its host row gone) takes the handoff to a saved draft even for an empty composer", async () => {
    const release = await ownedFileMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    usePendingSandboxSendStore.setState((state) => ({
      sends: {
        ...state.sends,
        [SEND_ID]: { ...state.sends[SEND_ID], ended: true },
      },
    }));
    handoff.mockResolvedValue({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });

    const returned = await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(returned).toEqual({
      kind: "landing-draft",
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
    });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      EMPTY_DOC,
    );
    release();
  });
});

function savedHead() {
  const settings = projectDraftRunSettingsV11(
    { ...PICKED_SETTINGS, profileId: null },
    null,
    null,
  );
  if (settings.status !== "ready") throw new Error("settings not ready");
  return draftComposerHeadSchemaV11.parse({
    dialect: DRAFT_HEAD_DIALECT,
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION_V11,
    kind: "draft",
    surfaceKind: "landing",
    lastTouchedAt: 1_000,
    target: { epicId: null, chatId: null, blockId: null },
    hostLocal: { hostId: "pool", workspace: null },
    portable: {
      content: MESSAGE_CONTENT,
      selection: null,
      runSettings: settings.settings,
      composerMode: "chat",
      blobHashes: [ANNOTATION.imageHash],
      closed: true,
      annotations: [ANNOTATION],
    },
  });
}

describe("a new agent's whole-draft save", () => {
  it("keeps the pending send and its crop rooted until a saved head arrives, then opens one closed annotated draft and retires the send", async () => {
    const release = await ownedMessageSend({
      kind: "chat",
      parentId: null,
      placement: null,
      browserAnnotations: [ANNOTATION],
    });
    const crop = "c".repeat(64);
    const recoveryId = pendingSandboxRecoveryDraftId(SEND_ID);
    const firstSave = deferred<DraftComposerHeadV11 | null>();
    saveWhole.mockReturnValueOnce(firstSave.promise);

    const returning = returnPendingSandboxMessage(SEND_ID, false, true);
    expect(landingLiveImageRootHashes()).toContain(crop);
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    // No acknowledgement: nothing is installed and the send keeps its roots.
    firstSave.resolve(null);
    expect(await returning).toEqual({ kind: "none" });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    expect(landingLiveImageRootHashes()).toContain(crop);

    const head = savedHead();
    readSaved.mockResolvedValueOnce(null);
    saveWhole.mockResolvedValueOnce(head);
    expect(await resumePendingSandboxMessageReturn(SEND_ID)).toEqual({
      kind: "landing-draft",
      draftId: recoveryId,
    });

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: recoveryId,
      closed: true,
      wholeDraftAnnotations: [ANNOTATION],
    });
    expect(saveWhole.mock.calls.map((call) => call[0].draftId)).toEqual([
      recoveryId,
      recoveryId,
    ]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    // The draft, not the retired send, now roots the crop.
    expect(landingLiveImageRootHashes()).toContain(crop);

    // The projection belongs to the account that sent it.
    useAuthStore.getState().setSignedOut();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    release();
  });

  it("after a lost save response, a restart adopts the committed head the person edited since, and saves nothing again", async () => {
    const release = await ownedMessageSend({
      kind: "chat",
      parentId: null,
      placement: null,
      browserAnnotations: [ANNOTATION],
    });
    const recoveryId = pendingSandboxRecoveryDraftId(SEND_ID);
    // The host committed the save, but its answer never arrived.
    saveWhole.mockResolvedValueOnce(null);
    expect(await returnPendingSandboxMessage(SEND_ID, false, true)).toEqual({
      kind: "none",
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    // Meanwhile the committed draft was opened elsewhere and edited.
    const edited = draftComposerHeadSchemaV11.parse({
      ...savedHead(),
      lastTouchedAt: 2_000,
      portable: {
        ...savedHead().portable,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "edited after the save" }],
            },
          ],
        },
      },
    });
    readSaved.mockResolvedValueOnce(edited);

    expect(await resumePendingSandboxMessageReturn(SEND_ID)).toEqual({
      kind: "landing-draft",
      draftId: recoveryId,
    });
    const [draft] = useLandingDraftStore.getState().drafts;
    expect(JSON.stringify(draft.content)).toContain("edited after the save");
    expect(draft.wholeDraftAnnotations).toEqual([ANNOTATION]);
    expect(saveWhole).toHaveBeenCalledTimes(1);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    release();
  });
});

describe("where a new agent's returned message goes", () => {
  async function ownedChatSend(): Promise<() => void> {
    const release = await ownedMessageSend({
      kind: "chat",
      parentId: null,
      placement: null,
      browserAnnotations: [CANVAS_CARD],
    });
    usePendingSandboxSendStore.setState((state) => ({
      sends: {
        ...state.sends,
        [SEND_ID]: { ...state.sends[SEND_ID], content: FILE_CONTENT },
      },
    }));
    return release;
  }

  afterEach(() => setMobileApp(false));

  it("hands a native app's file nodes and local cards to the existing handoff whole, and never to the pool", async () => {
    setMobileApp(true);
    handoff.mockResolvedValue({
      draftId: "local-draft",
      readsSettled: Promise.resolve(),
    });
    const release = await ownedChatSend();

    expect(await returnPendingSandboxMessage(SEND_ID, false, true)).toEqual({
      kind: "landing-draft",
      draftId: "local-draft",
    });

    expect(handoff.mock.calls[0]?.[0]).toMatchObject({
      content: FILE_CONTENT,
      browserAnnotations: [CANVAS_CARD],
    });
    expect(saveWhole).not.toHaveBeenCalled();
    release();
  });

  it("saves a web tab's message with a file node whole, never locally", async () => {
    setMobileApp(false);
    saveWhole.mockResolvedValue(null);
    const release = await ownedChatSend();

    await returnPendingSandboxMessage(SEND_ID, false, true);

    expect(saveWhole).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
    release();
  });

  it("returns a staged whole draft under its own identity when the real landing handoff carried it, not a recovery draft", async () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
    const installed = useLandingDraftStore.getState().installLandingDraft({
      id: "source-draft",
      wholeDraftAnnotations: [CANVAS_CARD],
      content: MESSAGE_CONTENT,
      selection: null,
      lastTouchedAt: 1,
      settings: null,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: true,
      returnedSandbox: null,
      namedHostId: null,
      durability: "saved",
    });
    expect(installed).toBe(true);
    useLandingDraftStore.getState().openDraft("source-draft");
    expect(useLandingDraftStore.getState().activeDraftId).toBe("source-draft");
    useStagedSandboxStore.getState().stage("landing:window-1", {
      kind: "existing",
      hostId: "sandbox-host",
      sandboxId: "sandbox-1",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    const handoff = handLandingSandboxSend({
      fromSurfaceKey: "landing:window-1",
      epicId: "epic-1",
      content: MESSAGE_CONTENT,
      text: "notes",
      settings: PICKED_SETTINGS,
      now: 1,
      browserAnnotations: [CANVAS_CARD],
      sourceDraftId: "source-draft",
    });
    expect(handoff).not.toBeNull();
    const [handed] = Object.values(usePendingSandboxSendStore.getState().sends);
    expect(handed.request).toMatchObject({
      kind: "chat",
      sourceWholeDraftId: "source-draft",
    });
    const owner = holdPendingSandboxSendOwnership(handed.id);
    expect(await owner.ready).toBe(true);
    saveWhole.mockResolvedValue(savedHead());

    expect(await returnPendingSandboxMessage(handed.id, false, true)).toEqual({
      kind: "landing-draft",
      draftId: "source-draft",
    });
    expect(saveWhole.mock.calls[0]?.[0].draftId).toBe("source-draft");
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    owner.release();
  });
});
