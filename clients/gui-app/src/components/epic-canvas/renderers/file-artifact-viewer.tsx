import { MediaArtifactContent } from "./media-artifact-content";
import { useEffect, useState, type ReactNode } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import { Button } from "@/components/ui/button";
import {
  ImagePreview,
  DEFAULT_ANIMATION_MS,
} from "@/components/epic-canvas/image-preview/image-preview";
import { PdfPreviewLazy } from "@/components/epic-canvas/pdf-preview/pdf-preview-lazy";
import { DocxPreviewLazy } from "@/components/epic-canvas/docx-preview/docx-preview-lazy";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
} from "@/lib/files/save-blob-to-disk";
import {
  artifactFileViewer,
  type ArtifactFileViewer,
} from "@/lib/files/artifact-file-viewer";
import {
  readArtifactBlob,
  readArtifactBlobPrefix,
} from "@/lib/files/read-artifact-blob";
import { hostQueryKeys } from "@/lib/query-keys";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { ArtifactReadSpan } from "@/lib/sandbox/artifact-serving/artifact-server";

export function FileArtifactViewer(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly name: string;
  readonly object: ArtifactObjectRef;
  readonly readSpan: ArtifactReadSpan;
}) {
  const { object, name } = props;
  const kind = artifactFileViewer(name, object.mediaType);
  const mediaKind = kind === "audio" || kind === "video" ? kind : null;
  const fileSave = useFileSaveHost();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const content = {
    sha256: object.sha256,
    byteLength: object.byteLength,
    mediaType: object.mediaType,
  };
  const fullBlobQueryFn = ({
    signal,
  }: {
    signal: AbortSignal;
  }): Promise<Blob> => readArtifactBlob(content, props.readSpan, signal);
  const previewQueryFn = ({
    signal,
  }: {
    signal: AbortSignal;
  }): Promise<Blob> =>
    kind === "text"
      ? readArtifactBlobPrefix(
          content,
          props.readSpan,
          signal,
          TEXT_PREVIEW_BYTES,
        )
      : readArtifactBlob(content, props.readSpan, signal);
  const fullBlobOptions = queryOptions({
    queryKey: [
      ...hostQueryKeys.methodScope(props.hostId, "epic.readArtifactObject"),
      { epicId: props.epicId, content, want: "blob" },
    ],
    queryFn: fullBlobQueryFn,
    meta: stampHostRpcMethod(undefined, "epic.readArtifactObject"),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const query = useQuery(
    queryOptions({
      queryKey:
        kind === "text"
          ? [...fullBlobOptions.queryKey, { prefixBytes: TEXT_PREVIEW_BYTES }]
          : fullBlobOptions.queryKey,
      queryFn: previewQueryFn,
      meta: stampHostRpcMethod(undefined, "epic.readArtifactObject"),
      enabled: kind !== null && mediaKind === null,
      staleTime: Infinity,
      gcTime: 60_000,
      retry: false,
    }),
  );
  const cloudDownload = useCloudDownload({
    hostId: props.hostId,
    epicId: props.epicId,
    object,
    name,
    fileSave,
  });
  const save = async (route: "download" | "share"): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      if (
        route === "download" &&
        cloudDownload !== null &&
        (await cloudDownload())
      )
        return;
      const blob =
        query.data?.size === object.byteLength
          ? query.data
          : await queryClient.fetchQuery(fullBlobOptions);
      await (route === "download" ? downloadBlobToDevice : saveBlobToDisk)(
        blob,
        name,
        fileSave,
      );
    } catch {
      setSaveError("Couldn't save this file. Please retry.");
    } finally {
      setSaving(false);
    }
  };
  const actions = (
    <div className="flex items-center gap-2">
      {canDownloadToDevice(fileSave) && (
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void save("download")}
        >
          Download
        </Button>
      )}
      {hasSeparateDownloadRoute(fileSave) && (
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void save("share")}
        >
          Share
        </Button>
      )}
    </div>
  );
  return (
    <div className="flex size-full min-h-0 flex-col">
      {saveError !== null && (
        <div role="alert" className="p-2 text-sm text-destructive">
          {saveError}
        </div>
      )}
      {mediaKind !== null && (
        <>
          <div className="flex items-center justify-between gap-2 border-b p-2">
            <span className="truncate">{name}</span>
            {actions}
          </div>
          <MediaArtifactContent
            key={`${props.hostId}:${props.epicId}:${object.sha256}`}
            epicId={props.epicId}
            hostId={props.hostId}
            object={object}
            kind={mediaKind}
            readSpan={props.readSpan}
          />
        </>
      )}
      {mediaKind === null &&
        (query.data !== undefined && kind !== null ? (
          <FileContent
            key={object.sha256}
            blob={query.data}
            totalBytes={object.byteLength}
            kind={kind}
            name={name}
            actions={actions}
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b p-2">
              <span className="truncate">{name}</span>
              {actions}
            </div>
            <div
              role="status"
              className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground"
            >
              {query.isError ? (
                <>
                  <p>Couldn't load this file.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void query.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : null}
              {!query.isError && (
                <p>
                  {kind === null
                    ? "No preview is available. Save the file to open it."
                    : "Loading file…"}
                </p>
              )}
            </div>
          </>
        ))}
    </div>
  );
}

/**
 * Download of a published file on another machine's host: the shell pulls it
 * straight from the cloud, network to disk, instead of this process reading
 * every span over the relay into memory first, which a large recording does
 * not survive. Resolves `false` when the host minted no URL, and the caller
 * reads the bytes through the host as before.
 *
 * `null` where there is nothing to gain: a shell with no native URL
 * download, a file not in the cloud yet, or this machine's own host, which
 * has the file on disk or is mirroring it, so the read stays local.
 */
function useCloudDownload(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly object: ArtifactObjectRef;
  readonly name: string;
  readonly fileSave: IFileSaveHost | null;
}): (() => Promise<boolean>) | null {
  const client = useHostClientForHostId(input.hostId);
  const localHostId = useReactiveLocalHostId();
  const url = useHostQuery({
    client,
    method: "epic.readArtifactObject",
    params: {
      epicId: input.epicId,
      sha256: input.object.sha256,
      want: { kind: "url" },
    },
    cacheKeyIdentity: undefined,
    // Read only when Download is pressed: a signed URL is short-lived.
    options: { enabled: false, staleTime: 0 },
  });
  const downloadUrl = input.fileSave?.downloadUrl ?? null;
  if (
    downloadUrl === null ||
    input.object.status !== "published" ||
    input.hostId === localHostId
  )
    return null;
  return async () => {
    const { data } = await url.refetch({ throwOnError: true });
    if (data?.kind !== "url") return false;
    await downloadUrl({
      url: data.url,
      name: input.name,
      type: input.object.mediaType,
    });
    return true;
  };
}

function FileContent(props: {
  readonly blob: Blob;
  readonly totalBytes: number;
  readonly kind: ArtifactFileViewer;
  readonly name: string;
  readonly actions: ReactNode;
}) {
  const { blob, kind, name, actions } = props;
  const url = useBlobObjectUrl(blob);
  const [failed, setFailed] = useState(false);
  const fail = (): void => setFailed(true);
  if (url === null)
    return (
      <div role="status" className="p-4 text-muted-foreground">
        Loading file…
      </div>
    );
  if (!failed && (kind === "pdf" || kind === "docx")) {
    const Viewer = kind === "pdf" ? PdfPreviewLazy : DocxPreviewLazy;
    return (
      <Viewer
        url={url}
        fileName={name}
        compact={false}
        toolbarActions={actions}
        onRenderFailure={fail}
        onUnavailable={fail}
      />
    );
  }
  if (!failed && kind === "image") {
    return (
      <ImagePreview
        status="ready"
        url={url}
        meta={null}
        servedFromCache={false}
        fileName={name}
        compact={false}
        gesturesEnabled
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        animationMs={DEFAULT_ANIMATION_MS}
        onDecodeError={fail}
        toolbarActions={actions}
        toolbarLabel={name}
      />
    );
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <span className="truncate">{name}</span>
        {actions}
      </div>
      {failed ? (
        <p role="status" className="p-4 text-muted-foreground">
          This file can't be previewed here. Save it to open it.
        </p>
      ) : null}
      {!failed && kind === "text" && (
        <TextFileContent blob={blob} truncated={props.totalBytes > blob.size} />
      )}
    </>
  );
}

const TEXT_PREVIEW_BYTES = 100_000;
function TextFileContent({
  blob,
  truncated,
}: {
  readonly blob: Blob;
  readonly truncated: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void blob.text().then((value) => {
      if (active) setText(value);
    });
    return () => {
      active = false;
    };
  }, [blob]);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {truncated ? (
        <p className="mb-2 text-sm text-muted-foreground">
          Preview truncated. Save for the full file.
        </p>
      ) : null}
      <pre className="whitespace-pre-wrap break-words text-sm">
        {text ?? "Loading text…"}
      </pre>
    </div>
  );
}
