import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Main owns every `browser.sessions` socket, so a synchronous dialog anywhere
 * on the browser plane stalls them all (traycerai/traycer#2420). This scan
 * keeps the plane free of them.
 */

const electronMainRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SYNC_DIALOG_PATTERNS: readonly RegExp[] = [
  /\bdialog\s*\.\s*\w*Sync\s*\(/,
  /\bshowMessageBoxSync\b/,
  /\bshowSaveDialogSync\b/,
  /\bshowOpenDialogSync\b/,
  /\bshowErrorBox\b/,
];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function matchesSyncDialog(line: string): boolean {
  return SYNC_DIALOG_PATTERNS.some((pattern) => pattern.test(line));
}

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function scannedFiles(): string[] {
  return [
    ...collectSourceFiles(join(electronMainRoot, "browser-view")),
    ...collectSourceFiles(join(electronMainRoot, "browser-sessions")),
    join(electronMainRoot, "ipc", "browser-view-ipc.ts"),
    join(electronMainRoot, "app", "confirm-destructive.ts"),
  ];
}

describe("no synchronous dialog on the browser plane", () => {
  it("matches the synchronous forms and only those", () => {
    expect(matchesSyncDialog("dialog.showSaveDialogSync({")).toBe(true);
    expect(matchesSyncDialog("dialog . showMessageBoxSync(")).toBe(true);
    expect(matchesSyncDialog("const { showOpenDialogSync } = dialog")).toBe(
      true,
    );
    expect(matchesSyncDialog("await dialog.showMessageBox(")).toBe(false);
    expect(matchesSyncDialog("fs.existsSync(path)")).toBe(false);
  });

  it("scans a real set of files and finds no synchronous dialog in them", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (matchesSyncDialog(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
