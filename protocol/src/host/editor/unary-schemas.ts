import { z } from "zod";

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  /**
   * URL-scheme handler the editor registers automatically on install (e.g.
   * `vscode://`). Opening `<scheme>://file/<absolute-path>` through the OS
   * opener launches the editor without depending on its (opt-in) shell CLI
   * being installed on the host's PATH.
   */
  readonly urlScheme: string;
};

export const EDITORS = [
  { id: "vscode", label: "VS Code", urlScheme: "vscode" },
  { id: "cursor", label: "Cursor", urlScheme: "cursor" },
  { id: "windsurf", label: "Windsurf", urlScheme: "windsurf" },
  { id: "zed", label: "Zed", urlScheme: "zed" },
  { id: "vscodium", label: "VSCodium", urlScheme: "vscodium" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export type EditorEntry = (typeof EDITORS)[number];
export type EditorId = EditorEntry["id"];

const EDITOR_IDS = EDITORS.map((e) => e.id) as [EditorId, ...EditorId[]];

export const editorIdSchema = z.enum(EDITOR_IDS);

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === "string" && EDITOR_IDS.includes(value as EditorId);
}

/**
 * The 1.0 `editorId` enum, spelled out as literals: `EDITORS` is a live
 * registry that grows and a versioned request schema may not. `satisfies`
 * keeps every id here a real registry entry.
 */
const V10_EDITOR_IDS = [
  "vscode",
  "cursor",
  "windsurf",
  "zed",
] as const satisfies ReadonlyArray<EditorId>;

export const editorIdSchemaV10 = z.enum(V10_EDITOR_IDS);

/** v1.0 request - frozen. A 1.0 host rejects any other `editorId` at parse. */
export const openPathsRequestSchema = z.object({
  editorId: editorIdSchemaV10,
  paths: z.array(z.string()).nonempty(),
});

/**
 * Accepted from 1.1: every `EDITORS` id, plus two targets that are
 * deliberately not registry entries - they have no URL scheme and must never
 * appear in the default-editor picker, which iterates `EDITORS`:
 *
 * - `"system"` opens a path with the OS default application instead of an
 *   editor deep link - the target for formats an editor renders poorly (PDFs).
 * - `"finder"` shows a path in the host's file manager: a directory opens as a
 *   window, a file is revealed selected inside its parent. macOS only; the
 *   host rejects it on any other platform.
 *
 * A client emits one of these, or an `EDITORS` id outside the frozen 1.0 set,
 * only once the handshake negotiated `editor.openPaths >= 1.1` - and
 * `"finder"` only when that host is the local Mac.
 */
export const openPathsTargetSchema = editorIdSchema
  .or(z.literal("system"))
  .or(z.literal("finder"));
export type OpenPathsTarget = z.infer<typeof openPathsTargetSchema>;

/** v1.1 request: v1.0 with the `editorId` enum widened. */
export const openPathsRequestSchemaV11 = z.object({
  editorId: openPathsTargetSchema,
  paths: z.array(z.string()).nonempty(),
});

export type OpenPathsRequest = z.infer<typeof openPathsRequestSchemaV11>;

export const openPathsResponseSchema = z.object({});
export type OpenPathsResponse = z.infer<typeof openPathsResponseSchema>;
