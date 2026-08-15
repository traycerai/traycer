import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import { contentBlocksPreview } from "@/lib/chat/content-block-text";

describe("contentBlocksPreview", () => {
  it("falls back to the plain text for an ordinary text block", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "text",
        blockId: "text-1",
        status: "completed",
        timestamp: 1,
        text: "Hello there.",
        providerNotice: null,
      },
    ];

    expect(contentBlocksPreview(blocks)).toBe("Hello there.");
  });

  it("includes provider notice title, message, and detail label/value text", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "text",
        blockId: "notice-1",
        status: "completed",
        timestamp: 1,
        text: "Codex switched from gpt-5 to gpt-5-safe.",
        providerNotice: {
          harnessId: "codex",
          noticeKind: "model_rerouted",
          tone: "warning",
          title: "Model changed",
          message: "Codex switched from gpt-5 to gpt-5-safe.",
          details: [{ label: "Reason", value: "highRiskCyberActivity" }],
          metadata: {
            type: "model_rerouted",
            fromModel: "gpt-5",
            toModel: "gpt-5-safe",
            reason: "highRiskCyberActivity",
          },
        },
      },
    ];

    const text = contentBlocksPreview(blocks);
    expect(text).toContain("Model changed");
    expect(text).toContain("Codex switched from gpt-5 to gpt-5-safe.");
    expect(text).toContain("Reason: highRiskCyberActivity");
  });

  it("retains only a bounded preview of a very large text block", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "text",
        blockId: "large-text",
        status: "completed",
        timestamp: 1,
        text: `Reply ${"x".repeat(500_000)}`,
        providerNotice: null,
      },
    ];

    const preview = contentBlocksPreview(blocks);
    expect(preview.length).toBeLessThanOrEqual(201);
    expect(preview.startsWith("Reply xxx")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("does not retain a full copy of a large reasoning block", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "reasoning",
        blockId: "large-reasoning",
        status: "completed",
        timestamp: 1,
        startedAt: null,
        content: "r".repeat(500_000),
      },
    ];

    const preview = contentBlocksPreview(blocks);
    expect(preview.length).toBeLessThanOrEqual(201);
    expect(preview.startsWith("Reasoning rrr")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });
});
