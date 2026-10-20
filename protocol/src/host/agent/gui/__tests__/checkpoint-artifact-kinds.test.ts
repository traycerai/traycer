import { describe, expect, it } from "vitest";
import {
  chatSubscribeV131,
  chatSubscribeV132,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.32` is the first line whose accumulated-change tag can
 * name html, canvas or file: `chatSubscribeV132` binds the live windowed
 * server frame schema, whose `accumulatedChanges` chunk carries the widened
 * `checkpointArtifactTagSchema`. `chatSubscribeV131` is frozen one version
 * below it and still binds the pre-html tag (`checkpointArtifactTagSchemaPreHtml`)
 * via `chatAccumulatedChangeChunkSchemaPreHtml`. See
 * `CHAT_SUBSCRIBE_CHECKPOINT_ARTIFACT_KINDS_MINOR` in `chat-frame-compat.ts`.
 */

const MARKDOWN_KINDS = ["spec", "ticket", "story", "review"] as const;
const NEW_KINDS = ["html", "canvas", "file"] as const;

function tag(kind: string | null): Record<string, unknown> {
  return kind === null
    ? { artifactId: null, kind: null, title: null }
    : { artifactId: `artifact-${kind}`, kind, title: "Title" };
}

function accumulatedChangesFrame(kind: string | null): Record<string, unknown> {
  return {
    kind: "accumulatedChanges",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    chunk: {
      epoch: 0,
      generation: 0,
      fromIndex: 0,
      isFinal: true,
      summaries: [
        {
          filePath: "/repo/a.md",
          operation: "edit",
          diffSource: "snapshot",
          reason: "snapshot",
          undoable: true,
          hasContents: true,
          digest: "digest-1",
          counts: { additions: 1, deletions: 0 },
          artifact: tag(kind),
        },
      ],
    },
  };
}

describe("chat.subscribe accumulated-change summary tag kind, by line", () => {
  it.each(NEW_KINDS)(
    "a %s tag parses on 1.32 and is rejected on 1.31",
    (kind) => {
      expect(
        chatSubscribeV132.serverFrameSchema.safeParse(
          accumulatedChangesFrame(kind),
        ).success,
      ).toBe(true);
      expect(
        chatSubscribeV131.serverFrameSchema.safeParse(
          accumulatedChangesFrame(kind),
        ).success,
      ).toBe(false);
    },
  );

  it.each([...MARKDOWN_KINDS, null])(
    "a %s tag parses on both 1.31 and 1.32",
    (kind) => {
      expect(
        chatSubscribeV131.serverFrameSchema.safeParse(
          accumulatedChangesFrame(kind),
        ).success,
      ).toBe(true);
      expect(
        chatSubscribeV132.serverFrameSchema.safeParse(
          accumulatedChangesFrame(kind),
        ).success,
      ).toBe(true);
    },
  );
});
