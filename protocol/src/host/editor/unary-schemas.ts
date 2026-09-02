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
] as const satisfies ReadonlyArray<EditorDefinition>;

export type EditorId = (typeof EDITORS)[number]["id"];

const EDITOR_IDS = EDITORS.map((e) => e.id) as [EditorId, ...EditorId[]];

export const editorIdSchema = z.enum(EDITOR_IDS);

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === "string" && EDITOR_IDS.includes(value as EditorId);
}

/**
 * v1.0 request - frozen. Its `editorId` enum is exactly the `EDITORS`
 * registry; a 1.0 host hard-rejects anything else at parse, which is what
 * makes the client-side version gate on `"system"` (below) load-bearing.
 */
export const openPathsRequestSchema = z.object({
  editorId: editorIdSchema,
  paths: z.array(z.string()).nonempty(),
});

/**
 * Added in 1.1: `"system"` opens the paths with the OS default application
 * (plain path through the OS opener) instead of an editor deep link - the
 * open target for formats an editor renders poorly (PDFs). Deliberately NOT
 * an `EDITORS` entry: it has no URL scheme and must never appear in the
 * default-editor picker, which iterates that registry. A client must only
 * emit `"system"` when the handshake negotiated `editor.openPaths >= 1.1`.
 */
export const openPathsTargetSchema = editorIdSchema.or(z.literal("system"));
export type OpenPathsTarget = z.infer<typeof openPathsTargetSchema>;

/** v1.1 request: v1.0 with the `editorId` enum widened by `"system"`. */
export const openPathsRequestSchemaV11 = z.object({
  editorId: openPathsTargetSchema,
  paths: z.array(z.string()).nonempty(),
});

export type OpenPathsRequest = z.infer<typeof openPathsRequestSchemaV11>;

export const openPathsResponseSchema = z.object({});
export type OpenPathsResponse = z.infer<typeof openPathsResponseSchema>;
