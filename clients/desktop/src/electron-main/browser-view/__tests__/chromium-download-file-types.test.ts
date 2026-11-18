import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS,
  CHROMIUM_DOWNLOAD_FILE_TYPES_VERSION,
} from "../chromium-download-file-types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "chromium-download-file-types.asciipb",
);

const ENFORCED_PLATFORMS: ReadonlySet<string> = new Set([
  "PLATFORM_TYPE_ANY",
  "PLATFORM_TYPE_WINDOWS",
  "PLATFORM_TYPE_MAC",
  "PLATFORM_TYPE_LINUX",
]);
const DANGEROUS_LEVELS: ReadonlySet<string> = new Set([
  "DANGEROUS",
  "ALLOW_ON_USER_GESTURE",
]);

interface ParsedTable {
  readonly blockCount: number;
  readonly dangerous: readonly string[];
}

/** Returns the text between the brace opened at `open` and its match. */
function braceBody(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error("unbalanced braces in fixture");
}

function blocksNamed(text: string, name: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(`(^|\\s)${name}\\s*\\{`, "g");
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    bodies.push(braceBody(text, open));
  }
  return bodies;
}

function parseTable(raw: string): ParsedTable {
  const text = raw
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
  const blocks = blocksNamed(text, "file_types");
  const dangerous: string[] = [];
  for (const block of blocks) {
    const extension = /extension:\s*"([^"]+)"/.exec(block)?.[1];
    if (extension === undefined)
      throw new Error("file_types without extension");
    const isDangerous = blocksNamed(block, "platform_settings").some(
      (setting) => {
        const platform =
          /platform:\s*(\w+)/.exec(setting)?.[1] ?? "PLATFORM_TYPE_ANY";
        const level =
          /danger_level:\s*(\w+)/.exec(setting)?.[1] ?? "NOT_DANGEROUS";
        return ENFORCED_PLATFORMS.has(platform) && DANGEROUS_LEVELS.has(level);
      },
    );
    if (isDangerous) dangerous.push(`.${extension.toLowerCase()}`);
  }
  return { blockCount: blocks.length, dangerous: dangerous.sort() };
}

describe("Chromium download file types", () => {
  const raw = readFileSync(FIXTURE, "utf8");
  const table = parseTable(raw);

  it("parses a real table, not an empty one", () => {
    expect(table.blockCount).toBeGreaterThan(300);
    expect(table.dangerous.length).toBeGreaterThan(100);
  });

  it("lists exactly the extensions the vendored table marks dangerous", () => {
    expect(table.dangerous).toEqual(
      [...CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS].sort(),
    );
  });

  it("records the version of the vendored table", () => {
    const version = /^version_id:\s*(\d+)/m.exec(raw)?.[1];
    expect(Number(version)).toBe(CHROMIUM_DOWNLOAD_FILE_TYPES_VERSION);
  });

  it("keeps every extension the hand-kept list had", () => {
    for (const extension of [
      ".app",
      ".applescript",
      ".bat",
      ".cmd",
      ".command",
      ".com",
      ".cpl",
      ".dmg",
      ".exe",
      ".hta",
      ".jar",
      ".js",
      ".jse",
      ".msi",
      ".pkg",
      ".ps1",
      ".reg",
      ".scr",
      ".sh",
      ".vb",
      ".vbe",
      ".vbs",
      ".wsf",
    ]) {
      expect(CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)).toBe(true);
    }
  });

  it("includes the types the hand list missed and excludes plain data", () => {
    for (const extension of [
      ".pif",
      ".scf",
      ".lnk",
      ".msix",
      ".deb",
      ".desktop",
    ]) {
      expect(CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)).toBe(true);
    }
    for (const extension of [".txt", ".pdf", ".zip", ".png", ".csv"]) {
      expect(CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)).toBe(false);
    }
  });
});
