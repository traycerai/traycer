import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { ChatTranscriptPlaceholderRow } from "@/components/chat/chat-transcript-placeholder-row";
import {
  placeholderRowHeight,
  rawPlaceholderRowHeight,
} from "@/components/chat/chat-transcript-placeholder-height";

afterEach(() => {
  cleanup();
});

function entry(input: {
  role: RowSkeletonEntry["role"];
  byteLength: number;
  preview?: string;
  sentByAgent?: boolean;
}): RowSkeletonEntry {
  return {
    rowId: "row-1",
    createdAt: 1000,
    role: input.role,
    byteLength: input.byteLength,
    bodyDigest: "d0",
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    ...(input.sentByAgent === undefined
      ? {}
      : { sentByAgent: input.sentByAgent }),
  };
}

describe("placeholderRowHeight", () => {
  it("uses the minimum for a tiny entry", () => {
    expect(
      placeholderRowHeight(entry({ role: "assistant", byteLength: 0 })),
    ).toBe(44);
  });

  it("sizes an undescribed row above the one-line floor", () => {
    // A skeleton hole means "a row exists and nothing about it has arrived",
    // which is most often an assistant turn - sizing it as one line would
    // guarantee the largest possible jump when anything lands.
    expect(placeholderRowHeight(null)).toBe(120);
  });

  it("stays conservative while nothing has been measured", () => {
    // With no measurements, a big byte count is not evidence of a tall row:
    // measured user and assistant rows of the same size render 39x apart. So
    // the no-evidence answer stays the long-standing conservative cap, and
    // only the calibrated estimate is allowed past it.
    expect(
      placeholderRowHeight(
        entry({ role: "assistant", byteLength: 100_000_000 }),
      ),
    ).toBe(320);
  });

  it("keeps the raw model carrying size information past the cap", () => {
    // The clamp is applied on top; the model underneath must stay monotonic,
    // because the memory fits its scale factor against THIS - a factor fitted
    // to an already-flattened base cannot recover the ordering.
    const at2kb = rawPlaceholderRowHeight(2_048);
    const at20kb = rawPlaceholderRowHeight(20_480);
    expect(at2kb).toBeGreaterThan(320);
    expect(at20kb).toBeGreaterThan(at2kb * 4);
  });

  it("is monotonic in byteLength between the clamps", () => {
    const heights = [40, 80, 160, 320].map((byteLength) =>
      placeholderRowHeight(entry({ role: "assistant", byteLength })),
    );
    expect(heights).toEqual([66, 66, 88, 132]);
    expect(heights[0]).toBeLessThanOrEqual(heights[1]);
    expect(heights[1]).toBeLessThanOrEqual(heights[2]);
    expect(heights[2]).toBeLessThanOrEqual(heights[3]);
  });
});

describe("ChatTranscriptPlaceholderRow", () => {
  it("renders ordinal metadata and is aria-hidden", () => {
    render(
      <ChatTranscriptPlaceholderRow
        entry={null}
        ordinal={7}
        heightMemory={null}
      />,
    );
    const row = screen.getByTestId("chat-transcript-placeholder-row");
    expect(row.getAttribute("data-ordinal")).toBe("7");
    expect(row.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows a human user preview", () => {
    render(
      <ChatTranscriptPlaceholderRow
        entry={entry({
          role: "user",
          byteLength: 32,
          preview: "A remembered question",
        })}
        ordinal={2}
        heightMemory={null}
      />,
    );
    expect(screen.getByText("A remembered question")).toBeTruthy();
  });

  it("does not show text for an assistant entry", () => {
    render(
      <ChatTranscriptPlaceholderRow
        entry={entry({
          role: "assistant",
          byteLength: 32,
          preview: "must not render",
        })}
        ordinal={2}
        heightMemory={null}
      />,
    );
    expect(screen.queryByText("must not render")).toBeNull();
  });

  it("does not show a preview for an agent-sent user entry", () => {
    render(
      <ChatTranscriptPlaceholderRow
        entry={entry({
          role: "user",
          byteLength: 32,
          preview: "agent delivery",
          sentByAgent: true,
        })}
        ordinal={2}
        heightMemory={null}
      />,
    );
    expect(screen.queryByText("agent delivery")).toBeNull();
  });
});
