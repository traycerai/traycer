/**
 * A message given back to a saved draft keeps its pending copy until that
 * draft is saved. The real handoff and the real stores throughout; the only
 * fake is the browser's storage refusing the landing drafts' snapshot, the
 * way a full quota does.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pendingSandboxRecoveryDraftId,
  resumePendingSandboxMessageReturn,
  returnPendingSandboxMessage,
} from "@/lib/sandboxes/pending-sandbox-send";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  LANDING_DRAFT_PERSIST_KEY,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { pendingSend } from "./pending-send-fixtures";

const CHAT_ID = "chat-1";
const SEND_ID = "send-1";
const CHAT_SANDBOX: Extract<StagedSandboxTarget, { kind: "existing" }> = {
  kind: "existing",
  hostId: "sandbox-host",
  sandboxId: "sandbox-1",
  name: "build-box",
  configuration: { kind: "personal" },
  verb: "resume",
};
const NEWER_DRAFT = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: "keep my newer draft" }],
    },
  ],
};
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

/** The landing drafts' snapshot does not fit; every other key does. */
function refuseLandingDraftWrites(): () => void {
  const write = localStorage.setItem.bind(localStorage);
  const refuse = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation((name, value) => {
      if (name === LANDING_DRAFT_PERSIST_KEY)
        throw new DOMException("No room", "QuotaExceededError");
      write(name, value);
    });
  return () => refuse.mockRestore();
}

/**
 * A new window: both stores' rows are read back from storage, replacing
 * memory's. Not cleared by `setState` first, which would write the empty
 * state to storage too.
 */
async function reload(): Promise<void> {
  await useLandingDraftStore.persist.rehydrate();
  await usePendingSandboxSendStore.persist.rehydrate();
}

async function owned(): Promise<() => void> {
  const owner = holdPendingSandboxSendOwnership(SEND_ID);
  expect(await owner.ready).toBe(true);
  return owner.release;
}

beforeEach(() => {
  localStorage.clear();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
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
  // A message to an existing chat, on that chat's sandbox, whose composer
  // now holds newer text: Cancel saves it as a draft.
  useComposerDraftStore.getState().replaceDraft(CHAT_ID, NEWER_DRAFT, null);
  usePendingSandboxSendStore.getState().add(
    pendingSend({
      id: SEND_ID,
      request: { kind: "message", chatId: CHAT_ID },
    }),
  );
  const staged = useStagedSandboxStore.getState();
  staged.stage(pendingSendSurfaceKey(SEND_ID), CHAT_SANDBOX);
  staged.report(pendingSendSurfaceKey(SEND_ID), {
    createdSandboxId: CHAT_SANDBOX.sandboxId,
    createdHostId: CHAT_SANDBOX.hostId,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLocks === undefined) {
    Reflect.deleteProperty(navigator, "locks");
  } else {
    Object.defineProperty(navigator, "locks", originalLocks);
  }
});

it("keeps the pending message and its return through a reload when its draft cannot be saved, and saves it once storage has room", async () => {
  const release = await owned();
  const allowWrites = refuseLandingDraftWrites();
  try {
    await expect(
      returnPendingSandboxMessage(SEND_ID, false, true),
    ).rejects.toThrow("No room");
  } finally {
    allowWrites();
    release();
  }

  await reload();

  // Nothing was saved in Drafts, and the message is still pending, with the
  // return it began.
  expect(useLandingDraftStore.getState().drafts).toEqual([]);
  const kept = usePendingSandboxSendStore.getState().sends[SEND_ID];
  expect(kept.returnRequested).toEqual({
    saveInDrafts: true,
    destination: { target: CHAT_SANDBOX, clientRequestId: null },
  });

  // Its replay saves the draft, on the chat's sandbox, and only then ends it.
  const replayRelease = await owned();
  try {
    const returned = await resumePendingSandboxMessageReturn(SEND_ID);
    expect(returned).toEqual({
      kind: "landing-draft",
      draftId: pendingSandboxRecoveryDraftId(SEND_ID),
    });
  } finally {
    replayRelease();
  }
  expect(usePendingSandboxSendStore.getState().sends).toEqual({});
  await reload();
  expect(useLandingDraftStore.getState().drafts).toMatchObject([
    {
      id: pendingSandboxRecoveryDraftId(SEND_ID),
      returnedSandbox: { target: CHAT_SANDBOX, clientRequestId: null },
    },
  ]);
});
