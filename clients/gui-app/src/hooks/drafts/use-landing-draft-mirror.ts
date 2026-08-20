import { useEffect, type ReactNode } from "react";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { useDraftMirrorForHost } from "./use-draft-mirror-for-host";
import { useDraftMirrorFlush } from "./use-draft-mirror-flush";
import { bindLandingAdoptionHost } from "@/lib/drafts/draft-mirror-coordinator";

export function LandingDraftMirrorMount(): ReactNode {
  const placement = useComposerPlacement(null);
  const hostId = placement.target.resolvedHostId;
  const reachable =
    hostId !== null &&
    placement.target.client !== null &&
    !placement.target.namedHostDead;
  const adoptionHostId = reachable ? hostId : null;
  // Bind before `useDraftMirrorForHost`'s acquire effect so bootstrap's
  // `upsertDirty(null)` can adopt drafts that already exist. New drafts
  // adopt on the first debounced sync, not on this mount.
  useEffect(() => {
    bindLandingAdoptionHost(adoptionHostId);
    return () => {
      bindLandingAdoptionHost(null);
    };
  }, [adoptionHostId]);
  useDraftMirrorForHost(adoptionHostId);
  useDraftMirrorFlush();
  return null;
}
