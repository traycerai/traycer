import { useEffect, useState } from "react";
import type { EpicArtifactSync } from "@traycer/protocol/host/epic/status-subscribe";
import { CLOUD_LINK_GRACE_MS } from "@/components/epic-canvas/panels/use-cloud-link-grace";
import {
  artifactSyncOutstanding,
  type ArtifactSyncReading,
  type EpicSyncPillState,
} from "@/lib/epic-sync-pill-state";

export type ArtifactSyncStatus =
  | { readonly kind: "calm" }
  | {
      readonly kind: "warning";
      readonly label: string;
      readonly sentence: string;
    }
  | { readonly kind: "recovered"; readonly label: string };

const CALM: ArtifactSyncStatus = { kind: "calm" };
const RECOVERED: ArtifactSyncStatus = {
  kind: "recovered",
  label: "Artifacts synced",
};

/** How long "Artifacts synced" stays up after a warning clears. */
export const ARTIFACT_SYNC_RECOVERED_MS = 5_000;

/**
 * The verdicts this plane speaks beside. Every other one is a link or local
 * state that already names the outage, and rooms behind a down link are the
 * same news again.
 */
const CLOUD_UP_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>(["synced", "syncing", "hostPending", "connected"]);

function warningFor(
  rooms: EpicArtifactSync["rooms"],
  waiting: number,
): Extract<ArtifactSyncStatus, { readonly kind: "warning" }> {
  // `stopped` drops the promise: nothing on the host is trying again.
  const retry = rooms === "stopped" ? "" : " Retrying on its own.";
  if (waiting === 0) {
    return {
      kind: "warning",
      label: "Artifacts not syncing",
      sentence: `Your changes are saved on this computer. Your other devices and teammates won’t see them yet.${retry}`,
    };
  }
  if (waiting === 1) {
    return {
      kind: "warning",
      label: "1 new artifact waiting",
      sentence: `It’s saved on this computer and will appear here when sync is back.${retry}`,
    };
  }
  return {
    kind: "warning",
    label: `${String(waiting)} new artifacts waiting`,
    sentence: `They’re saved on this computer and will appear here when sync is back.${retry}`,
  };
}

/**
 * The artifact plane: quiet for {@link CLOUD_LINK_GRACE_MS}, the same window a
 * cloud drop gets because a room re-dials inside it for the same reason, then
 * a warning, then "Artifacts synced" for {@link ARTIFACT_SYNC_RECOVERED_MS} if
 * a warning was actually shown.
 *
 * The clock runs on whether anything is outstanding at all, not on which
 * warning it is, so a room falling behind while an artifact waits does not
 * start the grace again.
 */
export function useArtifactSyncStatus(
  reading: ArtifactSyncReading | null,
): ArtifactSyncStatus {
  const {
    rooms,
    waitingNewArtifacts: waiting,
    pillState,
  } = reading ?? {
    rooms: null,
    waitingNewArtifacts: 0,
    pillState: null,
  };
  const outstanding =
    rooms !== null &&
    CLOUD_UP_STATES.has(pillState) &&
    artifactSyncOutstanding({ rooms, waitingNewArtifacts: waiting });
  const [warned, setWarned] = useState(false);
  const [recovered, setRecovered] = useState(false);
  if (outstanding && recovered) {
    setRecovered(false);
  }
  if (!outstanding && warned) {
    setWarned(false);
    setRecovered(true);
  }
  useEffect(() => {
    if (!outstanding) return undefined;
    const timer = window.setTimeout(() => {
      setWarned(true);
    }, CLOUD_LINK_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [outstanding]);
  useEffect(() => {
    if (!recovered) return undefined;
    const timer = window.setTimeout(() => {
      setRecovered(false);
    }, ARTIFACT_SYNC_RECOVERED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [recovered]);
  if (outstanding && warned) return warningFor(rooms, waiting);
  // A warning cleared by the link going down is not a recovery, and only a
  // standing `synced` says the artifacts arrived.
  if (recovered && pillState === "synced") return RECOVERED;
  return CALM;
}
