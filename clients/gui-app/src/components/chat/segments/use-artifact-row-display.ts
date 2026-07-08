import { v4 as uuidv4 } from "uuid";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import { useArtifactById, useOpenEpicId } from "@/lib/epic-selectors";

function nonEmpty(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value.length > 0
    ? value
    : null;
}

export interface ArtifactRowDisplay {
  readonly displayKind: EpicArtifactKind;
  readonly title: string;
  readonly isDeleted: boolean;
  readonly canOpen: boolean;
  readonly openArtifact: () => void;
}

/**
 * Shared resolution for an artifact change row (per-turn group + accumulated
 * panel): live title/kind from the open-epic projection by id, with the
 * captured tag as fallback, plus an opener that adds the artifact tile to the
 * canvas. A deleted artifact (or one whose id has not resolved) is not openable.
 */
export function useArtifactRowDisplay(input: {
  readonly artifactId: string | null;
  readonly artifactKind: EpicArtifactKind | null;
  readonly fallbackTitle: string | null;
  readonly operation: CheckpointFileOperation;
}): ArtifactRowDisplay {
  const live = useArtifactById(input.artifactId);
  const epicId = useOpenEpicId();
  const activeHostId = useReactiveActiveHostId();
  const tileNavigation = useEpicTileNavigation();

  const displayKind: EpicArtifactKind =
    live?.kind ?? input.artifactKind ?? "spec";
  const title =
    nonEmpty(live?.title) ??
    nonEmpty(input.fallbackTitle) ??
    EPIC_NODE_LABELS[displayKind];
  const isDeleted = input.operation === "delete";
  const canOpen = live !== null && activeHostId !== null && !isDeleted;

  const openArtifact = (): void => {
    if (live === null || activeHostId === null || input.artifactId === null) {
      return;
    }
    tileNavigation.openTileInEpic(epicId, {
      id: input.artifactId,
      instanceId: uuidv4(),
      type: displayKind,
      name: title,
      hostId: activeHostId,
    });
  };

  return { displayKind, title, isDeleted, canOpen, openArtifact };
}
