import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import type { DocumentAssetKind } from "@/lib/assets/image-extension-allowlist";
import { useEditorOpenPathsVersion } from "@/hooks/editor/use-editor-open-paths-version";
import { useEffectiveDefaultEditor } from "@/hooks/editor/use-effective-default-editor";

/**
 * The `editor.openPaths` minor from which the host's `"system"` target
 * accepts each document format. PDF came with the target itself (1.1); Word
 * documents were admitted in 1.2 - a schema-identical BEHAVIOR minor whose
 * whole point is this table.
 */
const SYSTEM_TARGET_MINIMUM_MINOR: Record<DocumentAssetKind, number> = {
  pdf: 1,
  docx: 2,
};

/**
 * The `editor.openPaths` target for a document surface's Open Externally
 * action.
 *
 * Documents are the formats the settled design routes to the OS default
 * application (`"system"`) instead of the user's code editor - an editor
 * shows a binary-file notice for a PDF or a Word file, while images and text
 * render fine there and deliberately keep the editor target.
 *
 * `"system"` is emission-gated on the negotiated version: a 1.0 host's
 * request schema hard-rejects the literal, and a 1.1 host rejects a `.docx`
 * path behind it, so an older host gets today's exact behavior (the default
 * editor) instead - never a failed RPC. The unknown state (`null` before the
 * first handshake) also falls back, the same fails-closed reading every
 * optional-capability gate uses.
 */
export function useDocumentOpenExternallyTarget(
  hostId: string | null,
  kind: DocumentAssetKind,
): OpenPathsTarget {
  const version = useEditorOpenPathsVersion(hostId);
  const systemSupported =
    version !== null &&
    version.major === 1 &&
    version.minor >= SYSTEM_TARGET_MINIMUM_MINOR[kind];
  // Resolved against the SAME host, so a stored default that host cannot
  // accept never rides the fallback onto the wire.
  const effectiveDefaultEditor = useEffectiveDefaultEditor(hostId);
  return systemSupported ? "system" : effectiveDefaultEditor;
}
