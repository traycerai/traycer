import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

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
  const version = useHostMethodSchemaVersion(hostId, "editor.openPaths");
  return version !== null && version.major === 1 && version.minor >= 1;
}
