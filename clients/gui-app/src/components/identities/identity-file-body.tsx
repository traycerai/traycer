/**
 * The body of the selected identity file.
 *
 * A markdown document binds its live `Y.XmlFragment` to the same collab
 * editor the epic artifact tiles use; taking the fragment through
 * `useIdentityFileFragment` is what opens the body lane, and releasing it on
 * unmount is what closes it. A blob is read through the chunked
 * `files.readBlob` loop and previewed inline when it is an image or text;
 * anything else offers a download of the bytes.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent } from "@tiptap/react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { Download, RefreshCw } from "lucide-react";
import { deriveCollabUser, type CollabUser } from "@/editor-core";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useCollabTileEditor } from "@/components/epic-canvas/renderers/use-collab-tile-editor";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useIdentityBlobQueryForClient } from "@/hooks/identities/use-identity-blob-query";
import {
  formatByteLength,
  isPreviewableImage,
  isPreviewableText,
  type IdentityTreeFile,
} from "@/lib/identities/file-tree";
import {
  useIdentityFileAwareness,
  useIdentityFileBodyAvailability,
  useIdentityFileDoc,
  useIdentityFileFragment,
  useOpenIdentityState,
} from "@/lib/identity-selectors";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface IdentityFileBodyProps {
  readonly identityId: string;
  readonly hostId: string;
  readonly file: IdentityTreeFile | null;
  readonly hydrated: boolean;
}

const GUEST_COLLAB_USER: CollabUser = deriveCollabUser({
  userName: "Guest",
  email: null,
});

export function IdentityFileBody(props: IdentityFileBodyProps): ReactNode {
  const { identityId, hostId, file, hydrated } = props;
  if (!hydrated) {
    return (
      <BodyNotice testId="identity-body-loading">
        <MutedAgentSpinner />
      </BodyNotice>
    );
  }
  if (file === null) {
    return (
      <BodyNotice testId="identity-body-empty">
        This identity has no files yet. Add a markdown file from the rail.
      </BodyNotice>
    );
  }
  if (file.kind === "document") {
    return <IdentityDocumentBody key={file.path} path={file.path} />;
  }
  return (
    <IdentityBlobBody
      key={file.path}
      identityId={identityId}
      hostId={hostId}
      file={file}
    />
  );
}

function BodyNotice(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex h-full w-full items-center justify-center p-6 text-center text-ui-sm text-muted-foreground"
    >
      {props.children}
    </div>
  );
}

function IdentityDocumentBody(props: { readonly path: string }): ReactNode {
  const { path } = props;
  const fragment = useIdentityFileFragment(path);
  const doc = useIdentityFileDoc(path);
  const awareness = useIdentityFileAwareness(path);
  const availability = useIdentityFileBodyAvailability(path);
  if (availability?.kind === "unavailable") {
    return (
      <BodyNotice testId="identity-document-unavailable">
        {availability.reason}
      </BodyNotice>
    );
  }
  if (fragment === null || doc === null || awareness === null) {
    return (
      <BodyNotice testId="identity-document-loading">
        <MutedAgentSpinner />
      </BodyNotice>
    );
  }
  return (
    <IdentityDocumentEditor
      path={path}
      fragment={fragment}
      doc={doc}
      awareness={awareness}
      readOnly={availability?.kind === "retrying"}
      retryingReason={
        availability?.kind === "retrying" ? availability.reason : null
      }
    />
  );
}

function IdentityDocumentEditor(props: {
  readonly path: string;
  readonly fragment: Y.XmlFragment;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly readOnly: boolean;
  readonly retryingReason: string | null;
}): ReactNode {
  const { fragment, doc, awareness, readOnly, retryingReason } = props;
  const connection = useOpenIdentityState((state) => state.connection);
  const profile = useAuthStore((s) => s.profile);
  const user = useMemo(
    () => (profile === null ? GUEST_COLLAB_USER : deriveCollabUser(profile)),
    [profile],
  );
  const editable = !readOnly && connection !== "unsupported";
  const editor = useCollabTileEditor({
    doc,
    fragment,
    awareness,
    editable,
    user,
    onCommentShortcut: null,
    anchorScope: null,
    placeholderText: "Write in markdown…",
    titlePlaceholderText: "Untitled",
  });
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-6 py-8"
      data-testid="identity-document-editor"
      data-path={props.path}
    >
      {retryingReason !== null ? (
        <p
          className="mx-auto mb-3 w-full max-w-3xl rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-ui-xs text-warning-foreground"
          data-testid="identity-document-retrying"
        >
          Read-only while the host recovers this file: {retryingReason}
        </p>
      ) : null}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="tc-editor-surface">
          <div className="tc-editor-body">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
}

function IdentityBlobBody(props: {
  readonly identityId: string;
  readonly hostId: string;
  readonly file: IdentityTreeFile;
}): ReactNode {
  const { identityId, hostId, file } = props;
  const client = useTabHostClient();
  const entry = useOpenIdentityState(
    (state) => state.files.byPath[file.path]?.entry ?? null,
  );
  const sha256 = entry?.current.sha256 ?? null;
  const previewable =
    isPreviewableImage(file.mediaType) || isPreviewableText(file.mediaType);
  const [wantBytes, setWantBytes] = useState(previewable);
  const query = useIdentityBlobQueryForClient(
    client,
    {
      hostId,
      identityId,
      path: file.path,
      sha256: sha256 ?? "",
      mediaType: file.mediaType,
    },
    sha256 !== null && wantBytes,
  );
  const source = query.data;
  // A Download click on a file whose bytes are not fetched yet is an INTENT
  // that outlives the click: the fetch it starts completes in an effect, and
  // that effect performs the download the click asked for (finding 6). A ref,
  // not state - nothing renders differently while the intent is pending.
  const downloadRequested = useRef(false);
  const download = () => {
    if (source?.kind === "bytes") {
      saveBlobBytes(source.bytes, source.mediaType, file.name);
      return;
    }
    downloadRequested.current = true;
    setWantBytes(true);
  };
  useEffect(() => {
    if (!downloadRequested.current) return;
    if (source?.kind !== "bytes") return;
    downloadRequested.current = false;
    saveBlobBytes(source.bytes, source.mediaType, file.name);
  }, [source, file.name]);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto p-6"
      data-testid="identity-blob-body"
      data-path={file.path}
    >
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-ui-sm font-medium text-foreground">
            {file.name}
          </h2>
          <p className="text-ui-xs text-muted-foreground">
            {file.mediaType}
            {file.byteLength === null
              ? ""
              : ` · ${formatByteLength(file.byteLength)}`}
            {file.status !== null && file.status !== "available"
              ? ` · ${file.status}`
              : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sha256 === null || query.isFetching}
          onClick={download}
          data-testid="identity-blob-download"
        >
          <Download className="size-3.5" />
          Download
        </Button>
      </header>
      <IdentityBlobPreview
        file={file}
        source={source ?? null}
        fetching={query.isFetching}
        failed={query.isError}
        onRetry={() => {
          setWantBytes(true);
          void query.refetch();
        }}
      />
    </div>
  );
}

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

function IdentityBlobPreview(props: {
  readonly file: IdentityTreeFile;
  readonly source:
    | { readonly kind: "unavailable"; readonly reason: string }
    | { readonly kind: "pending"; readonly reason: string }
    | {
        readonly kind: "bytes";
        readonly bytes: Uint8Array<ArrayBuffer>;
        readonly mediaType: string;
      }
    | null;
  readonly fetching: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { file, source, fetching, failed, onRetry } = props;
  if (fetching) {
    return (
      <BodyNotice testId="identity-blob-loading">
        <MutedAgentSpinner />
      </BodyNotice>
    );
  }
  if (failed) {
    return (
      <BodyNotice testId="identity-blob-failed">
        <span>Couldn&apos;t read this file from the host.</span>
        <Button type="button" variant="muted" size="xs" onClick={onRetry}>
          <RefreshCw className="size-3" />
          Try again
        </Button>
      </BodyNotice>
    );
  }
  if (source === null) {
    return (
      <BodyNotice testId="identity-blob-no-preview">
        No preview for this kind of file. Download it to open it elsewhere.
      </BodyNotice>
    );
  }
  if (source.kind === "pending") {
    return (
      <BodyNotice testId="identity-blob-pending">
        <span>{source.reason}</span>
        <Button type="button" variant="muted" size="xs" onClick={onRetry}>
          <RefreshCw className="size-3" />
          Check again
        </Button>
      </BodyNotice>
    );
  }
  if (source.kind === "unavailable") {
    return (
      <BodyNotice testId="identity-blob-unavailable">
        {source.reason}
      </BodyNotice>
    );
  }
  if (isPreviewableImage(source.mediaType)) {
    return (
      <BlobImage
        bytes={source.bytes}
        mediaType={source.mediaType}
        alt={file.name}
      />
    );
  }
  if (isPreviewableText(source.mediaType)) {
    const shown = source.bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES);
    const truncated = source.bytes.byteLength > shown.byteLength;
    return (
      <pre
        className="w-full overflow-x-auto rounded-md border border-border/60 bg-foreground/3 p-3 font-mono text-ui-xs whitespace-pre-wrap text-foreground"
        data-testid="identity-blob-text"
      >
        {new TextDecoder().decode(shown)}
        {truncated ? "\n…" : ""}
      </pre>
    );
  }
  return (
    <BodyNotice testId="identity-blob-no-preview">
      No preview for this kind of file. Download it to open it elsewhere.
    </BodyNotice>
  );
}

/** Hand the bytes to the browser as a file save. */
function saveBlobBytes(
  bytes: Uint8Array<ArrayBuffer>,
  mediaType: string,
  name: string,
): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * An image whose object URL is OWNED by one effect: created and revoked in
 * the same setup/cleanup pair, written straight onto the element rather than
 * held in render state. Under StrictMode the effect replays, and a replay
 * that recreates what its cleanup revoked is the only lifetime that survives
 * it (finding 7); a URL minted in render is owned by nothing.
 */
function BlobImage(props: {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string;
  readonly alt: string;
}): ReactNode {
  const { bytes, mediaType, alt } = props;
  const imageRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image === null) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    image.src = url;
    return () => {
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [bytes, mediaType]);
  return (
    <img
      ref={imageRef}
      alt={alt}
      className="max-h-full max-w-full self-start rounded-md object-contain"
      data-testid="identity-blob-image"
    />
  );
}
