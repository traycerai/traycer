import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { CanvasFrameRegistry } from "../canvas-frame-registry";
import { useCanvasBoardDocument } from "../use-canvas-board-document";

// Needs `vitest.react-compiler.config.ts`: uncompiled, the old hook passes too.
// The hook once ignored the `useSyncExternalStore` snapshot and read the
// registry at render, so the compiler kept the first source after a file change.

const ARTIFACT_ID = "canvas-1";
const BOARD_PATH = "boards/home.html";

function boardSource(html: string, sha256: string): SandboxSource {
  const bytes = new TextEncoder().encode(html);
  return {
    kind: "artifact",
    artifactId: ARTIFACT_ID,
    treePath: "",
    entryPath: BOARD_PATH,
    manifest: {
      files: {
        [BOARD_PATH]: {
          sha256,
          byteLength: bytes.length,
          mediaType: "text/html",
        },
      },
    },
    readSpan: (_sha, offset, length) =>
      Promise.resolve({
        bytes: bytes.slice(offset, offset + length),
        totalBytes: bytes.length,
        mediaType: "text/html",
      }),
    resolveOutsideReference: () => null,
  };
}

function BoardText(props: { readonly registry: CanvasFrameRegistry }) {
  const document = useCanvasBoardDocument(
    ARTIFACT_ID,
    BOARD_PATH,
    props.registry,
    true,
  );
  return <p data-testid="board">{document.data?.text ?? "loading"}</p>;
}

afterEach(() => {
  cleanup();
});

describe("useCanvasBoardDocument under React Compiler", () => {
  it("follows the frame's source when it changes after mount", async () => {
    const registry = new CanvasFrameRegistry();
    const queryClient = new QueryClient();
    registry.update(BOARD_PATH, {
      source: boardSource("<p>first revision</p>", "a".repeat(64)),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BoardText registry={registry} />
      </QueryClientProvider>,
    );
    await screen.findByText("<p>first revision</p>");

    // The file changed outside the editor: the frame republishes its source
    // with a new manifest entry, and nothing but the registry's subscription
    // re-renders the component.
    act(() => {
      registry.update(BOARD_PATH, {
        source: boardSource("<p>second revision</p>", "b".repeat(64)),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("board").textContent).toBe(
        "<p>second revision</p>",
      );
    });
    queryClient.clear();
  });
});
