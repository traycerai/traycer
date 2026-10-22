import { useCallback, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  htmlArtifactVersionSelectionSchema,
  htmlArtifactVersionIdentity,
  type HtmlArtifactVersion,
  type HtmlArtifactVersionSelection,
} from "@traycer/protocol/host/epic/html-artifact-versions";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";

export interface HtmlArtifactVersionState {
  readonly manifest: ArtifactManifest | null;
  /** null means use the live artifact's entry path. */
  readonly entryPath: string | null;
  readonly selectedVersion: HtmlArtifactVersionSelection | null;
  readonly selectVersion: (
    version: HtmlArtifactVersionSelection | null,
  ) => void;
  readonly supported: boolean;
  readonly history: UseQueryResult<
    {
      versions: HtmlArtifactVersion[];
      nextCursor: string | null;
    },
    HostRpcError
  >;
  readonly showOlder: () => void;
  readonly showNewest: () => void;
  readonly hasNewer: boolean;
}

export function useEpicHtmlArtifactVersion(props: {
  readonly epicId: string;
  readonly node: EpicArtifactRef;
  readonly artifact: ArtifactProjection | null;
}): HtmlArtifactVersionState {
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const viewTabId = useEpicViewTabId();
  const supported = useHostSupportsMethod(
    hostId,
    "epic.listHtmlArtifactVersions",
  );
  const [before, setBefore] = useState<string | undefined>(undefined);
  const selectedVersion = props.node.htmlVersion ?? null;
  const history = useHostQuery({
    client,
    method: "epic.listHtmlArtifactVersions",
    params: {
      epicId: props.epicId,
      artifactId: props.node.id,
      before,
      limit: 20,
    },
    cacheKeyIdentity: [
      props.artifact?.head === undefined
        ? null
        : htmlArtifactVersionIdentity({
            manifest: props.artifact.head,
            entryPath:
              props.artifact.layout === "file"
                ? (props.artifact.relativePath ?? props.artifact.folderName)
                : "index.html",
          }),
    ],
    options: { enabled: supported && props.artifact?.kind === "html" },
  });
  const selectVersion = useCallback(
    (selection: HtmlArtifactVersionSelection | null): void => {
      if (viewTabId === null) return;
      useEpicCanvasStore
        .getState()
        .updateHtmlArtifactVersionInTab(
          viewTabId,
          props.node.instanceId,
          selection === null
            ? null
            : htmlArtifactVersionSelectionSchema.parse(selection),
        );
    },
    [viewTabId, props.node.instanceId],
  );

  return {
    manifest:
      selectedVersion?.manifest ??
      (props.artifact?.kind === "html" ? (props.artifact.head ?? null) : null),
    entryPath: selectedVersion?.entryPath ?? null,
    selectedVersion,
    selectVersion,
    supported,
    history,
    hasNewer: before !== undefined,
    showNewest: () => setBefore(undefined),
    showOlder: () => {
      const nextCursor = history.data?.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null)
        setBefore(nextCursor);
    },
  };
}
