import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import {
  resolveManifestPath,
  type ArtifactReadSpanResult,
} from "@/lib/sandbox/artifact-serving";

/** The most of a document the driver asks for in one read. */
export const DOCUMENT_READ_BYTES = 64 * 1024;

type ArtifactSource = Extract<
  SandboxFrameProps["source"],
  { kind: "artifact" }
>;

let mountedSource: ArtifactSource | null = null;

/** The driver tells this module which artifact source it is showing, `null` when none. */
export function setMountedArtifactSource(source: ArtifactSource | null): void {
  mountedSource = source;
}

/**
 * What the browser does when the page asks for a sibling asset: reads that
 * manifest path through the mounted source's own `readSpan`. `"no-such-asset"`
 * when nothing is mounted or the manifest names no such path.
 */
export async function requestSiblingAsset(
  path: string,
): Promise<ArtifactReadSpanResult | "no-such-asset"> {
  if (mountedSource === null) return "no-such-asset";
  const entry = resolveManifestPath(mountedSource.manifest, path);
  if (entry === null) return "no-such-asset";
  return mountedSource.readSpan(
    entry.sha256,
    0,
    Math.max(1, Math.min(entry.byteLength, DOCUMENT_READ_BYTES)),
    new AbortController().signal,
  );
}
