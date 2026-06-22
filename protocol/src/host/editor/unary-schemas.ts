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

export const openPathsRequestSchema = z.object({
  editorId: editorIdSchema,
  paths: z.array(z.string()).nonempty(),
});

export type OpenPathsRequest = z.infer<typeof openPathsRequestSchema>;

export const openPathsResponseSchema = z.object({});
export type OpenPathsResponse = z.infer<typeof openPathsResponseSchema>;
