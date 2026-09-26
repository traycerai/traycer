import { describe, expect, it } from "vitest";
import { z } from "zod";
import { preservedContentBlockSchema } from "@traycer/protocol/persistence/chat-sync/entries";
import {
  canonicalizeJsonValue,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";

/**
 * chat-sync 1.6 carries `text.providerNotice.receipt`. `version.ts` claims a
 * content block's `raw` re-emission carries the key through a re-publication;
 * these tests are that claim's evidence.
 */

const receipt: JsonObject = {
  causeLabel: "Rate limited",
  steps: [
    {
      kind: "switch",
      providerLabel: "Codex",
      modelLabel: "gpt-5.4",
      profileLabel: "Personal",
      resumedAt: null,
      endedLabel: "Ended 12:04",
    },
    {
      kind: "wait",
      providerLabel: "Claude",
      modelLabel: "Sonnet",
      profileLabel: "Work",
      resumedAt: 1234,
      endedLabel: "Resumed 12:30",
    },
  ],
};

function noticeBlock(withReceipt: boolean): JsonObject {
  return {
    blockId: "b-notice",
    status: "completed",
    timestamp: 10,
    type: "text",
    text: "settled",
    parentBlockId: null,
    providerNotice: {
      harnessId: "claude",
      noticeKind: "fallback_settled",
      tone: "info",
      title: "Settled",
      message: null,
      details: [],
      metadata: null,
      ...(withReceipt ? { receipt } : {}),
    },
  };
}

describe("published content block: providerNotice.receipt", () => {
  it("decodes with the receipt on both the raw carrier and the parsed view", () => {
    const decoded = z.decode(preservedContentBlockSchema, noticeBlock(true));
    expect(decoded.variant).toBe("text");
    expect(JSON.stringify(decoded.raw)).toContain('"receipt"');
    expect(decoded.value).not.toBeNull();
    expect(JSON.stringify(decoded.value)).toContain(
      '"causeLabel":"Rate limited"',
    );
  });

  it("re-encodes with the receipt intact, byte-for-byte the canonical form", () => {
    const input = noticeBlock(true);
    const encoded = z.encode(
      preservedContentBlockSchema,
      z.decode(preservedContentBlockSchema, input),
    );
    expect(encoded).toEqual(canonicalizeJsonValue(input));
  });

  it("is idempotent across a second decode/encode", () => {
    const once = z.encode(
      preservedContentBlockSchema,
      z.decode(preservedContentBlockSchema, noticeBlock(true)),
    );
    const twice = z.encode(
      preservedContentBlockSchema,
      z.decode(preservedContentBlockSchema, once),
    );
    expect(twice).toEqual(once);
  });

  it("a block without the receipt (an older record) still decodes and stays without it", () => {
    const encoded = z.encode(
      preservedContentBlockSchema,
      z.decode(preservedContentBlockSchema, noticeBlock(false)),
    );
    expect(JSON.stringify(encoded)).not.toContain('"receipt"');
  });
});
