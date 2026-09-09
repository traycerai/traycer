import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/** The `editor.openPaths` version `hostId` negotiated, or `null` before its first handshake. */
export function useEditorOpenPathsVersion(
  hostId: string | null,
): { readonly major: number; readonly minor: number } | null {
  return useHostMethodSchemaVersion(hostId, "editor.openPaths");
}

/**
 * Whether `hostId` negotiated `editor.openPaths` 1.1 - the minor that widened
 * the request's target enum past the frozen 1.0 editor set with `"system"`,
 * `"finder"`, and every later `EDITORS` id.
 *
 * A 1.0 host's request schema rejects those literals at PARSE, so this is the
 * emission gate they share rather than a belt-and-braces check. Fails closed:
 * `null` (no handshake with that host yet) reads as unsupported.
 */
export function useEditorOpenPathsSupportsV11(hostId: string | null): boolean {
  const version = useEditorOpenPathsVersion(hostId);
  return version !== null && version.major === 1 && version.minor >= 1;
}
