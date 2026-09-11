/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_FIXTURES } from "@/components/settings/__tests__/settings-search-fixture-registry";
import type {
  AnySettingsSectionCollection,
  SettingsDefinition,
  SettingsSearchEntry,
} from "@/lib/settings-search/settings-definitions";
import {
  SETTINGS_SEARCH_COLLECTIONS,
  SETTINGS_SEARCH_ENTRIES,
} from "@/lib/settings-search/settings-search-entries";
import { settingsSearchResultKey } from "@/lib/settings-search/settings-search";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";

/**
 * The index is assembled from one collection per section, and each collection
 * is the value its panel renders from — so what can rot is no longer a label
 * copied between two files, but the assembly (a collection nobody lists), the
 * enumeration (a member that never became a definition), the folding (a
 * contributor whose words never reach an entry), and the shells the DOM
 * executor mounts (a gate no fixture ever turns on).
 *
 * What this cannot see is anything outside a definition: a bespoke `<div>`
 * that uses no primitive and writes no anchor is invisible to it, and the DOM
 * half lives in `components/settings/__tests__/settings-search-fixtures.test.tsx`.
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
 * Every `*.definitions.ts` module under `components/settings/`, evaluated. A
 * collection that exists but is never listed in the assembly is found here.
 */
const DEFINITION_MODULES = import.meta.glob<Record<string, unknown>>(
  "/src/components/settings/**/*.definitions.ts",
  { eager: true },
);

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
    expect(duplicates(indexedAnchors)).toEqual([]);
  });

  it("never reuses a result key, anchorless entries included", () => {
    // The result list keys on section + (anchor ?? label); Providers' seven
    // region groups all have a `null` anchor and are told apart by label.
    expect(
      duplicates(SETTINGS_SEARCH_ENTRIES.map(settingsSearchResultKey)),
    ).toEqual([]);
  });

  it("keeps labels and keyword lists non-empty", () => {
    // A blank label renders a blank result row; a blank keyword list is legal
    // but is almost always a half-written entry, and the whole point of the
    // index is the vocabulary the label does not carry.
    const thin = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.label.trim().length === 0 || entry.keywords.length === 0,
    ).map(settingsSearchResultKey);
    expect(thin).toEqual([]);
  });

  it("indexes no anchor on a host-scoped section", () => {
    // Every card on a host-scoped page is dropped or concealed for an
    // unresolved, connecting or vanished host, so only the page — or a
    // region with a `null` anchor — is a stable destination there.
    const hostSections = new Set(
      SETTINGS_SECTIONS.filter((section) => section.group === "host").map(
        (section) => section.id,
      ),
    );
    const anchored = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => hostSections.has(entry.section) && entry.anchor !== null,
    ).map(settingsSearchResultKey);
    expect(anchored).toEqual([]);
  });

  it("writes no anchor as a literal — every one comes from a definition", () => {
    // A definition's anchor is written by the primitive, or by a bespoke
    // region from `X.definitions.y.anchor`. A string literal would be an
    // anchor with no definition behind it: rendered, but indexed nowhere.
    const literals = [...tsxFilesUnder(SETTINGS_DIR)].flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /(?:data-settings-)?anchor="([a-z0-9-]+)"/g,
        ),
      ].map((match) => `${path.relative(SETTINGS_DIR, file)}: ${match[1]}`),
    );
    expect(literals).toEqual([]);
  });
});

describe("settings search assembly", () => {
  it("assembles exactly one collection per section", () => {
    const assembled = SETTINGS_SEARCH_COLLECTIONS.map(
      (collection) => collection.section,
    );
    expect(duplicates(assembled)).toEqual([]);
    expect([...assembled].sort()).toEqual(
      SETTINGS_SECTIONS.map((section) => section.id).sort(),
    );
  });

  it("assembles every collection a definitions module exports", () => {
    const exported = Object.entries(DEFINITION_MODULES).flatMap(
      ([file, module]) =>
        Object.entries(module).flatMap(([name, value]) =>
          isCollection(value) ? [{ label: `${file}#${name}`, value }] : [],
        ),
    );
    // The glob found the modules at all — an empty match would pass the
    // membership checks below vacuously.
    expect(exported.length).toBe(SETTINGS_SECTIONS.length);
    const unassembled = exported
      .filter(({ value }) => !SETTINGS_SEARCH_COLLECTIONS.includes(value))
      .map(({ label }) => label);
    expect(unassembled).toEqual([]);
  });

  it("is exactly the concatenation of its collections' entries", () => {
    expect(SETTINGS_SEARCH_ENTRIES).toEqual(
      SETTINGS_SEARCH_COLLECTIONS.flatMap((collection) => collection.entries),
    );
  });
});

describe("settings section collections", () => {
  for (const collection of SETTINGS_SEARCH_COLLECTIONS) {
    describe(collection.section, () => {
      it("defines every member of its input, and nothing else", () => {
        const inputKeys = Object.keys(collection.input).filter(
          (key) => key !== "page",
        );
        expect(Object.keys(collection.definitions).sort()).toEqual(
          [...inputKeys].sort(),
        );
        for (const definition of Object.values(collection.definitions)) {
          expect(definition.section).toBe(collection.section);
          expect(definition.label).toBe(
            memberLabel(collection, definition.key),
          );
        }
      });

      it("emits the page and one entry per entry-owning member", () => {
        const owners = Object.values(collection.definitions).filter(
          (definition) => "anchor" in definition.search,
        );
        expect(collection.entries.map(entryShape)).toEqual([
          `section:${collection.page.label}`,
          ...owners.map(
            (definition) =>
              `${definition.kind === "row" ? "setting" : "group"}:${definition.label}`,
          ),
        ]);
      });

      it("points every contribution at an entry-owning member or the page", () => {
        // `contributesTo` is typed to entry-owning keys; this is the same rule
        // for a value that got past the compiler.
        const bad = Object.values(collection.definitions).flatMap(
          (definition) => {
            if (!("contributesTo" in definition.search)) return [];
            const target = definition.search.contributesTo;
            if (target === "page") return [];
            const owner = definitionsByKey(collection).get(target);
            if (owner === undefined) {
              return [`${definition.key} -> ${target}: dangling`];
            }
            if (owner.key === definition.key) {
              return [`${definition.key}: targets itself`];
            }
            if (!("anchor" in owner.search)) {
              return [`${definition.key} -> ${target}: a contributor`];
            }
            return [];
          },
        );
        expect(bad).toEqual([]);
      });

      it("folds every contributor's label and keywords into its target's document", () => {
        const missing = Object.values(collection.definitions).flatMap(
          (definition) => {
            if (!("contributesTo" in definition.search)) return [];
            const entry = targetEntry(
              collection,
              definition.search.contributesTo,
            );
            if (entry === null) {
              return [`${definition.key}: no entry for its target`];
            }
            const document = new Set(
              [entry.label, ...entry.keywords].map((word) =>
                word.toLowerCase(),
              ),
            );
            return [definition.label, ...definition.keywords]
              .filter((word) => !document.has(word.toLowerCase()))
              .map((word) => `${definition.key}: "${word}"`);
          },
        );
        expect(missing).toEqual([]);
      });
    });
  }
});

describe("settings search fixture registry", () => {
  it("registers every section with an anchored entry, each with a shell", () => {
    const anchoredSections = new Set(
      SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.anchor !== null).map(
        (entry) => entry.section,
      ),
    );
    const registered = SETTINGS_SEARCH_FIXTURES.filter(
      (fixture) => fixture.shells.length > 0,
    ).map((fixture) => fixture.section);
    expect(duplicates(registered)).toEqual([]);
    expect([...registered].sort()).toEqual([...anchoredSections].sort());
  });

  it("turns every anchored entry's gate on in at least one registered shell", () => {
    // Otherwise the executor only ever asserts the entry ABSENT, which a row
    // that never renders passes too.
    const neverAvailable = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) =>
        entry.anchor !== null &&
        !SETTINGS_SEARCH_FIXTURES.some(
          (fixture) =>
            fixture.section === entry.section &&
            fixture.shells.some((shell) => entry.availableWhen(shell.context)),
        ),
    ).map(settingsSearchResultKey);
    expect(neverAvailable).toEqual([]);
  });
});

function duplicates(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function isCollection(value: unknown): value is AnySettingsSectionCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "section" in value &&
    "definitions" in value &&
    "entries" in value
  );
}

function memberLabel(
  collection: AnySettingsSectionCollection,
  key: string,
): string | null {
  const member = collection.input[key];
  return "kind" in member ? member.label : null;
}

function entryShape(entry: SettingsSearchEntry): string {
  return `${entry.kind}:${entry.label}`;
}

function targetEntry(
  collection: AnySettingsSectionCollection,
  target: string,
): SettingsSearchEntry | null {
  if (target === "page") return collection.entries.at(0) ?? null;
  const owner = definitionsByKey(collection).get(target);
  if (owner === undefined || !("anchor" in owner.search)) return null;
  return (
    collection.entries.find(
      (entry) => entry.label === owner.label && entry.anchor === owner.anchor,
    ) ?? null
  );
}

function definitionsByKey(
  collection: AnySettingsSectionCollection,
): ReadonlyMap<string, SettingsDefinition> {
  return new Map(Object.entries(collection.definitions));
}

function tsxFilesUnder(dir: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // `__tests__` is skipped deliberately: a fixture writing an anchor is
      // not a settings surface.
      if (name === "__tests__") continue;
      files.push(...tsxFilesUnder(full));
      continue;
    }
    if (name.endsWith(".tsx")) files.push(full);
  }
  return files;
}
