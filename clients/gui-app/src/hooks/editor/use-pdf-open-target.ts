import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";
import { useEffectiveDefaultEditor } from "@/hooks/editor/use-effective-default-editor";

/**
 * The `editor.openPaths` target for a PDF surface's Open Externally action.
 *
 * PDFs are the format the settled design routes to the OS default
 * application (`"system"`, added in editor.openPaths 1.1) instead of the
 * user's code editor - an editor shows a binary-file notice for a PDF,
 * while images and text render fine there and deliberately keep the
 * editor target.
 *
 * `"system"` is emission-gated on the negotiated version: a 1.0 host's
 * request schema hard-rejects the literal, so an old host gets today's
 * exact behavior (the default editor) instead - never a failed RPC. The
 * unknown state (`null` before the first handshake) also falls back, the
 * same fails-closed reading every optional-capability gate uses.
 */
export function usePdfOpenExternallyTarget(
  hostId: string | null,
): OpenPathsTarget {
  const systemSupported = useEditorOpenPathsSupportsV11(hostId);
  // Resolved against the SAME host, so a stored default that host cannot
  // accept never rides the fallback onto the wire.
  const effectiveDefaultEditor = useEffectiveDefaultEditor(hostId);
  return systemSupported ? "system" : effectiveDefaultEditor;
}
