import { useEffect, type ReactNode } from "react";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  accountWideAnswerer,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useAppServingDecision } from "@/lib/host/app-serving-decision";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
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
  const serving = useAppServingDecision();
  const placementHostId = reachable ? hostId : null;
  const accountHostId =
    accountWideAnswerer("drafts.list", null, serving) === "computer"
      ? (serving.servingPeer?.hostId ?? null)
      : POOL_HOST_ID;
  const mirrorHostId =
    readProcessHostRpcTierPlan().pool === null
      ? placementHostId
      : accountHostId;
  const mirrorClient = useHostClientForHostId(mirrorHostId);
  // Keep unsynced device drafts local when the pool answers the account list.
  const adoptionHostId = mirrorHostId === POOL_HOST_ID ? null : mirrorHostId;
  // Bind before `useDraftMirrorForHost`'s acquire effect so bootstrap's
  // `upsertDirty(null)` can adopt drafts that already exist. New drafts
  // adopt on the first debounced sync, not on this mount.
  useEffect(() => {
    bindLandingAdoptionHost(adoptionHostId);
    return () => {
      bindLandingAdoptionHost(null);
    };
  }, [adoptionHostId]);
  // One-shot stash conversion. App-wide like this mount, and guarded by
  // its own module-level flag, so a re-render or a placement change cannot
  // start it twice; it waits for the landing store's own ready gate itself.
  useEffect(() => {
    startLocalStashMigration();
  }, []);
  useDraftMirrorForHost(mirrorHostId);
  useCloudDraftsIngest(mirrorClient, mirrorHostId);
  useDraftMirrorFlush();
  return null;
}
