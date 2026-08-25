import type { ReactNode } from "react";
import { TileMinimapContext } from "@/components/epic-canvas/tile-minimap/tile-minimap-context";

interface TileMinimapScopeProps {
  readonly tileInstanceId: string;
  readonly children: ReactNode;
}

/**
 * Names the tile a render subtree belongs to, so content deep inside it can
 * publish an outline the phone tile bar renders a button for.
 *
 * Provider only, no DOM - a plain string value, so it never re-renders the
 * subtree for a reason of its own.
 */
export function TileMinimapScope(props: TileMinimapScopeProps): ReactNode {
  return (
    <TileMinimapContext.Provider value={props.tileInstanceId}>
      {props.children}
    </TileMinimapContext.Provider>
  );
}
