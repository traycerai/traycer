import { useEffect, useEffectEvent, type ReactNode } from "react";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { resolveManifestPath } from "@/lib/sandbox/artifact-serving";
import {
  DOCUMENT_READ_BYTES,
  setMountedArtifactSource,
} from "@/components/sandbox/__tests__/artifact-frame-browser-driver-source";

/**
 * TEST-ONLY stand-in for the browser half of `SandboxFrame`, for suites that
 * prove the object port and the shared renderer, not the iframe.
 *
 * JSDOM never fetches a served artifact URL, so the real frame reads nothing
 * here. This renders one iframe and does what the browser's request for the
 * entry document makes the artifact server do: it reads that document through
 * the source's own `readSpan`, so the host request, its lifetime and any
 * cancellation are the real ones. The entry is the manifest path the source
 * names (`index.html` when it names none), resolved with the artifact-serving
 * path semantics.
 *
 * It proves NOTHING about a real iframe, one instance across Expand, or the
 * bridge handshake; the browser fixtures own those.
 */
export function ArtifactFrameBrowserDriver(
  props: SandboxFrameProps,
): ReactNode {
  const { source } = props;
  const onStatus = useEffectEvent(props.onStatus);
  const manifest = source.kind === "artifact" ? source.manifest : null;
  const readSpan = source.kind === "artifact" ? source.readSpan : null;
  const entryPath = source.kind === "artifact" ? source.entryPath : null;

  useEffect(() => {
    if (manifest === null || readSpan === null || entryPath === null) return;
    const entry = resolveManifestPath(
      manifest,
      entryPath === "" ? "index.html" : entryPath,
    );
    if (entry === null) {
      onStatus("crashed");
      return;
    }
    const controller = new AbortController();
    onStatus("loading");
    readSpan(
      entry.sha256,
      0,
      Math.max(1, Math.min(entry.byteLength, DOCUMENT_READ_BYTES)),
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        onStatus("unavailable" in result ? "crashed" : "ready");
      },
      () => {
        if (!controller.signal.aborted) onStatus("crashed");
      },
    );
    return () => controller.abort();
  }, [entryPath, manifest, readSpan]);

  // Kept apart from the read: a new source object alone never refetches.
  useEffect(() => {
    if (source.kind === "artifact") setMountedArtifactSource(source);
    return () => setMountedArtifactSource(null);
  }, [source]);

  return <iframe title={props.title} data-testid="artifact-frame-driver" />;
}
