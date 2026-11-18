/**
 * `LiveArtifactRow`, the live-reference sibling of `ArtifactRow`. The frame is
 * the test-only browser driver: this proves the object port and the shared
 * renderer, not a real iframe, one instance across Expand, or the bridge.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  LiveArtifactRow,
  type LiveArtifactCardInput,
} from "@/components/chat/segments/artifact-row";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { withoutNativeAbortSignalAny } from "@/lib/host/test-support/without-native-abort-signal-any";
import { requestSiblingAsset } from "@/components/sandbox/__tests__/artifact-frame-browser-driver-source";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type ArtifactReadScopeRecorder,
  createArtifactReadScopeRecorder,
  createArtifactReadScopeRecorderHolding,
  createArtifactReadScopeRecorderMissing,
  readyLiveInput,
} from "./live-artifact-row-test-support";

// JSDOM never fetches a served artifact URL, so the real frame reads nothing
// here. The driver stands in for the browser's entry-document request (test-only;
// object-port and shared-renderer proof, not iframe or Expand proof).
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));

const saveHost = vi.hoisted(() => ({ downloadFile: vi.fn() }));
const savedFileToast = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/files/use-file-save-host", () => ({
  useFileSaveHost: () => ({
    saveFile: vi.fn(),
    downloadFile: saveHost.downloadFile,
  }),
}));
vi.mock("@/lib/files/saved-file-toast", () => ({
  toastSavedFile: savedFileToast,
}));

afterEach(() => {
  cleanup();
  saveHost.downloadFile.mockReset();
  savedFileToast.mockReset();
  vi.restoreAllMocks();
});

function renderReady(recorder: ArtifactReadScopeRecorder): void {
  render(
    shell(
      <LiveArtifactRow
        artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
        readScope={recorder.scope}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    ),
  );
}

function shell(children: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

describe("LiveArtifactRow union", () => {
  it.each(["pending", "deleted", "unavailable"] as const)(
    "%s renders the shared figure and copy and never touches the reader",
    (kind) => {
      const recorder = createArtifactReadScopeRecorder("host-a", {
        objectResponse: "ok",
      });
      const input: LiveArtifactCardInput = { kind, title: "Roadmap" };
      render(
        shell(
          <LiveArtifactRow
            artifact={input}
            readScope={recorder.scope}
            onOpen={vi.fn()}
            onRetry={vi.fn()}
          />,
        ),
      );
      expect(screen.getByLabelText("Artifact: Roadmap")).toBeTruthy();
      expect(recorder.calls).toHaveLength(0);
    },
  );

  it("a pending live row keeps its authored title beside the loading copy", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={{ kind: "pending", title: "Roadmap" }}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );

    const figure = screen.getByLabelText("Artifact: Roadmap");
    expect(within(figure).getByText("Roadmap")).toBeTruthy();
    expect(within(figure).getByText("Loading artifact")).toBeTruthy();
    expect(recorder.calls).toHaveLength(0);
  });

  it("a ready input whose host or epic does not match the client fails closed to unavailable", () => {
    const recorder = createArtifactReadScopeRecorder("host-b", {
      objectResponse: "ok",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    expect(recorder.calls).toHaveLength(0);
  });

  it("a ready input with a null client fails closed before any ready component mounts", () => {
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={{ hostId: "host-a", client: null }}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });
});

describe("LiveArtifactRow with nothing to preview", () => {
  const NO_PREVIEW: LiveArtifactCardInput = {
    kind: "no-preview",
    title: "Roadmap",
  };
  function mountNoPreview(
    recorder: ArtifactReadScopeRecorder,
    onOpen: (() => void) | null,
  ) {
    return render(
      shell(
        <LiveArtifactRow
          artifact={NO_PREVIEW}
          readScope={recorder.scope}
          onOpen={onOpen}
          onRetry={vi.fn()}
        />,
      ),
    );
  }

  it("names the artifact, says there is no preview and offers the real Open, with no read and no Download", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const onOpen = vi.fn();
    mountNoPreview(recorder, onOpen);

    expect(screen.getByLabelText("Artifact: Roadmap")).toBeTruthy();
    expect(screen.getByText("Roadmap")).toBeTruthy();
    expect(screen.getByText("No preview.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Open in panel" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(recorder.calls).toHaveLength(0);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("offers no Open when it has nowhere to open", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    mountNoPreview(recorder, null);

    expect(screen.getByText("No preview.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in panel" })).toBeNull();
  });

  it("withdraws the title, the Open and the copy when the reader's lifetime is revoked", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    mountNoPreview(recorder, vi.fn());

    act(() => recorder.revoke());

    expect(screen.queryByText("No preview.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in panel" })).toBeNull();
    expect(screen.getByText("Artifact unavailable.")).toBeTruthy();
    // Nothing the revoked admission named outlives it: not the visible title,
    // not the accessible name. The figure is the generic one.
    expect(screen.queryByText("Roadmap")).toBeNull();
    expect(screen.queryByLabelText("Artifact: Roadmap")).toBeNull();
    expect(screen.getByLabelText("Artifact")).toBeTruthy();
  });
});

describe("LiveArtifactRow ready branch", () => {
  it("reads bytes only through epic.readArtifactObject and shows one frame", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    await screen.findByTestId("artifact-frame-driver");
    expect(new Set(recorder.calls.map((call) => call.method))).toEqual(
      new Set(["epic.readArtifactObject"]),
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("plain branch is chosen by mode even when an ancestor EpicViewTab exists", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    render(
      shell(
        <EpicViewTabContext.Provider value="tab-ancestor">
          <LiveArtifactRow
            artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
            readScope={recorder.scope}
            onOpen={vi.fn()}
            onRetry={vi.fn()}
          />
        </EpicViewTabContext.Provider>,
      ),
    );
    expect(
      recorder.calls.every((c) => c.method === "epic.readArtifactObject"),
    ).toBe(true);
  });

  it("missing live bytes latch unavailable: a head change reads nothing, Retry asks the provider, and only a new admission reads again", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "missing",
    });
    const onRetry = vi.fn();
    const rowFor = (input: LiveArtifactCardInput) =>
      shell(
        <LiveArtifactRow
          artifact={input}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={onRetry}
        />,
      );
    const view = render(
      rowFor(readyLiveInput({ readerGeneration: 1, sourceGeneration: 1 })),
    );
    await screen.findByText(/unavailable/i);
    const settled = recorder.calls.length;

    // A newer head alone does not clear the latch.
    view.rerender(
      rowFor(readyLiveInput({ readerGeneration: 1, sourceGeneration: 2 })),
    );
    expect(recorder.calls).toHaveLength(settled);
    expect(screen.getByText(/unavailable/i)).toBeTruthy();

    // Retry hands the decision to the provider; the card reads nothing itself.
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(recorder.calls).toHaveLength(settled);

    // The provider's re-admission is a new reader generation.
    view.rerender(
      rowFor(readyLiveInput({ readerGeneration: 2, sourceGeneration: 2 })),
    );
    await waitFor(() => expect(recorder.calls.length).toBeGreaterThan(settled));
  });

  it("claims no origin: no chat id, capture, version picker or comments", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByRole("combobox", { name: /version/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
  });

  it("a reused path shows the CURRENT path's artifact, not the first", () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const view = render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ artifactId: "art-1", title: "First" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    view.rerender(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ artifactId: "art-2", title: "Second" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    expect(screen.getByLabelText("Artifact: Second")).toBeTruthy();
    expect(screen.queryByLabelText("Artifact: First")).toBeNull();
  });

  it("Open fires the injected callback from one button; no second iframe or Escape listener", async () => {
    const onOpen = vi.fn();
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={onOpen}
          onRetry={vi.fn()}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("revocation clears content before cleanup runs", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const view = render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    await screen.findByTestId("artifact-frame-driver");
    act(() => recorder.revoke());
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    view.unmount();
  });
});

describe("LiveArtifactRow lifetime fencing", () => {
  it("a late object read after revoke publishes nothing", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "deferred",
    });
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ hostId: "host-a", epicId: "epic-1" })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    act(() => recorder.revoke());
    await recorder.settleDeferredReads({ onlyFirst: false });
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("A to B to A: the old A read's late completion neither adds a read nor replaces the new A's frame", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "deferred",
    });
    const rowFor = (artifactId: string, title: string) =>
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ artifactId, title, sourceGeneration: 1 })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    const view = render(rowFor("art-a", "A"));
    // Each source asked for its own entry document: A, then B, then A again.
    // Each dispatch is awaited before the next source, so none is skipped by
    // consecutive rerenders landing before a passive effect runs.
    await waitFor(() => expect(recorder.calls).toHaveLength(1));
    view.rerender(rowFor("art-b", "B"));
    await waitFor(() => expect(recorder.calls).toHaveLength(2));
    view.rerender(rowFor("art-a", "A"));
    await waitFor(() => expect(recorder.calls).toHaveLength(3));
    expect(screen.queryByLabelText("Artifact: B")).toBeNull();

    // Only the FIRST (old A) read lands now.
    await recorder.settleDeferredReads({ onlyFirst: true });

    expect(recorder.calls).toHaveLength(3);
    expect(screen.getByLabelText("Artifact: A")).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("an authority re-resolution (a new sourceGeneration) reads the source again", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const view = render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ sourceGeneration: 1 })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    await screen.findByTestId("artifact-frame-driver");
    const first = recorder.calls.length;
    view.rerender(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({ sourceGeneration: 2 })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    await screen.findByTestId("artifact-frame-driver");
    expect(recorder.calls.length).toBeGreaterThan(first);
  });

  it("a ZIP completing after revoke is never saved or announced", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "deferred",
    });
    renderReady(recorder);
    await userEvent.click(screen.getByRole("button", { name: /download/i }));
    act(() => recorder.revoke());
    await recorder.settleDeferredReads({ onlyFirst: false });
    expect(saveHost.downloadFile).not.toHaveBeenCalled();
    expect(savedFileToast).not.toHaveBeenCalled();
  });

  it("a download continues across a routine head save while the same reader lifetime stands", async () => {
    saveHost.downloadFile.mockResolvedValue({
      name: "Roadmap.zip",
      path: null,
    });
    // The frame reads only the entry document; the archive also needs the
    // asset, which the host holds until the test lets it go.
    const ASSET_SHA = "d".repeat(64);
    const recorder = createArtifactReadScopeRecorderHolding("host-a", [
      ASSET_SHA,
    ]);
    const files = (entrySha: string) => ({
      "index.html": {
        sha256: entrySha,
        byteLength: 13,
        mediaType: "text/html",
      },
      "assets/data.bin": {
        sha256: ASSET_SHA,
        byteLength: 13,
        mediaType: "application/octet-stream",
      },
    });
    const rowFor = (entrySha: string) =>
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({
            manifest: { files: files(entrySha) },
          })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    const view = render(rowFor("a".repeat(64)));
    await screen.findByTestId("artifact-frame-driver");
    await userEvent.click(screen.getByRole("button", { name: /download/i }));
    // The archive is now waiting on the held asset read.
    await waitFor(() => expect(recorder.deferredCount()).toBe(1));

    // The author saves while the archive is still being read.
    view.rerender(rowFor("b".repeat(64)));
    await recorder.settleDeferredReads({ onlyFirst: false });

    await waitFor(() => expect(saveHost.downloadFile).toHaveBeenCalledTimes(1));
  });

  it("revoking while the blob is being read stops the native save", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const gate = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValue(gate.promise);
    renderReady(recorder);
    await userEvent.click(screen.getByRole("button", { name: /download/i }));
    act(() => recorder.revoke());
    gate.resolve(new ArrayBuffer(1));
    await gate.promise;
    expect(saveHost.downloadFile).not.toHaveBeenCalled();
    expect(savedFileToast).not.toHaveBeenCalled();
  });
});

describe("LiveArtifactRow frame stability", () => {
  it("reads the entry document on a platform with no native AbortSignal.any", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });

    await withoutNativeAbortSignalAny(async () => {
      renderReady(recorder);
      await screen.findByTestId("artifact-frame-driver");
      await waitFor(() => expect(recorder.calls.length).toBeGreaterThan(0));
    });

    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("a routine head save keeps the raised card and its frame: a new manifest under the same generations is not a new frame", async () => {
    const recorder = createArtifactReadScopeRecorder("host-a", {
      objectResponse: "ok",
    });
    const rowFor = (input: LiveArtifactCardInput) =>
      shell(
        <LiveArtifactRow
          artifact={input}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    const view = render(
      rowFor(readyLiveInput({ readerGeneration: 1, sourceGeneration: 1 })),
    );
    const frame = await screen.findByTestId("artifact-frame-driver");
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("dialog", { name: "Roadmap" })).toBeTruthy();

    // The author saved: a new head, the same authority and the same admission.
    view.rerender(
      rowFor(
        readyLiveInput({
          readerGeneration: 1,
          sourceGeneration: 1,
          manifest: {
            files: {
              "index.html": {
                sha256: "b".repeat(64),
                byteLength: 13,
                mediaType: "text/html",
              },
            },
          },
        }),
      ),
    );

    const dialog = screen.getByRole("dialog", { name: "Roadmap" });
    expect(within(dialog).getByTestId("artifact-frame-driver")).toBe(frame);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("only the entry document latches unavailable: a missing sibling asset is unavailable for that asset alone", async () => {
    const SIBLING_SHA = "c".repeat(64);
    const recorder = createArtifactReadScopeRecorderMissing("host-a", [
      SIBLING_SHA,
    ]);
    render(
      shell(
        <LiveArtifactRow
          artifact={readyLiveInput({
            manifest: {
              files: {
                "index.html": {
                  sha256: "a".repeat(64),
                  byteLength: 13,
                  mediaType: "text/html",
                },
                "assets/logo.png": {
                  sha256: SIBLING_SHA,
                  byteLength: 4,
                  mediaType: "image/png",
                },
              },
            },
          })}
          readScope={recorder.scope}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />,
      ),
    );
    await screen.findByTestId("artifact-frame-driver");

    const asset = await requestSiblingAsset("assets/logo.png");

    expect(asset).toHaveProperty("unavailable");
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });
});
