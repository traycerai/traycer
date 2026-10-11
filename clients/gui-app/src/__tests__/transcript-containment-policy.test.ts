/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A full size container (`container-type: size`) or size containment
 * (`contain: size` / `strict`) inside the transcript list or a row makes the
 * row's block size independent of its content, so a row cannot size itself
 * and every tile resize re-resolves the containment boundary of each row. The
 * transcript's width-dependent styling keys on the outer ChatTile container
 * instead, and `contain` is added to a region only where a trace proves it
 * independent. Kept out by reading the source (jsdom cannot measure style
 * recalculation).
 *
 * Inline-size containers (`@container`, `container-type: inline-size`) stay
 * allowed: no trace implicates them, and the rows' responsive folds
 * (`@max-[28rem]:hidden`) depend on them. `contain: layout paint style` and
 * `contain-intrinsic-size` carry no size containment and are allowed too.
 *
 * The outer ChatTile size container stays: the lower dock's `cqh` height caps
 * resolve against it, and without it they fall back to the viewport.
 *
 * Scope is the transcript list, its row shells and the segment components a
 * row renders, listed by file. A container introduced in a shared component a
 * row imports (a `ui/` primitive, a markdown renderer) or in a stylesheet is
 * not seen here.
 */

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CHAT_DIR = path.join(SRC_DIR, "components/chat");

/** Transcript files directly under `components/chat`. */
const TRANSCRIPT_FILES = [
  "chat-messages.tsx",
  "chat-timeline.tsx",
  "chat-message.tsx",
  "chat-message-assistant-body.tsx",
  "chat-message-user-body.tsx",
  "chat-message-timestamp.tsx",
  "chat-row-presentation.tsx",
  "chat-transcript-placeholder-row.tsx",
  "chat-user-message-content.tsx",
  "user-message-attachment-gallery.tsx",
];

/** `segments/` is rendered by rows, except the segments that live in the composer slot. */
const NOT_ROW_SEGMENT = /^composer-slot-/;

/**
 * `container-type: size` (also `[container-type:size]`, `containerType: "size"`,
 * `@container-size`) and `contain: size` / `strict` (also `contain-size`,
 * `contain-strict`, `[contain:layout_size]`).
 */
const SIZE_CONTAINMENT = new RegExp(
  [
    String.raw`container-type\s*:\s*size(?![\w-])`,
    String.raw`containerType\s*:\s*["']size["']`,
    String.raw`(?<![\w@-])@container-size(?![\w-])`,
    String.raw`(?<![\w-])contain-(?:size|strict)(?![\w-])`,
    String.raw`(?<![\w-])contain\s*:\s*["']?[a-z_ ]*?(?<![a-z-])(?:size|strict)(?![a-z-])`,
  ].join("|"),
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(name) && !NOT_ROW_SEGMENT.test(name) ? [full] : [];
  });
}

function transcriptFiles(): string[] {
  return [
    ...TRANSCRIPT_FILES.map((name) => path.join(CHAT_DIR, name)),
    ...sourceFiles(path.join(CHAT_DIR, "segments")),
  ];
}

describe("size containment in the transcript", () => {
  it.each([
    'className="[container-type:size]"',
    'className="@container-size"',
    'className="contain-size"',
    'className="contain-strict"',
    'className="[contain:size]"',
    'className="[contain:strict]"',
    'className="[contain:layout_size]"',
    "style={{ containerType: 'size' }}",
    "style={{ contain: 'strict' }}",
  ])("flags %s", (source) => {
    expect(SIZE_CONTAINMENT.test(source)).toBe(true);
  });

  it.each([
    'className="flex flex-col @container"',
    'className="@container/row flex"',
    'className="[container-type:inline-size]"',
    "style={{ containerType: 'inline-size' }}",
    'className="@max-[28rem]:hidden @container-normal"',
    'className="[contain:layout_paint_style]"',
    'className="contain-content"',
    'className="[contain-intrinsic-size:auto_8rem]"',
    'className="[content-visibility:auto] [contain-intrinsic-size:auto_14rem]"',
    'className="group/container"',
  ])("allows %s", (source) => {
    expect(SIZE_CONTAINMENT.test(source)).toBe(false);
  });

  it("appears in no transcript list, row shell or segment", () => {
    const offences = transcriptFiles().filter((file) =>
      SIZE_CONTAINMENT.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offences.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });

  it("leaves the outer ChatTile container the dock height caps resolve against", () => {
    const tile = readFileSync(
      path.join(SRC_DIR, "components/epic-canvas/renderers/chat-tile.tsx"),
      "utf8",
    );
    expect(stripComments(tile)).toMatch(/\[container-type:size\]/);
  });
});
