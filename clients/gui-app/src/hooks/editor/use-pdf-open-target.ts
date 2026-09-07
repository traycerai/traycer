import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";
import { useEffectiveDefaultEditor } from "@/hooks/editor/use-effective-default-editor";

/**
 * PDFs emit `"system"` only when `editor.openPaths` >= 1.1. A 1.0 host or unknown handshake falls back to the default editor rather than a rejected RPC.
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
