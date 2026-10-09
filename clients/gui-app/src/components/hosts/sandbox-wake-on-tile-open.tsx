import type { ReactNode } from "react";
import { useSandboxWakeForOpenedTile } from "@/hooks/sandboxes/use-sandbox-wake-on-tile-open";
import { useTileOpenRequested } from "@/lib/canvas/tile-open/tile-open-provenance";
import { useHostBinding } from "@/lib/host";

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
  // No host runtime above the tile (a shell mounted bare, a tile under test):
  // no directory, so no sandbox to wake.
  const hasRuntime = useHostBinding() !== null;
  return requested && hasRuntime ? (
    <SandboxWakeForOpenedTile hostId={props.hostId} />
  ) : null;
}

function SandboxWakeForOpenedTile(props: {
  readonly hostId: string;
}): ReactNode {
  useSandboxWakeForOpenedTile(props.hostId);
  return null;
}
