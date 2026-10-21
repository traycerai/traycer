import { useEffect, useState } from "react";
import { EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES } from "@traycer/protocol/host/epic/artifact-objects";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
/** Image notes use the same authorised object byte port as boards. */
export function CanvasImage({
  source,
  label,
}: {
  readonly source: SandboxSource | null;
  readonly label: string;
}) {
  const [image, setImage] = useState<{
    source: SandboxSource;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (source?.kind !== "artifact") return;
    const entry = Object.hasOwn(source.manifest.files, source.entryPath)
      ? source.manifest.files[source.entryPath]
      : null;
    if (
      entry === null ||
      !entry.mediaType.startsWith("image/") ||
      entry.byteLength > 32 * 1024 * 1024
    )
      return;
    const abort = new AbortController();
    let url: string | null = null;
    const load = async (): Promise<void> => {
      const parts: ArrayBuffer[] = [];
      for (let offset = 0; offset < entry.byteLength;) {
        const span = await source.readSpan(
          entry.sha256,
          offset,
          Math.min(
            EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
            entry.byteLength - offset,
          ),
          abort.signal,
        );
        abort.signal.throwIfAborted();
        if ("unavailable" in span || span.bytes.length === 0) return;
        parts.push(Uint8Array.from(span.bytes).buffer);
        offset += span.bytes.length;
      }
      url = URL.createObjectURL(new Blob(parts, { type: entry.mediaType }));
      setImage({ source, url });
    };
    void load().catch(() => undefined);
    return () => {
      abort.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [source]);
  return image?.source === source ? (
    <img
      src={image.url}
      alt={label}
      draggable={false}
      className="h-full w-full object-contain"
    />
  ) : (
    <div className="flex h-full items-center justify-center text-ui-sm text-muted-foreground">
      Image unavailable
    </div>
  );
}
