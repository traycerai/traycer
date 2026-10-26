import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { SandboxArtifactBridge } from "@traycer-clients/shared/platform/sandbox-artifacts";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { CanvasBoardFrame, type CanvasFrameEvents } from "../canvas-frame";

vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

const BOARD = "boards/a.html";
const TITLE = "Board A";

afterEach(cleanup);

function runnerHost(): IRunnerHost {
  const bridge: SandboxArtifactBridge = {
    policySource: "traycer-sandbox:",
    artifactOrigin: ({ artifactId, mountId }) =>
      `traycer-sandbox://artifact-${artifactId}--${mountId}`,
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    onRequest: () => ({ dispose: () => undefined }),
    onCancel: () => ({ dispose: () => undefined }),
    respond: () => Promise.resolve(),
  };
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    sandboxArtifacts: bridge,
  });
}

// The same reader across heads, as the live source keeps one per artifact.
const readSpan = () => Promise.resolve({ unavailable: "missing" } as const);

/** A manifest head: the board's own bytes plus a sibling file other writes move. */
function artifactSource(
  entrySha256: string,
  siblingSha256: string,
  extraFiles: Record<string, string>,
): SandboxSource {
  const file = (sha256: string) => ({
    sha256,
    byteLength: 0,
    mediaType: "text/html",
    status: "published" as const,
  });
  const manifest: ArtifactManifest = {
    files: {
      [BOARD]: file(entrySha256),
      "boards/b.html": file(siblingSha256),
      ...Object.fromEntries(
        Object.entries(extraFiles).map(([path, sha]) => [path, file(sha)]),
      ),
    },
  };
  return {
    kind: "artifact",
    canvas: true,
    artifactId: "canvas-art",
    treePath: "",
    entryPath: BOARD,
    manifest,
    readSpan,
    resolveOutsideReference: () => null,
  };
}

describe("<CanvasBoardFrame /> reloads", () => {
  const host = runnerHost();
  const events: CanvasFrameEvents = {
    onBridge: () => undefined,
    onStatus: () => undefined,
    onEditPointer: () => undefined,
  };

  function tree(
    source: SandboxSource,
    frameEvents: CanvasFrameEvents,
    navigation: { search: string; hash: string; visit: number } | undefined,
  ) {
    return (
      <RunnerHostContext.Provider value={host}>
        <CanvasBoardFrame
          path={BOARD}
          title={TITLE}
          source={source}
          events={frameEvents}
          fullscreen={false}
          mode="edit"
          navigation={navigation}
        />
      </RunnerHostContext.Provider>
    );
  }

  it("keeps the mounted document when only another file moved the manifest head, and replaces it when the board's own bytes changed", async () => {
    const view = render(
      tree(artifactSource("entry-1", "sibling-1", {}), events, undefined),
    );
    const mounted = await screen.findByTitle(TITLE);

    view.rerender(
      tree(artifactSource("entry-1", "sibling-2", {}), events, undefined),
    );
    expect(screen.getByTitle(TITLE)).toBe(mounted);

    view.rerender(
      tree(artifactSource("entry-2", "sibling-2", {}), events, undefined),
    );
    await waitFor(() => expect(screen.getByTitle(TITLE)).not.toBe(mounted));
  });

  it("replaces the document when a non-html file under boards/ changed, since the board may read it", async () => {
    const view = render(
      tree(
        artifactSource("entry-1", "sibling-1", { "boards/theme.css": "css-1" }),
        events,
        undefined,
      ),
    );
    const mounted = await screen.findByTitle(TITLE);

    view.rerender(
      tree(
        artifactSource("entry-1", "sibling-1", { "boards/theme.css": "css-2" }),
        events,
        undefined,
      ),
    );

    await waitFor(() => expect(screen.getByTitle(TITLE)).not.toBe(mounted));
  });

  it("remounts instead of navigating the stale document when a query change arrives after an in-place adoption", async () => {
    const adopting: CanvasFrameEvents = {
      ...events,
      sourceAdopted: () => true,
    };
    const view = render(
      tree(artifactSource("entry-1", "sibling-1", {}), adopting, undefined),
    );
    const mounted = await screen.findByTitle(TITLE);

    view.rerender(
      tree(artifactSource("entry-2", "sibling-1", {}), adopting, undefined),
    );
    expect(screen.getByTitle(TITLE)).toBe(mounted);

    view.rerender(
      tree(artifactSource("entry-2", "sibling-1", {}), adopting, {
        search: "?v=2",
        hash: "",
        visit: 1,
      }),
    );
    await waitFor(() => expect(screen.getByTitle(TITLE)).not.toBe(mounted));
  });
});
