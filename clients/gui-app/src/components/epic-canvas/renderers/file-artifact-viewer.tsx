import { MediaArtifactContent } from "./media-artifact-content";
import { useEffect, useState, type ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import { Button } from "@/components/ui/button";
import {
  ImagePreview,
  DEFAULT_ANIMATION_MS,
} from "@/components/epic-canvas/image-preview/image-preview";
import { PdfPreviewLazy } from "@/components/epic-canvas/pdf-preview/pdf-preview-lazy";
import { DocxPreviewLazy } from "@/components/epic-canvas/docx-preview/docx-preview-lazy";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
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
import { readArtifactBlob } from "@/lib/files/read-artifact-blob";
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const content = {
    sha256: object.sha256,
    byteLength: object.byteLength,
    mediaType: object.mediaType,
  };
  const queryFn = ({ signal }: { signal: AbortSignal }): Promise<Blob> =>
    readArtifactBlob(content, props.readSpan, signal);
  const query = useQuery(
    queryOptions({
      queryKey: [
        ...hostQueryKeys.methodScope(props.hostId, "epic.readArtifactObject"),
        { epicId: props.epicId, content, want: "blob" },
      ],
      queryFn,
      meta: stampHostRpcMethod(undefined, "epic.readArtifactObject"),
      enabled: kind !== null && mediaKind === null,
      staleTime: Infinity,
      gcTime: 60_000,
      retry: false,
    }),
  );
  const save = async (route: "download" | "share"): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const blob =
        query.data ?? (await query.refetch({ throwOnError: true })).data;
      if (blob === undefined) throw new Error("The file is unavailable.");
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

function FileContent(props: {
  readonly blob: Blob;
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
      {!failed && kind === "text" && <TextFileContent blob={blob} />}
    </>
  );
}

const TEXT_PREVIEW_BYTES = 100_000;
function TextFileContent({ blob }: { readonly blob: Blob }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void blob
      .slice(0, TEXT_PREVIEW_BYTES)
      .text()
      .then((value) => {
        if (active) setText(value);
      });
    return () => {
      active = false;
    };
  }, [blob]);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {blob.size > TEXT_PREVIEW_BYTES && (
        <p className="mb-2 text-sm text-muted-foreground">
          Preview truncated. Save for the full file.
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words text-sm">
        {text ?? "Loading text…"}
      </pre>
    </div>
  );
}
