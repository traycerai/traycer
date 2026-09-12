import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { app, shell } from "electron";

/**
 * Where a browser tile's saved screenshots live, and the only place a reveal is
 * allowed to point at.
 *
 * ## Why main writes the file
 *
 * A capture already crosses to the renderer as base64 for the tile that asked
 * for it, so the renderer could in principle save its own. It must not: the
 * bytes are a picture of whatever page the guest is on, the path would be
 * renderer-chosen, and "reveal this path" is then an arbitrary
 * `showItemInFolder` a compromised renderer can aim anywhere on the disk. Main
 * owns both halves instead - it picks the directory, mints the filename, and
 * refuses to reveal anything outside the directory it owns.
 *
 * ## Why the filename is derived, not supplied
 *
 * The renderer names nothing. A caller-supplied name is a path-traversal
 * surface (`../../`), a collision surface, and a place for page-controlled text
 * (a document title) to reach the filesystem. The name is minted here from the
 * capture time, a short digest of the bytes, and a random segment, so it says
 * nothing a page chose and no two saves can name the same file.
 *
 * The random segment is what makes it per-SAVE rather than per-image. Time to the
 * second plus a content digest is the same string for two captures of a still
 * page taken a moment apart, so the second write replaced the first: the user
 * pressed the button twice, was told a path twice, and had one file. A screenshot
 * is a record of an action, and two actions are two records even when the pixels
 * agree.
 */
const CAPTURE_DIR_NAME = "browser-captures";

export interface BrowserCaptureSaveInput {
  readonly bytes: Uint8Array;
  readonly capturedAt: number;
}

export interface BrowserCaptureSaveResult {
  readonly path: string;
  readonly byteLength: number;
}

/** Absolute path of the directory this module owns. */
export function browserCaptureDir(): string {
  return join(app.getPath("userData"), CAPTURE_DIR_NAME);
}

/** Writes one PNG capture and answers where it landed. */
export async function saveBrowserCapture(
  input: BrowserCaptureSaveInput,
): Promise<BrowserCaptureSaveResult> {
  const dir = browserCaptureDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, browserCaptureFileName(input));
  await writeFile(path, input.bytes);
  return { path, byteLength: input.bytes.byteLength };
}

/**
 * Reveals a saved capture in the OS file manager.
 *
 * Refuses any path outside {@link browserCaptureDir}, compared after resolving
 * both sides so `..` segments cannot walk out of it. Returns whether the reveal
 * happened rather than throwing: a caller that quotes a stale path gets a
 * `false`, and a refusal is not an error the user needs reported.
 */
export function revealBrowserCapture(path: string): boolean {
  if (!isInsideCaptureDir(path)) return false;
  shell.showItemInFolder(path);
  return true;
}

export function isInsideCaptureDir(path: string): boolean {
  const dir = resolve(browserCaptureDir());
  const target = resolve(path);
  // The separator check is what stops a sibling directory whose name merely
  // starts with the same characters from passing as a child.
  return target.startsWith(dir + sep);
}

export function browserCaptureFileName(
  input: BrowserCaptureSaveInput,
): string {
  const digest = createHash("sha256")
    .update(input.bytes)
    .digest("hex")
    .slice(0, 12);
  return `page-${timestampSegment(input.capturedAt)}-${digest}-${uniqueSegment()}.png`;
}

/**
 * A short random segment, so one save never overwrites another.
 *
 * Random rather than a counter: a counter has to be stored somewhere, and it
 * restarts with the process while the files it was distinguishing do not.
 */
function uniqueSegment(): string {
  return randomBytes(4).toString("hex");
}

/**
 * A sortable, filename-safe stamp. Colons are legal on POSIX and not on
 * Windows, and a name that differs per platform is a name that cannot be
 * reasoned about, so the time separators are dropped rather than escaped.
 */
function timestampSegment(capturedAt: number): string {
  const at = Number.isFinite(capturedAt) ? new Date(capturedAt) : new Date();
  const iso = at.toISOString();
  return iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}
