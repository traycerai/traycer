import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactReply,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import {
  buildArtifactAddress,
  type ArtifactManifest,
  type ArtifactOutsideReferenceResolver,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { RunnerHostContext } from "@/providers/runner-host-context";

const { openLink } = vi.hoisted(() => ({ openLink: vi.fn() }));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

afterEach(() => {
  cleanup();
  openLink.mockReset();
});

/**
 * `treePath` is the POSIX-relative root inside the artifact's own file tree
 * ("" for a top-level artifact, e.g. "proof/nested" for one rooted deeper);
 * `entryPath` is the document served as the entry point ("index.html" by
 * default, or a loose file like "report.html"). Narrowed to the artifact
 * variant so a test can spread one call's result and override a single
 * field without disturbing the shared `manifest`/`readSpan`/
 * `resolveOutsideReference` identities `sameSource` also compares.
 */
function artifactSource(
  artifactId: string,
  treePath: string,
  entryPath: string,
): Extract<SandboxSource, { kind: "artifact" }> {
  const manifest: ArtifactManifest = {
    files: {
      [entryPath]: {
        sha256: "sha-stub",
        byteLength: 0,
        mediaType: "text/html",
        status: "published",
      },
    },
  };
  // Never actually invoked by these tests: jsdom does not load a custom
  // scheme's iframe `src`, so no byte range is ever requested through it.
  const readSpan: ArtifactReadSpan = () =>
    Promise.resolve({ unavailable: "missing" });
  const resolveOutsideReference: ArtifactOutsideReferenceResolver = () => null;
  return {
    kind: "artifact",
    artifactId,
    treePath,
    entryPath,
    manifest,
    readSpan,
    resolveOutsideReference,
  };
}

interface FakeBridge extends SandboxArtifactBridge {
  readonly registered: string[];
  readonly unregistered: string[];
}

function createFakeBridge(): FakeBridge {
  const registered: string[] = [];
  const unregistered: string[] = [];
  return {
    registered,
    unregistered,
    register: (mountId) => {
      registered.push(mountId);
      return Promise.resolve();
    },
    unregister: (mountId) => {
      unregistered.push(mountId);
      return Promise.resolve();
    },
    onRequest: () => ({ dispose: () => undefined }),
    // Mechanical stub: these tests are about mount registration, not
    // cancellation, but a bridge value must still satisfy the interface.
    onCancel: () => ({ dispose: () => undefined }),
    respond: (_reply: SandboxArtifactReply) => Promise.resolve(),
  };
}

function hostWith(bridge: SandboxArtifactBridge | null): IRunnerHost {
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

function artifactFrame(options: {
  readonly source: SandboxSource;
  readonly title: string;
  readonly onBridge: ((bridge: SandboxBridgeHost | null) => void) | null;
}) {
  return (
    <SandboxFrame
      source={options.source}
      kind="page"
      title={options.title}
      appName={null}
      networkPolicy="https-only"
      appCsp={null}
      permissions={[]}
      appRequests={null}
      className=""
      height={null}
      onSize={() => undefined}
      onStatus={() => undefined}
      onRequestTeardown={() => undefined}
      displayMode="inline"
      onBridge={options.onBridge}
      ref={null}
    />
  );
}

describe("<SandboxFrame /> artifact source, with a runner host that serves artifacts", () => {
  it("registers a mount through the runner host's artifact bridge and points the iframe at its address", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "", "index.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );

    const iframe = await screen.findByTitle("Artifact page");
    expect(bridge.registered).toHaveLength(1);
    const [mountId] = bridge.registered;
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "myart",
        mountId: mountId,
        treePath: "",
        path: "index.html",
      }),
    );
  });

  it("hands over a live bridge once the mount is ready, not before", async () => {
    // Registration deliberately never resolves until the test says so, so
    // this can actually fail if the frame navigated (or handed over a
    // bridge) before the mount was ready, rather than merely racing it.
    let resolveRegister: () => void = () => undefined;
    const registered: string[] = [];
    const bridge: SandboxArtifactBridge = {
      register: (mountId) =>
        new Promise((resolve) => {
          registered.push(mountId);
          resolveRegister = resolve;
        }),
      unregister: () => Promise.resolve(),
      onRequest: () => ({ dispose: () => undefined }),
      onCancel: () => ({ dispose: () => undefined }),
      respond: (_reply: SandboxArtifactReply) => Promise.resolve(),
    };
    const host = hostWith(bridge);
    const onBridge = vi.fn<(bridge: SandboxBridgeHost | null) => void>();
    render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "", "index.html"),
          title: "Artifact page",
          onBridge,
        })}
      </RunnerHostContext.Provider>,
    );

    await Promise.resolve();
    expect(registered).toHaveLength(1);
    expect(screen.queryByTitle("Artifact page")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(onBridge).not.toHaveBeenCalled();

    resolveRegister();
    await screen.findByTitle("Artifact page");
    await vi.waitFor(() => expect(onBridge).toHaveBeenCalled());
    expect(onBridge.mock.calls.at(-1)?.[0]).not.toBeNull();
  });

  it("unregisters the mount through the bridge when the frame unmounts", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const { unmount } = render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "", "index.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );

    await screen.findByTitle("Artifact page");
    const [mountId] = bridge.registered;
    unmount();
    await vi.waitFor(() => expect(bridge.unregistered).toEqual([mountId]));
  });

  it("mounts a fresh server, with a fresh mount id, when the artifact id changes", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const { rerender } = render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("first-art", "", "index.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await screen.findByTitle("Artifact page");
    const [firstMountId] = bridge.registered;

    rerender(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("second-art", "", "index.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await vi.waitFor(() => expect(bridge.registered).toHaveLength(2));
    const [, secondMountId] = bridge.registered;
    expect(secondMountId).not.toBe(firstMountId);
    await vi.waitFor(() => expect(bridge.unregistered).toContain(firstMountId));

    const iframe = await screen.findByTitle("Artifact page");
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "second-art",
        mountId: secondMountId,
        treePath: "",
        path: "index.html",
      }),
    );
  });

  it("includes a nested treePath in the artifact's served address", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "proof/nested", "index.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );

    const iframe = await screen.findByTitle("Artifact page");
    const [mountId] = bridge.registered;
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "myart",
        mountId: mountId,
        treePath: "proof/nested",
        path: "index.html",
      }),
    );
  });

  it("mounts a fresh server, with a fresh mount id, when only the treePath changes", async () => {
    // One source, reused and overridden on only `treePath`: a fresh call to
    // `artifactSource()` for the second render would also hand `sameSource`
    // a new manifest/readSpan/resolver identity, which alone would force a
    // remount and leave this test passing for the wrong reason.
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const firstSource = artifactSource("myart", "", "index.html");
    const { rerender } = render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: firstSource,
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await screen.findByTitle("Artifact page");
    const [firstMountId] = bridge.registered;

    rerender(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: { ...firstSource, treePath: "proof/nested" },
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await vi.waitFor(() => expect(bridge.registered).toHaveLength(2));
    const [, secondMountId] = bridge.registered;
    expect(secondMountId).not.toBe(firstMountId);
    await vi.waitFor(() => expect(bridge.unregistered).toContain(firstMountId));

    const iframe = await screen.findByTitle("Artifact page");
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "myart",
        mountId: secondMountId,
        treePath: "proof/nested",
        path: "index.html",
      }),
    );
  });

  it("serves a loose report.html as the entry document, not index.html", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "", "report.html"),
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );

    const iframe = await screen.findByTitle("Artifact page");
    const [mountId] = bridge.registered;
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "myart",
        mountId: mountId,
        treePath: "",
        path: "report.html",
      }),
    );
  });

  it("mounts a fresh server, with a fresh mount id, when only the entryPath changes", async () => {
    // One source, reused and overridden on only `entryPath` - same reasoning
    // as the treePath-only test above. The manifest needs both documents
    // from the start, since it stays the same object across both renders.
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const base = artifactSource("myart", "", "index.html");
    const firstSource: Extract<SandboxSource, { kind: "artifact" }> = {
      ...base,
      manifest: {
        files: {
          ...base.manifest.files,
          "report.html": {
            sha256: "sha-stub-report",
            byteLength: 0,
            mediaType: "text/html",
            status: "published",
          },
        },
      },
    };
    const { rerender } = render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: firstSource,
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await screen.findByTitle("Artifact page");
    const [firstMountId] = bridge.registered;

    rerender(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: { ...firstSource, entryPath: "report.html" },
          title: "Artifact page",
          onBridge: null,
        })}
      </RunnerHostContext.Provider>,
    );
    await vi.waitFor(() => expect(bridge.registered).toHaveLength(2));
    const [, secondMountId] = bridge.registered;
    expect(secondMountId).not.toBe(firstMountId);
    await vi.waitFor(() => expect(bridge.unregistered).toContain(firstMountId));

    const iframe = await screen.findByTitle("Artifact page");
    expect(iframe.getAttribute("src")).toBe(
      buildArtifactAddress({
        scheme: "traycer-sandbox",
        artifactId: "myart",
        mountId: secondMountId,
        treePath: "",
        path: "report.html",
      }),
    );
  });
});

describe("<SandboxFrame /> artifact source, with no artifact-serving capability", () => {
  it("shows the desktop-only placeholder and never creates a bridge when there is no runner host at all", () => {
    const onBridge = vi.fn<(bridge: SandboxBridgeHost | null) => void>();
    render(
      artifactFrame({
        source: artifactSource("myart", "", "index.html"),
        title: "Artifact page",
        onBridge,
      }),
    );

    expect(
      screen.getByText("This artifact opens in the desktop app."),
    ).toBeTruthy();
    expect(screen.queryByTitle("Artifact page")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(onBridge).not.toHaveBeenCalled();
  });

  it("shows the same placeholder when the runner host exists but cannot serve artifacts", () => {
    const onBridge = vi.fn<(bridge: SandboxBridgeHost | null) => void>();
    const host = hostWith(null);
    render(
      <RunnerHostContext.Provider value={host}>
        {artifactFrame({
          source: artifactSource("myart", "", "index.html"),
          title: "Artifact page",
          onBridge,
        })}
      </RunnerHostContext.Provider>,
    );

    expect(
      screen.getByText("This artifact opens in the desktop app."),
    ).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(onBridge).not.toHaveBeenCalled();
  });
});
