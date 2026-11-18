import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { createChatTranscriptRowHeightMemory } from "@/components/chat/chat-transcript-row-height-memory";
import { placeholderRowHeight } from "@/components/chat/chat-transcript-placeholder-height";

function entry(input: {
  rowId: string;
  role: RowSkeletonEntry["role"];
  byteLength: number;
}): RowSkeletonEntry {
  return {
    rowId: input.rowId,
    createdAt: 1000,
    role: input.role,
    byteLength: input.byteLength,
    bodyDigest: "d0",
  };
}

/**
 * `44 + ceil(8000 / 80) * 22` - the RAW byte model for an 8 KB row. Not what a
 * placeholder shows; it is what the memory fits its scale factor AGAINST.
 */
const RAW_8KB = 2244;
/**
 * What an 8 KB row is worth before anything in this chat has been measured.
 * Bytes alone do not predict pixels, so with no evidence the answer is the
 * conservative cap rather than the raw model.
 */
const UNCALIBRATED = 320;

function assistantRows(count: number): RowSkeletonEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    entry({ rowId: `row-${index}`, role: "assistant", byteLength: 8000 }),
  );
}

describe("chat transcript row height memory", () => {
  it("places a row it has measured at exactly that height", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);

    expect(memory.placeholderHeight(row)).toBe(UNCALIBRATED);

    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 4100,
    });

    // Not "closer" - exact. This is the evicted-scrollback path, where the row
    // has been drawn before and there is nothing left to estimate.
    expect(memory.placeholderHeight(row)).toBe(4100);
  });

  it("estimates the missing share when only a later part has been measured", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({
      rowId: "split-row",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([row]);

    memory.recordMeasuredHeight({
      rowId: row.rowId,
      partIndex: 1,
      partCount: 2,
      ordinal: 0,
      height: 700,
    });

    // With no complete-row evidence, the whole-row estimate is capped at
    // 320px. The missing half reserves 160px beside the measured later part.
    expect(memory.placeholderHeight(row)).toBe(860);
  });

  it("scales the estimate for an unseen row by the error it has observed", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([...measured, unseen]);

    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);

    // Every measured row came in at a quarter of its estimate.
    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });

    expect(memory.placeholderHeight(unseen)).toBe(561);
  });

  it("does not scale on evidence thinner than the sample floor", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(3);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([...measured, unseen]);

    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });

    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
  });

  it("keeps each role's error separate", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(4);
    const user = entry({ rowId: "user-0", role: "user", byteLength: 8000 });
    memory.observeSkeleton([...measured, user]);
    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });

    // An assistant turn's serialized size runs far ahead of what it draws; a
    // user row's does not, and must not inherit the assistant correction.
    expect(memory.placeholderHeight(user)).toBe(UNCALIBRATED);
  });

  it("back-fills rows measured before their skeleton entry arrived", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });

    // The chat's own tail: hydrated from the snapshot and drawn before the
    // first skeleton chunk lands, so there is nothing to match it against yet.
    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });
    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);

    memory.observeSkeleton([...measured, unseen]);

    expect(memory.placeholderHeight(unseen)).toBe(561);
  });

  it("waits for every part before backfilled rows calibrate or enter the average", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const rows = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });

    // A hydrated tail can report its part sizes before the skeleton arrives.
    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 2,
        ordinal,
        height: 561,
      });
    });
    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
    expect(memory.placeholderHeight(null)).toBe(120);

    memory.observeSkeleton([...rows, unseen]);

    // Backfill sees four partial rows, not four calibration samples or exact
    // row heights.
    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
    expect(memory.placeholderHeight(null)).toBe(120);

    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 1,
        partCount: 2,
        ordinal,
        height: 561,
      });
    });

    // Completion makes each 1122px total exact and supplies the four samples
    // needed for the unseen row's factor and the unknown-row average.
    expect(memory.placeholderHeight(rows[0])).toBe(1122);
    expect(memory.placeholderHeight(unseen)).toBe(1122);
    expect(memory.placeholderHeight(null)).toBe(1122);
  });

  it("withdraws complete-row calibration and average when the part count grows", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const rows = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([...rows, unseen]);

    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });
    expect(memory.placeholderHeight(unseen)).toBe(561);
    expect(memory.placeholderHeight(null)).toBe(561);

    rows.forEach((row, ordinal) => {
      // The measured sum stays 561, but the new second slot has not reported.
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 2,
        ordinal,
        height: 561,
      });
    });

    expect(memory.placeholderHeight(rows[0])).toBe(721);
    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
    expect(memory.placeholderHeight(null)).toBe(120);

    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 1,
        partCount: 2,
        ordinal,
        height: 561,
      });
    });

    // Finishing the newly appended slots restores exact whole-row evidence.
    expect(memory.placeholderHeight(rows[0])).toBe(1122);
    expect(memory.placeholderHeight(unseen)).toBe(1122);
    expect(memory.placeholderHeight(null)).toBe(1122);
  });

  it("does not let an incomplete tall part raise the calibrated ceiling", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const complete = assistantRows(4);
    const partial = entry({
      rowId: "partial-tall",
      role: "assistant",
      byteLength: 8000,
    });
    const unseen = entry({
      rowId: "later-long",
      role: "assistant",
      byteLength: 100_000,
    });
    memory.observeSkeleton([...complete, partial, unseen]);

    complete.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });
    memory.recordMeasuredHeight({
      rowId: partial.rowId,
      partIndex: 0,
      partCount: 2,
      ordinal: 4,
      height: 5000,
    });

    // The four complete rows establish a 0.25 factor, whose long-row estimate
    // is above 3200px. The 5000px partial part is not evidence to raise that
    // ceiling, so the calibrated placeholder remains at 3200px.
    expect(memory.placeholderHeight(unseen)).toBe(3200);
    expect(memory.placeholderHeight(null)).toBe(561);
  });

  it("prunes dropped parts on shrink and replaces a reused slot", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const rows = assistantRows(4);
    const unseen = entry({
      rowId: "later-longer",
      role: "assistant",
      byteLength: 16_000,
    });
    const row = rows[0];
    memory.observeSkeleton([...rows, unseen]);

    rows.forEach((measuredRow, ordinal) => {
      for (const [partIndex, height] of [100, 200, 300].entries()) {
        memory.recordMeasuredHeight({
          rowId: measuredRow.rowId,
          partIndex,
          partCount: 3,
          ordinal,
          height,
        });
      }
    });
    expect(memory.placeholderHeight(row)).toBe(600);
    expect(memory.placeholderHeight(unseen)).toBe(1188);
    expect(memory.placeholderHeight(null)).toBe(600);

    // Slot 2 is dropped when the turn redraws with two parts. Slot 1 remains
    // valid; the complete-only unknown average and role factor now include
    // this row's corrected 300px total.
    memory.recordMeasuredHeight({
      rowId: row.rowId,
      partIndex: 0,
      partCount: 2,
      ordinal: 0,
      height: 100,
    });
    expect(memory.placeholderHeight(row)).toBe(300);
    expect(memory.placeholderHeight(unseen)).toBe(1040);
    expect(memory.placeholderHeight(null)).toBe(525);

    // A same-count report replaces the retained slot instead of adding it a
    // second time, and updates both pooled estimates from the new total.
    memory.recordMeasuredHeight({
      rowId: row.rowId,
      partIndex: 1,
      partCount: 2,
      ordinal: 0,
      height: 250,
    });
    expect(memory.placeholderHeight(row)).toBe(350);
    expect(memory.placeholderHeight(unseen)).toBe(1064);
    expect(memory.placeholderHeight(null)).toBe(538);
  });

  it("counts a row once however many times the skeleton is re-observed", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(4);
    const late = entry({ rowId: "late", role: "assistant", byteLength: 8000 });
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });

    memory.observeSkeleton([...measured, late, unseen]);
    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });
    // A fresh array - a later skeleton chunk - carrying the same rows.
    memory.observeSkeleton([...measured, late, unseen]);
    memory.recordMeasuredHeight({
      rowId: "late",
      partIndex: 0,
      partCount: 1,
      ordinal: 4,
      height: RAW_8KB,
    });

    // Four rows at a quarter and one dead on: (4*561 + 2244) / (5*2244) = 0.4.
    // Re-counting the first four would give 0.333 and 748px instead.
    expect(memory.placeholderHeight(unseen)).toBe(898);
  });

  it("holds the correction to a band around one", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      entry({ rowId: `row-${index}`, role: "assistant", byteLength: 800 }),
    );
    memory.observeSkeleton(rows);
    const base = placeholderRowHeight(rows[0]);
    expect(base).toBe(264);

    // A hundred times the estimate. A few freak rows must not be able to drag
    // every other row's placeholder somewhere absurd.
    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 26_400,
      });
    });

    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 800,
    });
    // 264 * 10 (the factor cap), not 264 * 100.
    expect(memory.placeholderHeight(unseen)).toBe(2640);
  });

  it("reaches the height tall rows in this chat actually draw", () => {
    // The live regression this exists for: a seeded transcript whose assistant
    // rows measure ~8200px sat behind a 3200px placeholder, because the base
    // estimate was clamped BEFORE the scale factor could be applied to it and
    // the result was clamped again to the same fixed cap. Both clamps had to
    // move: calibration cannot recover a signal a clamp already flattened, and
    // a ceiling below the observed distribution is a guaranteed correction.
    const memory = createChatTranscriptRowHeightMemory();
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      entry({ rowId: `row-${index}`, role: "assistant", byteLength: 409_600 }),
    );
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 409_600,
    });
    memory.observeSkeleton([...rows, unseen]);

    // With no evidence yet, the conservative cap is the honest answer.
    expect(memory.placeholderHeight(unseen)).toBe(320);

    rows.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 8224,
      });
    });

    expect(memory.placeholderHeight(unseen)).toBe(8224);
  });

  it("separates two roles that carry the same bytes and render 39x apart", () => {
    // Measured off a real 403-row transcript: user rows averaged 31,612 bytes
    // and drew 212px (a clamped bubble) while assistant rows averaged 30,902
    // bytes and drew 8,224px. Any single bytes-to-pixels rule is wrong for one
    // of them by more than an order of magnitude, which is the whole reason
    // the scale factor is kept per role.
    const memory = createChatTranscriptRowHeightMemory();
    const users = Array.from({ length: 4 }, (_unused, index) =>
      entry({ rowId: `u-${index}`, role: "user", byteLength: 31_612 }),
    );
    const assistants = Array.from({ length: 4 }, (_unused, index) =>
      entry({ rowId: `a-${index}`, role: "assistant", byteLength: 30_902 }),
    );
    const nextUser = entry({
      rowId: "u-next",
      role: "user",
      byteLength: 31_612,
    });
    const nextAssistant = entry({
      rowId: "a-next",
      role: "assistant",
      byteLength: 30_902,
    });
    const skeleton = [...users, ...assistants, nextUser, nextAssistant];
    memory.observeSkeleton(skeleton);

    skeleton.forEach((row, ordinal) => {
      if (row.rowId.startsWith("u-") && row.rowId !== "u-next") {
        memory.recordMeasuredHeight({
          rowId: row.rowId,
          partIndex: 0,
          partCount: 1,
          ordinal,
          height: 212,
        });
      }
      if (row.rowId.startsWith("a-") && row.rowId !== "a-next") {
        memory.recordMeasuredHeight({
          rowId: row.rowId,
          partIndex: 0,
          partCount: 1,
          ordinal,
          height: 8_224,
        });
      }
    });

    expect(memory.placeholderHeight(nextUser)).toBe(212);
    expect(memory.placeholderHeight(nextAssistant)).toBe(8_224);
  });

  it("sizes an undescribed row from what rows in this chat actually measure", () => {
    const memory = createChatTranscriptRowHeightMemory();
    expect(memory.placeholderHeight(null)).toBe(120);

    memory.recordMeasuredHeight({
      rowId: "a",
      partIndex: 0,
      partCount: 1,
      ordinal: null,
      height: 100,
    });
    memory.recordMeasuredHeight({
      rowId: "b",
      partIndex: 0,
      partCount: 1,
      ordinal: null,
      height: 300,
    });

    expect(memory.placeholderHeight(null)).toBe(200);
  });

  it("replaces a row's height rather than accumulating it", () => {
    const memory = createChatTranscriptRowHeightMemory();
    memory.recordMeasuredHeight({
      rowId: "a",
      partIndex: 0,
      partCount: 1,
      ordinal: null,
      height: 100,
    });
    memory.recordMeasuredHeight({
      rowId: "a",
      partIndex: 0,
      partCount: 1,
      ordinal: null,
      height: 300,
    });

    // A streaming row remeasures on every token; the average must track one
    // row at its latest height, not one row per measurement.
    expect(memory.placeholderHeight(null)).toBe(300);
  });

  it("takes no calibration sample from a row that owns no ordinal", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([unseen]);

    // The live turn and pending sends: no skeleton entry says what they were
    // estimated from, and a mid-stream height is not settled anyway.
    for (let index = 0; index < 8; index += 1) {
      memory.recordMeasuredHeight({
        rowId: `live-${index}`,
        partIndex: 0,
        partCount: 1,
        ordinal: null,
        height: 40,
      });
    }

    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
  });

  it("ignores a measurement that is not a real height", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);

    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 0,
    });
    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: Number.NaN,
    });

    expect(memory.placeholderHeight(row)).toBe(UNCALIBRATED);
  });

  it("does not match a measurement to a skeleton entry for a different row", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const rows = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([...rows, unseen]);

    // The skeleton is ordinal-indexed and can lag the spans, so an ordinal can
    // name a row that is not the one being measured.
    rows.forEach((_row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: `stale-${ordinal}`,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });

    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
  });

  it("stays bounded, and keeps answering, past the row cap", () => {
    const memory = createChatTranscriptRowHeightMemory();
    for (let index = 0; index < 4_200; index += 1) {
      memory.recordMeasuredHeight({
        rowId: `row-${index}`,
        partIndex: 0,
        partCount: 1,
        ordinal: null,
        height: 200,
      });
    }

    // Every row measured 200, so the average is 200 whatever survived eviction
    // - the assertion is that the running total was decremented with it rather
    // than left counting rows the table no longer holds.
    expect(memory.placeholderHeight(null)).toBe(200);
    // The oldest entries are gone; the newest are still exact.
    expect(
      memory.placeholderHeight(
        entry({ rowId: "row-4199", role: "assistant", byteLength: 8000 }),
      ),
    ).toBe(200);
    expect(
      memory.placeholderHeight(
        entry({ rowId: "row-0", role: "assistant", byteLength: 8000 }),
      ),
    ).toBe(UNCALIBRATED);
  });
});

describe("row height memory across a layout width change", () => {
  it("forgets a height measured at a different width", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);
    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });
    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 4100,
    });

    expect(memory.placeholderHeight(row)).toBe(4100);

    memory.observeLayoutBasis({ width: 1200, fontSizePx: 16 });

    // Not re-scaled - discarded. A height measured in a narrow tile is not a
    // better answer than the estimate for the same row in a wide one, so the
    // fallback is the no-evidence cap rather than the stale exact number.
    expect(memory.placeholderHeight(row)).toBe(UNCALIBRATED);
  });

  it("drops the calibration together with the heights it was fitted from", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const measured = assistantRows(4);
    const unseen = entry({
      rowId: "later",
      role: "assistant",
      byteLength: 8000,
    });
    memory.observeSkeleton([...measured, unseen]);
    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });
    measured.forEach((row, ordinal) => {
      memory.recordMeasuredHeight({
        rowId: row.rowId,
        partIndex: 0,
        partCount: 1,
        ordinal,
        height: 561,
      });
    });

    expect(memory.placeholderHeight(unseen)).toBe(561);

    memory.observeLayoutBasis({ width: 1200, fontSizePx: 16 });

    // The pooled factor is `sum(measured) / sum(estimated)` over rows measured
    // at 600px. Keeping it would carry that geometry into every placeholder
    // drawn before the first row is remeasured - which is precisely the set of
    // rows this module exists to place.
    expect(memory.placeholderHeight(unseen)).toBe(UNCALIBRATED);
  });

  it("adopts the first width without discarding what was measured before it", () => {
    // LegendList measures inside its own layout effect, which runs BEFORE the
    // one that reports width, so the opening commit's heights are always
    // recorded against no baseline. Treating that first report as a change
    // would throw away the tail calibration - the only evidence available
    // before the reader has scrolled anywhere.
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);
    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 4100,
    });

    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });

    expect(memory.placeholderHeight(row)).toBe(4100);
  });

  it("keeps its memory when the same width is reported again", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);
    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });
    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 4100,
    });

    // A ResizeObserver fires for height changes too, and the transcript's
    // height changes on every hydration.
    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });

    expect(memory.placeholderHeight(row)).toBe(4100);
  });

  it("ignores a width from a container that has not been laid out", () => {
    const memory = createChatTranscriptRowHeightMemory();
    const row = entry({ rowId: "row-0", role: "assistant", byteLength: 8000 });
    memory.observeSkeleton([row]);
    memory.observeLayoutBasis({ width: 600, fontSizePx: 16 });
    memory.recordMeasuredHeight({
      rowId: "row-0",
      partIndex: 0,
      partCount: 1,
      ordinal: 0,
      height: 4100,
    });

    // A hidden tab or an unmounted tile measures 0 wide. Adopting that as the
    // baseline would discard the whole memory, and then discard it again when
    // the real width came back.
    memory.observeLayoutBasis({ width: 0, fontSizePx: 16 });

    expect(memory.placeholderHeight(row)).toBe(4100);
  });
});
