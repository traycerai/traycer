// @vitest-environment node
/**
 * `escapeNonAsciiJavaScript`'s unit tests exercise the rewrite in isolation,
 * never through a real build - so they cannot see the bug that only shows up
 * once Vite's own plugins run AFTER this one. `vite:build-import-analysis` is
 * a later `generateBundle` hook: for a chunk that holds a dynamic import, it
 * rewrites the `__VITE_PRELOAD__` placeholder, composes that edit onto the
 * chunk's in-memory map, and overwrites the chunk's `.map` asset from the
 * result. A plugin that shifts only the written `.map` asset - and never
 * `output.map`, the object later hooks build on - loses its shift the moment
 * that later hook runs: the asset gets overwritten from an unshifted base map
 * composed with Vite's own edit. This test drives a real rolldown-vite build
 * through a fixture built to trigger exactly that later rewrite (a dynamic
 * import whose target chunk also pulls in CSS, so the preload list is
 * non-empty), then decodes the source map written to disk by hand - no
 * sourcemap library is added - to check it still points at the right
 * original position. It also covers the fix's other half: a prebuilt JS
 * asset pulled in with `?url` is copied in unprocessed by Vite's asset
 * pipeline and needs its own rewrite pass.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { build, parseSync, Visitor } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asciiOnlyOutput } from "../vite/ascii-only-output";

const INDEX_HTML = [
  "<!doctype html>",
  "<html>",
  "  <head></head>",
  "  <body>",
  '    <script type="module" src="/main.js"></script>',
  "  </body>",
  "</html>",
  "",
].join("\n");

// Every marker is a property assignment, not an exported constant: the
// minifier inlines a constant into its one use, and its literal would then map
// to the use rather than to the line this test expects. Each wide string sits
// before its marker, so an unshifted map is off by the escapes' growth.
const MAIN_SOURCE = [
  'import workerUrl from "./prebuilt-worker.mjs?url";',
  'import { sharedValue } from "./shared.js";',
  "",
  'globalThis.mainTitle = "Loading… — done";',
  "",
  "globalThis.mainRaw = String.raw`raw—kept`;",
  "",
  'globalThis.mainMarker = "MARKER_MAIN_AFTER_ESCAPE";',
  "",
  'import("./lazy.js").then((mod) => mod.run());',
  "",
  "console.log(sharedValue, workerUrl);",
  "",
].join("\n");

const SHARED_SOURCE = [
  'globalThis.sharedMessage = "Shared — value…";',
  "",
  'globalThis.sharedMarker = "MARKER_SHARED_AFTER_ESCAPE";',
  "",
  "export const sharedValue = globalThis.sharedMessage;",
  "",
].join("\n");

const LAZY_SOURCE = [
  'import "./lazy.css";',
  'import { sharedValue } from "./shared.js";',
  "",
  'globalThis.lazyMessage = "Lazy — loaded…";',
  "",
  'globalThis.lazyMarker = "MARKER_LAZY_AFTER_ESCAPE";',
  "",
  "export function run() {",
  "  console.log(sharedValue);",
  "  return globalThis.lazyMarker;",
  "}",
  "",
].join("\n");

const LAZY_CSS = [".lazy {", "  color: red;", "}", ""].join("\n");

const WORKER_SOURCE = [
  'self.label = "worker…";',
  "self.pattern = /[—–]/;",
  "",
].join("\n");

const MARKER_EXPECTATIONS: ReadonlyArray<{
  readonly marker: string;
  readonly sourceFile: string;
  readonly sourceText: string;
}> = [
  {
    marker: "MARKER_MAIN_AFTER_ESCAPE",
    sourceFile: "main.js",
    sourceText: MAIN_SOURCE,
  },
  {
    marker: "MARKER_SHARED_AFTER_ESCAPE",
    sourceFile: "shared.js",
    sourceText: SHARED_SOURCE,
  },
  {
    marker: "MARKER_LAZY_AFTER_ESCAPE",
    sourceFile: "lazy.js",
    sourceText: LAZY_SOURCE,
  },
];

interface EmittedJsFile {
  readonly fileName: string;
  readonly fullPath: string;
  readonly code: string;
}

interface EmittedJsChunkWithMap extends EmittedJsFile {
  readonly mapText: string;
}

interface BuildOutput {
  readonly allJsFiles: readonly EmittedJsFile[];
  readonly jsChunksWithMaps: readonly EmittedJsChunkWithMap[];
}

let fixtureDir: string | null = null;
let buildOutput: BuildOutput | null = null;

function requireBuildOutput(): BuildOutput {
  if (buildOutput === null) throw new Error("the fixture build has not run");
  return buildOutput;
}

function listFilesRecursively(root: string): readonly string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listFilesRecursively(full));
    } else {
      paths.push(full);
    }
  }
  return paths;
}

/** The offset of the opening quote of `"marker"` / `'marker'` / `` `marker` ``. */
const QUOTE_CHARS = ['"', "'", "`"] as const;

function findQuotedLiteralOffset(text: string, marker: string): number {
  for (const quote of QUOTE_CHARS) {
    const offset = text.indexOf(`${quote}${marker}${quote}`);
    if (offset !== -1) return offset;
  }
  throw new Error(`could not find a quoted literal for marker: ${marker}`);
}

/** 0-based line/column (UTF-16 units), the source-map convention. */
function lineColumnOf(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Where a tagged template's raw text sits - the one place a wide character may stay raw. */
function taggedTemplateSpans(code: string, fileName: string): readonly Span[] {
  const parsed = parseSync(fileName, code);
  if (parsed.errors.length > 0) {
    throw new Error(`${fileName}: does not parse: ${parsed.errors[0].message}`);
  }
  const rawStarts = new Set<number>();
  const spans: Span[] = [];
  new Visitor({
    TaggedTemplateExpression(node) {
      for (const quasi of node.quasi.quasis) rawStarts.add(quasi.start);
    },
    TemplateElement(node) {
      if (rawStarts.has(node.start)) {
        spans.push({ start: node.start, end: node.end });
      }
    },
  }).visit(parsed.program);
  return spans;
}

function assertAsciiOutsideTaggedTemplates(
  code: string,
  fileName: string,
): void {
  const spans = taggedTemplateSpans(code, fileName);
  for (let index = 0; index < code.length; index += 1) {
    const unit = code.charCodeAt(index);
    if (unit <= 0xff) continue;
    const insideTagged = spans.some(
      (span) => span.start <= index && index < span.end,
    );
    if (!insideTagged) {
      throw new Error(
        `${fileName}: non-ASCII character (0x${unit.toString(16)}) at offset ${index} outside any tagged template`,
      );
    }
  }
}

// No sourcemap library is added: this is a minimal VLQ / `mappings` decoder,
// just enough to look up the segment for one generated column.
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_DIGITS = new Map(
  Array.from(BASE64_CHARS, (character, index) => [character, index] as const),
);

function decodeVlqSegment(segment: string): readonly number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = BASE64_DIGITS.get(character);
    if (digit === undefined) {
      throw new Error(`bad VLQ digit: ${character}`);
    }
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

interface DecodedSegment {
  readonly generatedColumn: number;
  readonly source: {
    readonly sourceIndex: number;
    readonly sourceLine: number;
    readonly sourceColumn: number;
  } | null;
}

/** `mappings`, decoded into one array of segments per generated line. */
function decodeMappings(
  mappings: string,
): ReadonlyArray<readonly DecodedSegment[]> {
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  return mappings.split(";").map((line) => {
    let generatedColumn = 0;
    if (line.length === 0) return [];
    return line.split(",").map((segment) => {
      const fields = decodeVlqSegment(segment);
      generatedColumn += fields[0];
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        sourceLine += fields[2];
        sourceColumn += fields[3];
        return {
          generatedColumn,
          source: { sourceIndex, sourceLine, sourceColumn },
        };
      }
      return { generatedColumn, source: null };
    });
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

interface ParsedSourceMap {
  readonly mappings: string;
  readonly sources: readonly string[];
}

function parseSourceMap(raw: string): ParsedSourceMap {
  const map: unknown = JSON.parse(raw);
  if (
    typeof map !== "object" ||
    map === null ||
    !("mappings" in map) ||
    typeof map.mappings !== "string" ||
    !("sources" in map) ||
    !isStringArray(map.sources)
  ) {
    throw new Error("source map is missing string mappings or a sources array");
  }
  return { mappings: map.mappings, sources: map.sources };
}

function findChunkContaining(
  files: readonly EmittedJsChunkWithMap[],
  marker: string,
): EmittedJsChunkWithMap {
  const matches = files.filter((file) => file.code.includes(marker));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one chunk containing ${marker}, found ${matches.length}`,
    );
  }
  return matches[0];
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ascii-only-build-"));
  fixtureDir = dir;

  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  writeFileSync(join(dir, "main.js"), MAIN_SOURCE);
  writeFileSync(join(dir, "shared.js"), SHARED_SOURCE);
  writeFileSync(join(dir, "lazy.js"), LAZY_SOURCE);
  writeFileSync(join(dir, "lazy.css"), LAZY_CSS);
  writeFileSync(join(dir, "prebuilt-worker.mjs"), WORKER_SOURCE);

  await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [asciiOnlyOutput()],
    build: {
      outDir: join(dir, "dist"),
      emptyOutDir: true,
      sourcemap: "hidden",
      minify: true,
      modulePreload: { polyfill: false },
      // A small asset is otherwise inlined as a data URL and never emitted;
      // pdf.js's worker is far above the limit, so the fixture's must be too.
      assetsInlineLimit: 0,
    },
  });

  const distFiles = listFilesRecursively(join(dir, "dist"));
  const allJsFiles: EmittedJsFile[] = [];
  for (const fullPath of distFiles) {
    const fileName = basename(fullPath);
    if (!/\.m?js$/.test(fileName)) continue;
    allJsFiles.push({
      fileName,
      fullPath,
      code: readFileSync(fullPath, "utf8"),
    });
  }
  const jsChunksWithMaps: EmittedJsChunkWithMap[] = [];
  for (const file of allJsFiles) {
    const mapPath = `${file.fullPath}.map`;
    if (!existsSync(mapPath)) continue;
    jsChunksWithMaps.push({ ...file, mapText: readFileSync(mapPath, "utf8") });
  }
  buildOutput = { allJsFiles, jsChunksWithMaps };
}, 60_000);

afterAll(() => {
  if (fixtureDir !== null) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("asciiOnlyOutput (real rolldown-vite build)", () => {
  it("produces the chunk graph the fixture is built for", () => {
    const { jsChunksWithMaps } = requireBuildOutput();
    // The entry and the dynamic import's chunk at least; rolldown may fold
    // `shared.js` into the entry. Each marker must sit in exactly one chunk.
    expect(jsChunksWithMaps.length).toBeGreaterThanOrEqual(2);
    for (const { marker } of MARKER_EXPECTATIONS) {
      expect(() => findChunkContaining(jsChunksWithMaps, marker)).not.toThrow();
    }
  });

  it("keeps every emitted chunk and asset ASCII outside tagged templates", () => {
    const { allJsFiles } = requireBuildOutput();
    expect(allJsFiles.length).toBeGreaterThan(0);
    for (const file of allJsFiles) {
      expect(() =>
        assertAsciiOutsideTaggedTemplates(file.code, file.fileName),
      ).not.toThrow();
    }
  });

  it("keeps the tagged template's raw text untouched", () => {
    const mainChunk = findChunkContaining(
      requireBuildOutput().jsChunksWithMaps,
      "MARKER_MAIN_AFTER_ESCAPE",
    );
    expect(mainChunk.code.includes("raw—kept")).toBe(true);
  });

  it("really rewrites the dynamic-import chunk (not a vacuous check)", () => {
    const mainChunk = findChunkContaining(
      requireBuildOutput().jsChunksWithMaps,
      "MARKER_MAIN_AFTER_ESCAPE",
    );
    expect(mainChunk.code.includes("\\u2026")).toBe(true);
    expect(mainChunk.code.includes("…")).toBe(false);
  });

  it("rewrites a prebuilt JS asset copied in unprocessed via a `?url` import", () => {
    const worker = requireBuildOutput().allJsFiles.find(
      (file) =>
        file.fileName.startsWith("prebuilt-worker") &&
        file.fileName.endsWith(".mjs"),
    );
    if (worker === undefined) {
      throw new Error("prebuilt-worker.mjs asset was not emitted");
    }
    expect(worker.code.includes("\\u2026")).toBe(true);
    expect(worker.code.includes("…")).toBe(false);
  });

  it("keeps each written source map pointing at the marker's real original position", () => {
    for (const { marker, sourceFile, sourceText } of MARKER_EXPECTATIONS) {
      const chunk = findChunkContaining(
        requireBuildOutput().jsChunksWithMaps,
        marker,
      );
      const written = lineColumnOf(
        chunk.code,
        findQuotedLiteralOffset(chunk.code, marker),
      );
      const map = parseSourceMap(chunk.mapText);
      const decoded = decodeMappings(map.mappings);
      const lineSegments = decoded[written.line];
      const segment = lineSegments.find(
        (entry) => entry.generatedColumn === written.column,
      );
      if (segment === undefined || segment.source === null) {
        throw new Error(
          `${chunk.fileName}: no source mapping at ${written.line}:${written.column} for ${marker}`,
        );
      }

      const sourceEntry = map.sources[segment.source.sourceIndex];
      expect(sourceEntry.endsWith(sourceFile)).toBe(true);

      const original = lineColumnOf(
        sourceText,
        findQuotedLiteralOffset(sourceText, marker),
      );
      expect(segment.source.sourceLine).toBe(original.line);
      expect(segment.source.sourceColumn).toBe(original.column);
    }
  });
});
