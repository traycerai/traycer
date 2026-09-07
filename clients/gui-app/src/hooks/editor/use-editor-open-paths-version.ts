import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/** A 1.0 host's request schema rejects those literals at PARSE, so this is the emission gate they share rather than a belt-and-braces check. */
export function useEditorOpenPathsSupportsV11(hostId: string | null): boolean {
  const version = useHostMethodSchemaVersion(hostId, "editor.openPaths");
  return version !== null && version.major === 1 && version.minor >= 1;
}
