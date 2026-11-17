/**
 * The shared HTML-artifact download, driven through the REAL hook, the real ZIP
 * builder and the real `downloadBlobToDevice`; only the native save boundary
 * (`IFileSaveHost.downloadFile`), the toasts and the object reads are doubles.
 *
 * A live card hands the download the lifetime of the reader that authorised
 * its bytes: `{ signal, isCurrent() }`. Once that lifetime is revoked, nothing
 * may be saved or announced, wherever in the download the revoke lands.
 */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import {
  NO_OUTSIDE_REFERENCE,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { withoutNativeAbortSignalAny } from "@/lib/host/test-support/without-native-abort-signal-any";
import { useHtmlArtifactDownload } from "@/hooks/files/use-html-artifact-download-mutation";

const save = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  savedToast: vi.fn(),
  hostErrorToast: vi.fn(),
  runnerErrorToast: vi.fn(),
}));

vi.mock("@/hooks/files/use-file-save-host", () => ({
  useFileSaveHost: () => ({
    saveFile: vi.fn(),
    openSavedFile: null,
    downloadFile: save.downloadFile,
  }),
}));
vi.mock("@/hooks/files/use-open-saved-file", () => ({
  useOpenSavedFile: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/files/saved-file-toast", () => ({
  toastSavedFile: save.savedToast,
}));
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: save.hostErrorToast,
}));
vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: save.runnerErrorToast,
}));

const SHA = "a".repeat(64);
const BYTES = new TextEncoder().encode("<html></html>");

type ArtifactSource = Extract<SandboxSource, { kind: "artifact" }>;

function sourceReadingThrough(readSpan: ArtifactReadSpan): ArtifactSource {
  return {
    kind: "artifact",
    artifactId: "art-1",
    treePath: "roadmap",
    entryPath: "index.html",
    manifest: {
      files: {
        "index.html": {
          sha256: SHA,
          byteLength: BYTES.byteLength,
          mediaType: "text/html",
        },
      },
    },
    readSpan,
    resolveOutsideReference: NO_OUTSIDE_REFERENCE,
  };
}

const servesBytes: ArtifactReadSpan = (_sha256, offset, length) =>
  Promise.resolve({
    bytes: BYTES.slice(offset, offset + length),
    totalBytes: BYTES.byteLength,
    mediaType: "text/html",
  });

/** A lifetime the test can revoke, as a reader's is on a host or account change. */
function revocableLifetime(): {
  readonly lifetime: {
    readonly signal: AbortSignal;
    isCurrent(): boolean;
  };
  readonly revoke: () => void;
} {
  const controller = new AbortController();
  return {
    lifetime: {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
    revoke: () => controller.abort(),
  };
}

function mountDownload() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useHtmlArtifactDownload("host-a", "art-1"), {
    wrapper,
  });
}

afterEach(() => {
  save.downloadFile.mockReset();
  save.savedToast.mockReset();
  save.hostErrorToast.mockReset();
  save.runnerErrorToast.mockReset();
  vi.restoreAllMocks();
});

function expectNothingSavedOrAnnounced(): void {
  expect(save.downloadFile).not.toHaveBeenCalled();
  expect(save.savedToast).not.toHaveBeenCalled();
  expect(save.hostErrorToast).not.toHaveBeenCalled();
  expect(save.runnerErrorToast).not.toHaveBeenCalled();
}

describe("useHtmlArtifactDownload under a reader lifetime", () => {
  it("saves and announces once while the lifetime stands (control)", async () => {
    save.downloadFile.mockResolvedValue({ name: "Roadmap.zip", path: null });
    const { result } = mountDownload();
    const { lifetime } = revocableLifetime();
    const input = {
      source: sourceReadingThrough(servesBytes),
      title: "Roadmap",
      lifetime,
    };

    await result.current.mutateAsync(input);

    expect(save.downloadFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(save.savedToast).toHaveBeenCalledTimes(1));
  });

  it("a download asked for after revoke reads, saves and announces nothing", async () => {
    const readSpan = vi.fn<ArtifactReadSpan>(servesBytes);
    const { result } = mountDownload();
    const { lifetime, revoke } = revocableLifetime();
    revoke();
    const input = {
      source: sourceReadingThrough(readSpan),
      title: "Roadmap",
      lifetime,
    };

    await result.current.mutateAsync(input).catch(() => undefined);

    expect(readSpan).not.toHaveBeenCalled();
    expectNothingSavedOrAnnounced();
  });

  it("a ZIP whose last object read lands after revoke is neither saved nor announced", async () => {
    const gate = Promise.withResolvers<void>();
    const readSpan = vi.fn<ArtifactReadSpan>(async (...args) => {
      await gate.promise;
      return servesBytes(...args);
    });
    const { result } = mountDownload();
    const { lifetime, revoke } = revocableLifetime();
    const input = {
      source: sourceReadingThrough(readSpan),
      title: "Roadmap",
      lifetime,
    };

    const settled = result.current.mutateAsync(input).catch(() => undefined);
    await waitFor(() => expect(readSpan).toHaveBeenCalled());
    revoke();
    gate.resolve();
    await settled;

    expectNothingSavedOrAnnounced();
  });

  it("revoking while the archive is read for the native save stops the save", async () => {
    const gate = Promise.withResolvers<ArrayBuffer>();
    const arrayBufferSpy = vi
      .spyOn(Blob.prototype, "arrayBuffer")
      .mockReturnValue(gate.promise);
    save.downloadFile.mockResolvedValue({ name: "Roadmap.zip", path: null });
    const { result } = mountDownload();
    const { lifetime, revoke } = revocableLifetime();
    const input = {
      source: sourceReadingThrough(servesBytes),
      title: "Roadmap",
      lifetime,
    };

    const settled = result.current.mutateAsync(input).catch(() => undefined);
    await waitFor(() => expect(arrayBufferSpy).toHaveBeenCalled());
    revoke();
    gate.resolve(new ArrayBuffer(1));
    await settled;

    expectNothingSavedOrAnnounced();
  });

  it("saves and announces once on a platform with no native AbortSignal.any (control)", async () => {
    save.downloadFile.mockResolvedValue({ name: "Roadmap.zip", path: null });
    const { result } = mountDownload();
    const { lifetime } = revocableLifetime();
    const input = {
      source: sourceReadingThrough(servesBytes),
      title: "Roadmap",
      lifetime,
    };

    await withoutNativeAbortSignalAny(() => result.current.mutateAsync(input));

    expect(save.downloadFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(save.savedToast).toHaveBeenCalledTimes(1));
  });
});
