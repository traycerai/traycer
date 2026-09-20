import { useEffect, type ReactNode } from "react";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { useDraftMirrorForHost } from "./use-draft-mirror-for-host";
import { useDraftMirrorFlush } from "./use-draft-mirror-flush";
import { useCloudDraftsIngest } from "./use-cloud-drafts-ingest";
import { bindLandingAdoptionHost } from "@/lib/drafts/draft-mirror-coordinator";
import { startLocalStashMigration } from "@/lib/drafts/stash-migration";

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
  // One-shot stash conversion (D19). App-wide like this mount, and guarded by
  // its own module-level flag, so a re-render or a placement change cannot
  // start it twice; it waits for the landing store's own ready gate itself.
  useEffect(() => {
    startLocalStashMigration();
  }, []);
  useDraftMirrorForHost(adoptionHostId);
  useCloudDraftsIngest(placement.target.client, adoptionHostId);
  useDraftMirrorFlush();
  return null;
}
