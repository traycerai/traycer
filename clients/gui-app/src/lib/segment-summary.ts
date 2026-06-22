/**
 * Tool-input display helpers for agent segment headers.
 * `deriveToolInputSummary` is shared with the host harness converters (so the
 * activity view and a sub-agent's progress view can't drift) and re-exported
 * here for the segment headers. Unrelated to composer prompt parsing; see
 * src/lib/composer/segments.ts for mention tokenization.
 */
import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";

export { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";

// File-path keys edit/write tools carry across harnesses, in priority order.
// Claude's Edit/Write/NotebookEdit use snake_case (`file_path`,
// `notebook_path`); codex/cursor/opencode use `path`/`filePath`/`file`.
const FILE_PATH_KEYS = [
  "path",
  "filePath",
  "file",
  "file_path",
  "notebook_path",
];

/**
 * Best-effort file path from a tool call's precomputed `inputDetail` (the raw
 * harness input is no longer persisted), used by the activity-group edited-files
 * dedup so the field list can't drift from the host's derivation. Scans the
 * `fields` entries for the first edit/write path key; returns null for a
 * command-kind detail or when no path key resolves.
 */
export function filePathFromInputDetail(
  detail: ToolInputDetail | null,
): string | null {
  if (detail === null || detail.kind !== "fields") return null;
  for (const key of FILE_PATH_KEYS) {
    const entry = detail.entries.find((candidate) => candidate.key === key);
    if (entry !== undefined && entry.value.trim().length > 0) {
      return entry.value;
    }
  }
  return null;
}
