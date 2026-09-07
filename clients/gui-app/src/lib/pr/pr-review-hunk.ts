/** A review thread's anchoring hunk, as something the app's diff renderer takes. */
import type { PrReviewThread } from "@traycer/protocol/host/pr-schemas";

/** `@@ -oldStart,oldCount +newStart,newCount @@ optional section heading` */
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export interface PrReviewHunkPatch {
  /** A unified patch `parsePatchFiles` accepts. */
  readonly patch: string;
  /** Whether the gutter would show the file's real line numbers. */
  readonly lineNumbers: boolean;
}

/**
 * How many body lines land on one side.
 * Context counts for both, so the caller asks for `-` to size the old side and `+` to size the new one.
 */
function countHunkSide(lines: readonly string[], marker: "-" | "+"): number {
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith(marker) || line.startsWith(" ")) count += 1;
  }
  return count;
}

/**
 * Every body line carries a prefix character.
 * A line that lost its single leading space in transit reads as an empty string, which a patch parser would take as the end of the hunk rather than as a blank line of code.
 */
function normalizeHunkBody(lines: readonly string[]): readonly string[] {
  const body = [...lines];
  while (body.length > 0 && body[body.length - 1].length === 0) body.pop();
  return body.map((line) => (line.length === 0 ? " " : line));
}

export function buildPrReviewHunkPatch(
  thread: PrReviewThread,
): PrReviewHunkPatch | null {
  if (thread.diffHunk === null) return null;
  const lines = thread.diffHunk.replaceAll("\r", "").split("\n");
  const header = HUNK_HEADER_PATTERN.exec(lines[0]);
  const body = normalizeHunkBody(header === null ? lines : lines.slice(1));
  if (body.length === 0) return null;
  const oldStart = header === null ? 1 : Number.parseInt(header[1], 10);
  const newStart = header === null ? 1 : Number.parseInt(header[2], 10);
  const patch = [
    `diff --git a/${thread.path} b/${thread.path}`,
    `--- a/${thread.path}`,
    `+++ b/${thread.path}`,
    `@@ -${oldStart},${countHunkSide(body, "-")} +${newStart},${countHunkSide(body, "+")} @@`,
    ...body,
    "",
  ].join("\n");
  return { patch, lineNumbers: header !== null };
}
