import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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
  { id: "code-oss", label: "Code - OSS", urlScheme: "code-oss" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export type EditorEntry = (typeof EDITORS)[number];
export type EditorId = EditorEntry["id"];

const EDITOR_IDS = EDITORS.map((e) => e.id) as [EditorId, ...EditorId[]];

export const editorIdSchema = lazySchema(() => z.enum(EDITOR_IDS));

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

export const editorIdSchemaV10 = lazySchema(() => z.enum(V10_EDITOR_IDS));

/** v1.0 request - frozen. A 1.0 host rejects any other `editorId` at parse. */
export const openPathsRequestSchema = lazySchema(() =>
  z.object({
    editorId: editorIdSchemaV10,
    paths: z.array(z.string()).nonempty(),
  }),
);

/**
 * The 1.1 and 1.2 `editorId` ids, spelled out for the same reason as 1.0: the
 * live registry grows, a released minor's request schema may not. `"code-oss"`
 * joined `EDITORS` after 1.2 shipped and is legal from 1.3 only.
 */
const V11_EDITOR_IDS = [
  "vscode",
  "cursor",
  "windsurf",
  "zed",
  "vscodium",
] as const satisfies ReadonlyArray<EditorId>;

/**
 * The 1.1 / 1.2 target enum: the frozen editor set plus the two targets below.
 *
 * Accepted from 1.1: the editors above, plus two targets that are
 * deliberately not registry entries - they have no URL scheme and must never
 * appear in the default-editor picker, which iterates `EDITORS`:
 *
 * - `"system"` opens a path with the OS default application instead of an
 *   editor deep link - the target for formats an editor renders poorly (PDFs
 *   from 1.1, Word `.docx` documents from 1.2).
 * - `"finder"` shows a path in the host's file manager: a directory opens as a
 *   window, a file is revealed selected inside its parent. macOS only; the
 *   host rejects it on any other platform.
 *
 * A client emits one of these, or an `EDITORS` id outside the frozen 1.0 set,
 * only once the handshake negotiated `editor.openPaths >= 1.1` - and
 * `"finder"` only when that host is the local Mac.
 */
export const openPathsTargetSchemaV11 = lazySchema(() =>
  z.enum(V11_EDITOR_IDS).or(z.literal("system")).or(z.literal("finder")),
);

/**
 * Accepted from 1.3: every live `EDITORS` id (`"code-oss"` is the first one
 * outside the 1.1 set) plus `"system"` and `"finder"`. Built from the registry,
 * so appending an editor widens THIS schema in place - which is why the next
 * editor opens 1.4 and freezes this list the way 1.1's is frozen.
 */
export const openPathsTargetSchema = lazySchema(() =>
  editorIdSchema.or(z.literal("system")).or(z.literal("finder")),
);
export type OpenPathsTarget = z.infer<typeof openPathsTargetSchema>;

/** v1.1 / v1.2 request: v1.0 with the `editorId` enum widened. */
export const openPathsRequestSchemaV11 = lazySchema(() =>
  z.object({
    editorId: openPathsTargetSchemaV11,
    paths: z.array(z.string()).nonempty(),
  }),
);

/** v1.3 request: 1.1's with `"code-oss"` (and any later registry id) legal. */
export const openPathsRequestSchemaV13 = lazySchema(() =>
  z.object({
    editorId: openPathsTargetSchema,
    paths: z.array(z.string()).nonempty(),
  }),
);

export type OpenPathsRequest = z.infer<typeof openPathsRequestSchemaV13>;

export const openPathsResponseSchema = lazySchema(() => z.object({}));
export type OpenPathsResponse = z.infer<typeof openPathsResponseSchema>;
