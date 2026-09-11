/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";

/**
 * The settings search index is hand-written — there is no schema behind this
 * app's settings to derive it from — so the thing that can rot is the join
 * between an entry and the element it points at. An anchor naming a row that
 * has been renamed, moved or deleted still LOOKS fine: the result renders, the
 * click navigates, and the only symptom is that the page does not scroll. That
 * is a silent failure, and it is exactly the class a source scan can catch.
 *
 * What this test decides, and what it cannot:
 *
 * - It CAN see that a token in the index is written somewhere in the settings
 *   tree, and that a token written there is in the index. That is the join.
 * - It CANNOT see whether the element actually renders — most panels are
 *   behind a host RPC — nor whether an entry's LABEL still matches the row's.
 *   The label half is reviewer discipline, and is why the entry file says to
 *   copy labels from the surface rather than paraphrase them.
 */
const SETTINGS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "components",
  "settings",
);

/**
 * Both spellings of the same thing. `anchor="…"` is the prop on `SettingsRow`
 * / `SettingsGroup` and covers nearly every site; `data-settings-anchor="…"`
 * is the raw attribute a hand-built row writes when it does not use the
 * primitive. A scan that knew only the prop would report the hand-built rows
 * as missing, which is how a lint test teaches people to delete the entry
 * rather than fix the anchor.
 */
const ANCHOR_PATTERN = /(?:data-settings-)?anchor="([a-z0-9-]+)"/g;

const indexedAnchors = SETTINGS_SEARCH_ENTRIES.flatMap((entry) =>
  entry.anchor === null ? [] : [entry.anchor],
);

describe("settings search index", () => {
  it("gives every entry a section that exists", () => {
    const sectionIds = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    const unknown = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => !sectionIds.has(entry.section),
    ).map((entry) => `${entry.label} -> ${entry.section}`);
    expect(unknown).toEqual([]);
  });

  it("never reuses an anchor between two entries", () => {
    // Anchors are looked up with a bare attribute selector, with no section in
    // the query, so a duplicate would silently resolve to whichever of the two
    // the DOM happened to reach first.
    const seen = new Set<string>();
    const duplicated = indexedAnchors.filter((anchor) => {
      if (seen.has(anchor)) return true;
      seen.add(anchor);
      return false;
    });
    expect(duplicated).toEqual([]);
  });

  it("points every anchor at a token the settings tree actually writes", () => {
    const written = anchorsWrittenInSource();
    const dangling = indexedAnchors.filter((anchor) => !written.has(anchor));
    expect(dangling).toEqual([]);
  });

  it("indexes every anchor the settings tree writes", () => {
    // The other direction, and the one that keeps the index growing with the
    // surface: an anchor added to a row and never indexed is a row that search
    // cannot reach, which looks exactly like a row nobody bothered to index.
    const indexed = new Set(indexedAnchors);
    const orphaned = [...anchorsWrittenInSource()].filter(
      (anchor) => !indexed.has(anchor),
    );
    expect(orphaned).toEqual([]);
  });

  it("keeps labels and keyword lists non-empty", () => {
    // A blank label renders a blank result row; a blank keyword list is legal
    // but is almost always a half-written entry, and the whole point of the
    // index is the vocabulary the label does not carry.
    const thin = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.label.trim().length === 0 || entry.keywords.length === 0,
    ).map((entry) => `${entry.section}:${entry.anchor ?? entry.label}`);
    expect(thin).toEqual([]);
  });
});

function anchorsWrittenInSource(): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const file of tsxFilesUnder(SETTINGS_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(ANCHOR_PATTERN)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function tsxFilesUnder(dir: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // `__tests__` is skipped deliberately: a test fixture writing an anchor
      // is not a settings surface, and counting it would let a deleted row
      // keep its index entry alive through the test that used to cover it.
      if (name === "__tests__") continue;
      files.push(...tsxFilesUnder(full));
      continue;
    }
    if (name.endsWith(".tsx")) files.push(full);
  }
  return files;
}
