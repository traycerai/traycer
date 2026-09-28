import type { ReactNode } from "react";
import {
  useLayoutRegion,
  useRegionGhost,
} from "@/components/layout-editor/use-layout-region";
import { useRegionValues } from "@/lib/layout-overrides";
import { depictRegion } from "@/components/layout-editor/region-depiction";
import { useLiveUsageArrangement } from "@/components/layout-editor/inspector/use-layout-usage";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * A hidden region materialised in place while the editor points at it (L-14),
 * as its PASSIVE depiction rather than as the live component (L-62).
 *
 * The two status-bar regions are the reason this exists. Their real controls
 * are not visual leaves: the usage cluster fetches per-provider readings and
 * owns a keyboard action, and the resource segment opens a stream - so
 * materialising either one would be a preview that starts work, which the
 * override seam's passivity contract forbids. `depictRegion` draws the same
 * picture the specimen stage and the preset miniatures draw, from static
 * specimen data, and registers as the region's canvas node so it hovers, names
 * and rings exactly as the real thing would.
 *
 * Renders nothing unless the region is BOTH hidden and pointed at, so it costs
 * one store read at rest.
 */
export function GhostRegion(props: { readonly regionId: RegionId }): ReactNode {
  const { regionId } = props;
  const ghost = useRegionGhost(regionId);
  const { ref } = useLayoutRegion({ regionId, instanceId: null });
  if (!ghost) return null;
  return (
    <span ref={ref} className="inline-flex min-w-0 items-center">
      <GhostRegionPicture regionId={regionId} />
    </span>
  );
}

/**
 * {@link GhostRegion}'s picture without the registration, for a host whose OWN
 * element is already this region's canvas node.
 *
 * Two elements registering the same region and instance would share one key,
 * so the later one silently displaces the earlier and the ring anchors to
 * whichever won - the header's usage cluster is exactly that case.
 */
export function GhostRegionPicture(props: {
  readonly regionId: RegionId;
}): ReactNode {
  const { regionId } = props;
  const ghost = useRegionGhost(regionId);
  const values = useRegionValues(regionId);
  // A depiction needs the whole arrangement; this component is part of the
  // editor, which the override seam's own exemption list covers.
  const arrangement = useLiveUsageArrangement(
    useLayoutStore((state) => state.arrangement),
  );
  if (!ghost) return null;
  return depictRegion(regionId, values, arrangement);
}
