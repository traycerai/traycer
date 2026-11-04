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
      /**
       * `retrying` while the host is still trying; `stopped` once it has
       * given up. `title` is the phone sheet's heading only. The pill shows
       * no text for either kind.
       */
      readonly kind: "retrying" | "stopped";
      readonly title: string;
      readonly sentence: string;
    };

const CALM: ArtifactSyncStatus = { kind: "calm" };

/**
 * The verdicts this plane speaks beside. Every other one is a link or local
 * state that already names the outage, and rooms behind a down link are the
 * same news again.
 */
const CLOUD_UP_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>(["synced", "syncing", "hostPending", "connected"]);

/** The sheet heading. The pill never prints it. */
function sheetTitle(waiting: number): string {
  if (waiting === 0) return "Artifacts not syncing";
  if (waiting === 1) return "1 new artifact waiting";
  return `${String(waiting)} new artifacts waiting`;
}

function sentenceFor(waiting: number, retry: string): string {
  if (waiting === 0) {
    return `Artifacts not syncing. Your changes are saved on this computer. Your other devices and teammates won’t see them yet.${retry}`;
  }
  if (waiting === 1) {
    return `1 new artifact waiting. It’s saved on this computer and will appear here when sync is back.${retry}`;
  }
  return `${String(waiting)} new artifacts waiting. They’re saved on this computer and will appear here when sync is back.${retry}`;
}

function reportFor(
  rooms: EpicArtifactSync["rooms"],
  waiting: number,
): Exclude<ArtifactSyncStatus, { readonly kind: "calm" }> {
  // `stopped` drops the promise: nothing on the host is trying again.
  const retry = rooms === "stopped" ? "" : " Retrying on its own.";
  return {
    kind: rooms === "stopped" ? "stopped" : "retrying",
    title: sheetTitle(waiting),
    sentence: sentenceFor(waiting, retry),
  };
}

/**
 * The artifact plane: quiet for {@link CLOUD_LINK_GRACE_MS}, the same window a
 * cloud drop gets because a room re-dials inside it for the same reason, then
 * a report. Catching up is ordinary saving, so the plane goes straight back
 * to calm when it clears. There is no "Artifacts synced" flash.
 *
 * The clock runs on whether anything is outstanding at all, not on which
 * report it is, so a room falling behind while an artifact waits does not
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
  if (!outstanding && warned) {
    setWarned(false);
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
  if (outstanding && warned) return reportFor(rooms, waiting);
  return CALM;
}
