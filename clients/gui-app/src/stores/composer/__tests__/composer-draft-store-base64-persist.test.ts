import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useComposerDraftStore } from "../composer-draft-store";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";

function pendingB64ImageDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "pending-node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 12,
              byHashEligible: true,
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        ],
      },
    ],
  };
}

function persistedDraftsFromLocalStorage(): Record<string, unknown> {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  if (raw === null) throw new Error("expected persisted drafts");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "object" ||
    parsed.state === null
  ) {
    throw new Error("unexpected persisted shape");
  }
  const state = (parsed as { state: { drafts?: unknown } }).state;
  const drafts = state.drafts;
  if (typeof drafts !== "object" || drafts === null) {
    throw new Error("expected drafts map");
  }
  return drafts as Record<string, unknown>;
}

function containsB64String(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsB64String);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, v]) => {
      if (key === "b64content" && typeof v === "string" && v.length > 0) {
        return true;
      }
      return containsB64String(v);
    });
  }
  return false;
}

beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
});

afterEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
});

describe("composer draft store: base64 strip at the persist boundary", () => {
  it("persists a hash-only shape while the in-memory draft keeps the pending b64 node", () => {
    const taskId = "chat-with-pending-image";
    const content = pendingB64ImageDoc();
    useComposerDraftStore.getState().setSnapshot(taskId, content, null);

    // The write already happened synchronously via zustand's persist
    // middleware subscription; drive partialize directly too, matching what
    // that subscription serializes, so the assertion is against the exact
    // function under test rather than an incidental side effect.
    const options = useComposerDraftStore.persist.getOptions();
    const partialized = options.partialize?.(useComposerDraftStore.getState());
    expect(partialized).toBeDefined();
    if (partialized === undefined) return;

    // (a) The PERSISTED shape carries no b64content anywhere.
    expect(containsB64String(partialized.drafts[taskId])).toBe(false);
    const persistedContent = partialized.drafts[taskId]?.content;
    expect(persistedContent).toBeDefined();
    expect(JSON.stringify(persistedContent)).not.toContain("b64content");

    // (b) What actually landed in localStorage matches partialize's output
    // for the b64 absence property, proving the seam that fires the write
    // matches what we drove directly above.
    const fromStorage = persistedDraftsFromLocalStorage();
    expect(containsB64String(fromStorage[taskId])).toBe(false);

    // (c) The LIVE in-memory store still holds the original pending b64
    // node — it is the ingest job's work token, and stripping it in memory
    // would break the background ingest / remount re-entry.
    const live = useComposerDraftStore.getState().drafts[taskId];
    expect(live).toBeDefined();
    if (live === undefined) return;
    expect(containsB64String(live.content)).toBe(true);
    expect(live.content).toEqual(content);
  });

  it("drops the caret when the strip removes a node, and keeps it when it does not", () => {
    // A selection is a pair of ProseMirror positions, and positions count
    // nodes. The persisted document is one node shorter than the one these
    // positions were measured in, so carrying the caret across restores it
    // somewhere else in the text on the next launch - or out of range.
    //
    // Both halves matter. Dropping the caret unconditionally would be its own
    // regression (every ordinary draft would forget where the user was), so the
    // control below is the same assertion for a draft with nothing to strip.
    const pendingId = "chat-caret-after-pending-image";
    const caret = { from: 4, to: 4 };
    useComposerDraftStore
      .getState()
      .setSnapshot(pendingId, pendingB64ImageDoc(), caret);

    const options = useComposerDraftStore.persist.getOptions();
    const partialized = options.partialize?.(useComposerDraftStore.getState());
    expect(partialized).toBeDefined();
    if (partialized === undefined) return;

    // Stripped: the caret cannot be trusted against the shorter document.
    expect(partialized.drafts[pendingId]?.selection).toBeNull();
    // ...and the in-memory draft still has both the node and the caret, which
    // is what the live editor is actually pointing at.
    const live = useComposerDraftStore.getState().drafts[pendingId];
    expect(live?.selection).toEqual(caret);
    expect(containsB64String(live?.content)).toBe(true);

    // The CONTROL: nothing pending, nothing removed, caret preserved.
    const cleanId = "chat-caret-with-nothing-to-strip";
    useComposerDraftStore.getState().setSnapshot(
      cleanId,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      caret,
    );
    const afterClean = options.partialize?.(useComposerDraftStore.getState());
    expect(afterClean?.drafts[cleanId]?.selection).toEqual(caret);
  });

  it("carries a hash-only node through the persisted shape unchanged (nothing to strip)", () => {
    const taskId = "chat-with-hash-only-image";
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "node-1",
                fileName: "shot.png",
                mimeType: "image/png",
                size: 12,
                byHashEligible: true,
                hash: "hash-abc123",
              },
            },
          ],
        },
      ],
    };
    useComposerDraftStore.getState().setSnapshot(taskId, content, null);

    const options = useComposerDraftStore.persist.getOptions();
    const partialized = options.partialize?.(useComposerDraftStore.getState());
    expect(partialized).toBeDefined();
    if (partialized === undefined) return;
    expect(partialized.drafts[taskId]?.content).toEqual(content);
    expect(containsB64String(partialized.drafts[taskId])).toBe(false);
  });
});
