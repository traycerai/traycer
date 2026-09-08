import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EpicFileEntry } from "@traycer/protocol/persistence/epic/files";
import type { FileResolutionEntry } from "@traycer/protocol/persistence/epic/schemas";
import type { ImageResolutionEntry } from "@traycer/protocol/persistence/epic/messages";
import {
  AssistantMarkdownImageNode,
  AssistantMarkdownImageProvider,
  AssistantMarkdownLinkNode,
} from "@/components/chat/segments/assistant-markdown-image";
import type {
  AssistantMarkdownImageContext,
  AssistantMarkdownImageTarget,
} from "@/stores/composer/chat-store";
import type { EpicFileRecord } from "@/stores/epics/open-epic/types";
import type { FileByteSource, FileBytesState } from "@/lib/files/byte-source";

// -- mock: the byte half. Epic-file sources are keyed by `path`, the only
// field an epic-file source carries that a workspace/git/chat-attachment
// source does not. Chat-attachment sources delegate to `blobSrcState` below:
// since ticket 27 the imageResolutions path goes through this seam too, so a
// mock that answered LOADING for them would hide the very case the
// regression test at the bottom exists to hold.
const fileBytesState = vi.hoisted(() => {
  const loading: FileBytesState = {
    status: "loading",
    src: null,
    mediaType: null,
    delivery: null,
    reason: null,
    header: null,
    servedFromCache: false,
    message: null,
  };
  return {
    loading,
    byPath: new Map<string, FileBytesState>(),
    /** Sources by kind, so the regression test can assert on the epic-file leg alone. */
    kinds: [] as Array<string>,
  };
});

vi.mock("@/lib/files/byte-source", () => ({
  useFileBytes: (source: FileByteSource | null): FileBytesState => {
    if (source !== null) fileBytesState.kinds.push(source.kind);
    if (source === null) return fileBytesState.loading;
    if (source.kind === "chat-attachment") {
      const blob = blobSrcState.value;
      if (blob.status === "ready" && blob.src !== null) {
        return readyBytes(blob.src, blob.mediaType, "blob");
      }
      return blob.status === "unavailable"
        ? { ...fileBytesState.loading, status: "unavailable", reason: null }
        : fileBytesState.loading;
    }
    if (source.kind !== "epic-file") return fileBytesState.loading;
    return fileBytesState.byPath.get(source.path) ?? fileBytesState.loading;
  },
}));

// -- mock: the manifest reads `InlineVideo` uses to find a recording's poster.
const epicFilesState = vi.hoisted(() => ({
  entryByPath: new Map<string, EpicFileEntry>(),
  posterByRecordingId: new Map<string, EpicFileRecord>(),
}));

vi.mock("@/hooks/epic/use-epic-files", () => ({
  useEpicFileEntry: (path: string): EpicFileEntry | null =>
    epicFilesState.entryByPath.get(path) ?? null,
  useEpicRecordingPoster: (
    recordingId: string | null,
  ): EpicFileRecord | null =>
    recordingId === null
      ? null
      : (epicFilesState.posterByRecordingId.get(recordingId) ?? null),
}));

// -- mock: the imageResolutions blob path, same trick as
// assistant-markdown-image.test.tsx, so the regression case can drive it.
const blobSrcState = vi.hoisted(() => ({
  value: {
    status: "loading",
    src: null as string | null,
    mediaType: "image/png",
  },
}));

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: () => blobSrcState.value,
  }),
);

const EMPTY_DEDUP_TARGETS: ReadonlyMap<string, AssistantMarkdownImageTarget> =
  new Map();

function baseContext(
  fileResolutions: ReadonlyArray<FileResolutionEntry>,
): AssistantMarkdownImageContext {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    resolutions: [],
    deduplicatedTargetsBySource: EMPTY_DEDUP_TARGETS,
    fileResolutions,
  };
}

function fileResolutionEntry(args: {
  readonly src: string;
  readonly state: string;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly mediaType: string | null;
  readonly kind: string | null;
}): FileResolutionEntry {
  return { ...args };
}

function readyBytes(
  src: string,
  mediaType: string,
  delivery: "url" | "blob",
): FileBytesState {
  return {
    status: "ready",
    src,
    mediaType,
    delivery,
    reason: null,
    header: null,
    servedFromCache: false,
    message: null,
  };
}

function fakeEpicFileObject(
  sha256: string,
  mediaType: string,
): EpicFileEntry["current"] {
  return {
    sha256,
    byteLength: 1024,
    mediaType,
    createdAt: 0,
    createdBy: "user-1",
    producer: { type: "user" },
  };
}

function fakeEpicFileEntry(args: {
  readonly kind: string;
  readonly recordingId: string | null;
  readonly sha256: string;
  readonly mediaType: string;
}): EpicFileEntry {
  return {
    v: 1,
    kind: args.kind,
    current: fakeEpicFileObject(args.sha256, args.mediaType),
    versions: [],
    status: "live",
    recordingId: args.recordingId,
    derivedFrom: [],
    deletedAt: null,
  };
}

function fakePosterRecord(
  path: string,
  sha256: string,
  mediaType: string,
): EpicFileRecord {
  return {
    path,
    entry: fakeEpicFileEntry({
      kind: "poster",
      recordingId: null,
      sha256,
      mediaType,
    }),
  };
}

function resolvedImageEntry(
  source: string,
): Extract<ImageResolutionEntry, { state: "resolved" }> {
  return {
    source,
    canonicalSource: source,
    width: null,
    height: null,
    state: "resolved",
    attachmentHash: "hash-abc",
    mediaType: "image/png",
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapped(
  node: ReactNode,
  context: AssistantMarkdownImageContext,
): ReactNode {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AssistantMarkdownImageProvider context={context}>
        {node}
      </AssistantMarkdownImageProvider>
    </QueryClientProvider>
  );
}

function renderNode(
  node: ReactNode,
  context: AssistantMarkdownImageContext,
): RenderResult {
  return render(wrapped(node, context));
}

beforeEach(() => {
  fileBytesState.byPath.clear();
  fileBytesState.kinds.length = 0;
  epicFilesState.entryByPath.clear();
  epicFilesState.posterByRecordingId.clear();
  blobSrcState.value = { status: "loading", src: null, mediaType: "image/png" };
});

afterEach(() => {
  cleanup();
});

describe("inline video via a file resolution (D28)", () => {
  const CLIP_PATH = "files/recordings/r1.mp4";
  const POSTER_PATH = "files/recordings/r1.poster.png";
  const CLIP_URL = "https://loopback.local/files/r1.mp4";
  const POSTER_URL = "https://loopback.local/files/r1-poster.png";

  const RECORDING_RESOLUTION = fileResolutionEntry({
    src: CLIP_PATH,
    state: "resolved",
    path: CLIP_PATH,
    sha256: "abc",
    mediaType: "video/mp4",
    kind: "recording",
  });

  function seedResolvedRecording(withPoster: boolean): void {
    epicFilesState.entryByPath.set(
      CLIP_PATH,
      fakeEpicFileEntry({
        kind: "recording",
        recordingId: "r1",
        sha256: "abc",
        mediaType: "video/mp4",
      }),
    );
    fileBytesState.byPath.set(
      CLIP_PATH,
      readyBytes(CLIP_URL, "video/mp4", "url"),
    );
    if (withPoster) {
      epicFilesState.posterByRecordingId.set(
        "r1",
        fakePosterRecord(POSTER_PATH, "poster-sha", "image/png"),
      );
      fileBytesState.byPath.set(
        POSTER_PATH,
        readyBytes(POSTER_URL, "image/png", "url"),
      );
    }
  }

  it("renders the poster and hands the clip a direct url (no download) via a markdown LINK", () => {
    seedResolvedRecording(true);

    renderNode(
      <AssistantMarkdownLinkNode href={CLIP_PATH}>
        the run
      </AssistantMarkdownLinkNode>,
      baseContext([RECORDING_RESOLUTION]),
    );

    const video = screen.getByTestId("video-preview");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("poster")).toBe(POSTER_URL);
    const src = video.getAttribute("src");
    expect(src).toBe(CLIP_URL);
    expect(src?.startsWith("blob:")).toBe(false);
  });

  it("renders the same way via a markdown IMAGE embed (D28 allows either form)", () => {
    seedResolvedRecording(true);

    renderNode(
      <AssistantMarkdownImageNode src={CLIP_PATH} alt="the run" />,
      baseContext([RECORDING_RESOLUTION]),
    );

    const video = screen.getByTestId("video-preview");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("poster")).toBe(POSTER_URL);
    const src = video.getAttribute("src");
    expect(src).toBe(CLIP_URL);
    expect(src?.startsWith("blob:")).toBe(false);
  });

  it("renders with no poster attribute when the recording has none yet", () => {
    seedResolvedRecording(false);

    renderNode(
      <AssistantMarkdownLinkNode href={CLIP_PATH}>
        the run
      </AssistantMarkdownLinkNode>,
      baseContext([RECORDING_RESOLUTION]),
    );

    const video = screen.getByTestId("video-preview");
    expect(video.hasAttribute("poster")).toBe(false);
  });
});

describe("unavailable file resolution renders the D25 chip", () => {
  const UNAVAILABLE_ENTRY = fileResolutionEntry({
    src: "files/recordings/gone.mp4",
    state: "unavailable",
    path: null,
    sha256: null,
    mediaType: null,
    kind: null,
  });

  it("for a markdown LINK", () => {
    renderNode(
      <AssistantMarkdownLinkNode href="files/recordings/gone.mp4">
        the run
      </AssistantMarkdownLinkNode>,
      baseContext([UNAVAILABLE_ENTRY]),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "This file is no longer available.",
    );
  });

  it("for a markdown IMAGE", () => {
    renderNode(
      <AssistantMarkdownImageNode
        src="files/recordings/gone.mp4"
        alt="the run"
      />,
      baseContext([UNAVAILABLE_ENTRY]),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "This file is no longer available.",
    );
  });
});

describe("image rendered through a file resolution", () => {
  const IMAGE_PATH = "files/shot.png";
  const IMAGE_URL = "https://loopback.local/files/shot.png";
  const IMAGE_ENTRY = fileResolutionEntry({
    src: IMAGE_PATH,
    state: "resolved",
    path: IMAGE_PATH,
    sha256: "def",
    mediaType: "image/png",
    kind: "screenshot",
  });

  it("shows the sync-wait status while loading, then the image once the byte source is ready", () => {
    const { rerender } = renderNode(
      <AssistantMarkdownImageNode src={IMAGE_PATH} alt="diagram" />,
      baseContext([IMAGE_ENTRY]),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Waiting for file sync",
    );
    expect(screen.queryByRole("img")).toBeNull();

    fileBytesState.byPath.set(
      IMAGE_PATH,
      readyBytes(IMAGE_URL, "image/png", "url"),
    );
    rerender(
      wrapped(
        <AssistantMarkdownImageNode src={IMAGE_PATH} alt="diagram" />,
        baseContext([IMAGE_ENTRY]),
      ),
    );

    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(IMAGE_URL);
    expect(img.getAttribute("alt")).toBe("diagram");
  });
});

describe("percent-encoded markdown targets still match a file resolution", () => {
  it("matches an entry recorded with a literal space against an encoded href", () => {
    const CLIP_PATH = "files/my clip.mp4";
    const ENCODED_HREF = "files/my%20clip.mp4";
    const CLIP_URL = "https://loopback.local/files/my-clip.mp4";

    epicFilesState.entryByPath.set(
      CLIP_PATH,
      fakeEpicFileEntry({
        kind: "recording",
        recordingId: null,
        sha256: "clip-sha",
        mediaType: "video/mp4",
      }),
    );
    fileBytesState.byPath.set(
      CLIP_PATH,
      readyBytes(CLIP_URL, "video/mp4", "url"),
    );

    renderNode(
      <AssistantMarkdownLinkNode href={ENCODED_HREF}>
        the clip
      </AssistantMarkdownLinkNode>,
      baseContext([
        fileResolutionEntry({
          src: CLIP_PATH,
          state: "resolved",
          path: CLIP_PATH,
          sha256: "clip-sha",
          mediaType: "video/mp4",
          kind: "recording",
        }),
      ]),
    );

    expect(screen.getByTestId("video-preview")).toBeTruthy();
  });
});

describe("regression: an imageResolutions-only message is unchanged", () => {
  it("renders the image through the chat-attachment leg and never reaches the epic-file one", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/regression-diagram",
      mediaType: "image/png",
    };
    const context: AssistantMarkdownImageContext = {
      ...baseContext([]),
      resolutions: [
        { messageId: "msg-1", entry: resolvedImageEntry("diagram.png") },
      ],
    };

    renderNode(
      <AssistantMarkdownImageNode src="diagram.png" alt="diagram" />,
      context,
    );

    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(
      "blob:http://localhost/regression-diagram",
    );
    // The seam is shared now (ticket 27 phase B3); what must not happen is an
    // imageResolutions image resolving through the epic-file plane.
    expect(fileBytesState.kinds).toEqual(["chat-attachment"]);
  });

  it("renders a plain markdown link with no matching file resolution as an ordinary anchor", () => {
    renderNode(
      <AssistantMarkdownLinkNode href="https://example.com/docs">
        Docs
      </AssistantMarkdownLinkNode>,
      baseContext([]),
    );

    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });
});
