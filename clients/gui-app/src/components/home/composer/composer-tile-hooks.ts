import { use } from "react";
import { ComposerTileIdContext } from "@/components/home/composer/composer-tile-context-internal";

export function useComposerTileId(): string {
  return use(ComposerTileIdContext);
}
