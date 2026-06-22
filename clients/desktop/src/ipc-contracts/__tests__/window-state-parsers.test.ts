import { describe, expect, it } from "vitest";
import { parseLandingDraft, parseLandingDrafts } from "../window-state-parsers";

describe("parseLandingDraft", () => {
  it("rejects a legacy prompt-only entry (no `content`)", () => {
    // T6 dropped the `prompt` bridge: a draft that carries only the old
    // text `prompt` has no `content` object and must fail the new parser.
    // No back-compat — this is a dev feature, so the stale entry is dropped.
    expect(
      parseLandingDraft({
        id: "draft-a",
        prompt: "Continue the plan",
        settings: null,
        composerMode: null,
        workspace: null,
      }),
    ).toBeNull();
  });

  it("accepts an entry with doc-shaped `content`, carrying selection + lastTouchedAt", () => {
    const content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    };
    expect(
      parseLandingDraft({
        id: "draft-a",
        content,
        selection: { from: 1, to: 3 },
        lastTouchedAt: 1234,
        settings: { harnessId: "codex" },
        composerMode: "chat",
        workspace: null,
      }),
    ).toEqual({
      id: "draft-a",
      content,
      selection: { from: 1, to: 3 },
      lastTouchedAt: 1234,
      settings: { harnessId: "codex" },
      composerMode: "chat",
      workspace: null,
    });
  });

  it("preserves a hash-only image node in `content` round-trip", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                hash: "abc123",
                fileName: "shot.png",
                mimeType: "image/png",
                size: 4096,
              },
            },
          ],
        },
      ],
    };
    const parsed = parseLandingDraft({
      id: "draft-img",
      content,
      selection: null,
      lastTouchedAt: 7,
      settings: null,
      composerMode: null,
      workspace: null,
    });
    expect(parsed?.content).toEqual(content);
  });

  it("defaults a missing/non-finite `lastTouchedAt` to 0 and a missing `selection` to null", () => {
    expect(
      parseLandingDraft({
        id: "draft-a",
        content: { type: "doc" },
        settings: null,
        composerMode: null,
        workspace: null,
      }),
    ).toEqual({
      id: "draft-a",
      content: { type: "doc" },
      selection: null,
      lastTouchedAt: 0,
      settings: null,
      composerMode: null,
      workspace: null,
    });
  });

  it("rejects content that is not a record (primitive or array)", () => {
    expect(
      parseLandingDraft({ id: "draft-a", content: "not-a-doc" }),
    ).toBeNull();
    expect(
      parseLandingDraft({ id: "draft-a", content: [{ type: "doc" }] }),
    ).toBeNull();
    expect(parseLandingDraft({ id: "draft-a", content: null })).toBeNull();
  });

  it("rejects a missing or non-string id", () => {
    expect(parseLandingDraft({ content: { type: "doc" } })).toBeNull();
    expect(parseLandingDraft({ id: 7, content: { type: "doc" } })).toBeNull();
  });
});

describe("parseLandingDrafts", () => {
  it("drops legacy prompt-only entries while keeping content entries", () => {
    const drafts = parseLandingDrafts([
      { id: "legacy", prompt: "old text" },
      { id: "fresh", content: { type: "doc" } },
    ]);
    expect(drafts).toEqual([
      {
        id: "fresh",
        content: { type: "doc" },
        selection: null,
        lastTouchedAt: 0,
        settings: null,
        composerMode: null,
        workspace: null,
      },
    ]);
  });
});
