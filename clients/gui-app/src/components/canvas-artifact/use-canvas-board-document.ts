import { canvasQueryKeys } from "@/lib/query-keys/canvas-query-keys";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { readCanvasBoardDocument } from "./canvas-board-document";

export function useCanvasBoardDocument(
  artifactId: string,
  path: string,
  registry: CanvasFrameRegistry,
  active: boolean,
) {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const source = registry.get(path).source;
  const hash =
    source?.kind === "artifact" &&
    Object.hasOwn(source.manifest.files, source.entryPath)
      ? source.manifest.files[source.entryPath].sha256
      : null;
  return useQuery(
    queryOptions({
      queryKey: canvasQueryKeys.source(artifactId, path, hash, source),
      enabled: active && hash !== null,
      staleTime: Infinity,
      retry: false,
      queryFn: ({ signal }) => {
        if (source === null) throw new Error("This artboard is unavailable.");
        return readCanvasBoardDocument(source, signal);
      },
    }),
  );
}
