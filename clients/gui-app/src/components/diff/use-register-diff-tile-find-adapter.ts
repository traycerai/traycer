import { useMemo } from "react";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import {
  createDiffTileFindAdapter,
  type DiffTileFindRenderer,
  type DiffTileFindSource,
} from "@/stores/tile-find";

export function useRegisterDiffTileFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly source: DiffTileFindSource;
  readonly renderer: DiffTileFindRenderer | null;
}): void {
  const adapter = useMemo(
    () =>
      createDiffTileFindAdapter({
        tileInstanceId: args.tileInstanceId,
        tileKind: args.tileKind,
        source: args.source,
        renderer: args.renderer,
      }),
    [args.renderer, args.source, args.tileInstanceId, args.tileKind],
  );
  useRegisterTileFindAdapter(adapter);
}
