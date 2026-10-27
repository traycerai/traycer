import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  buildUnrecordedPromptHandoff,
  type PromptHandoffOutcome,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import {
  pendingSandboxRecoveryDraftId,
  returnPendingSandboxMessage,
} from "@/lib/sandboxes/pending-sandbox-send";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
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

const handoff = vi.mocked(buildUnrecordedPromptHandoff);

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

    const returned = await returnPendingSandboxMessage(SEND_ID, false);

    expect(returned).toMatchObject({ kind: "chat", chatId: CHAT_ID });
    const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(draft?.content).toEqual(MESSAGE_CONTENT);
    expect(draft?.browserAnnotations).toEqual([ANNOTATION]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    release();
  });

  it("answers the same promise to a second Cancel while the first is still returning", async () => {
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });

    const first = returnPendingSandboxMessage(SEND_ID, false);
    const second = returnPendingSandboxMessage(SEND_ID, false);

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

    await returnPendingSandboxMessage(SEND_ID, false);

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

    await returnPendingSandboxMessage(SEND_ID, false);

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

    await returnPendingSandboxMessage(SEND_ID, false);

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      MESSAGE_CONTENT,
    );
    release();
  });
});

describe("returnPendingSandboxMessage through the unrecorded-prompt handoff", () => {
  it("hands an occupied composer's message over with its stable recovery draft and keeps the pending record until the import and its reads settle", async () => {
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, OCCUPIED_DOC, null);
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
      browserAnnotations: [ANNOTATION],
    });
    const outcome = deferred<PromptHandoffOutcome>();
    const reads = deferred<void>();
    handoff.mockReturnValue(outcome.promise);

    const returning = returnPendingSandboxMessage(SEND_ID, false);

    expect(handoff).toHaveBeenCalledTimes(1);
    const input = handoff.mock.calls[0][0];
    expect(input.recovery).toEqual({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      settings: PICKED_SETTINGS,
    });
    expect(input.content).toEqual(MESSAGE_CONTENT);
    expect(input.browserAnnotations).toEqual([ANNOTATION]);
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
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    handoff.mockResolvedValue({
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
      readsSettled: Promise.resolve(),
    });

    const returned = await returnPendingSandboxMessage(SEND_ID, true);

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
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    const outcome = deferred<PromptHandoffOutcome>();
    handoff.mockReturnValue(outcome.promise);

    const first = returnPendingSandboxMessage(SEND_ID, false);
    const second = returnPendingSandboxMessage(SEND_ID, false);

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
    const release = await ownedMessageSend({
      kind: "message",
      chatId: CHAT_ID,
    });
    const outcome = deferred<PromptHandoffOutcome>();
    handoff.mockReturnValue(outcome.promise);

    const returning = returnPendingSandboxMessage(SEND_ID, true);

    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.returnRequested,
    ).toEqual({ saveInDrafts: true });
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
    const release = await ownedMessageSend({
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

    const returned = await returnPendingSandboxMessage(SEND_ID, false);

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
    const release = await ownedMessageSend({
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

    const returned = await returnPendingSandboxMessage(SEND_ID, false);

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
