import type { ReactNode } from "react";
import { useSandboxWakeForOpenedTile } from "@/hooks/sandboxes/use-sandbox-wake-on-tile-open";
import { useTileOpenRequested } from "@/lib/canvas/tile-open/tile-open-provenance";

/**
 * Mounted once per canvas tile, inside its `TabHostProvider`: wakes the
 * tile's sandbox host when the tile is OPENED. A restored tile reads `false`
 * here and mounts nothing else, so a layout restore never wakes a sandbox and
 * never reads the host directory for it. Renders nothing.
 */
export function SandboxWakeOnTileOpen(props: {
  readonly hostId: string;
  readonly instanceId: string;
}): ReactNode {
  const requested = useTileOpenRequested(props.instanceId);
  return requested ? <SandboxWakeForOpenedTile hostId={props.hostId} /> : null;
}

function SandboxWakeForOpenedTile(props: {
  readonly hostId: string;
}): ReactNode {
  useSandboxWakeForOpenedTile(props.hostId);
  return null;
}
