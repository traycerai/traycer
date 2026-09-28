import type { ReactNode } from "react";
import { ComposerTileIdContext } from "@/components/home/composer/composer-tile-context-internal";

/**
 * Provided once near a composer's root - `ChatComposer` (value = the chat's
 * task id) or the landing composer body (value = `"landing"`) - so every
 * toolbar leaf below it can register its `sidebar`-style hotspot with a
 * `tileId` it did not have to be handed prop by prop.
 */
export function ComposerTileIdProvider(props: {
  readonly tileId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ComposerTileIdContext.Provider value={props.tileId}>
      {props.children}
    </ComposerTileIdContext.Provider>
  );
}
