import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactOriginParts,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import {
  type ArtifactManifest,
  type ArtifactServerOptions,
} from "@/lib/sandbox/artifact-serving";
import { RunnerHostContext } from "@/providers/runner-host-context";

const { artifactServerCalls } = vi.hoisted(() => ({
  artifactServerCalls: [] as ArtifactServerOptions[],
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
// A thin spy over the real server: the frame mints the nonce the served
// document is proven by, so reading it back is the only way a test can play
// the part of that document without re-deriving it.
vi.mock("@/lib/sandbox/artifact-serving", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sandbox/artifact-serving")>();
  class SpyArtifactServer extends actual.ArtifactServer {
    constructor(options: ArtifactServerOptions) {
      artifactServerCalls.push(options);
      super(options);
    }
  }
  return { ...actual, ArtifactServer: SpyArtifactServer };
});

afterEach(() => {
  cleanup();
  artifactServerCalls.length = 0;
});

const POLICY_SOURCE = "traycer-sandbox:";

function artifactSource(
  canvas: boolean | undefined,
): Extract<SandboxSource, { kind: "artifact" }> {
  const manifest: ArtifactManifest = {
    files: {
      "index.html": {
        sha256: "sha-stub",
        byteLength: 0,
        mediaType: "text/html",
        status: "published",
      },
    },
  };
  return {
    kind: "artifact",
    ...(canvas === undefined ? {} : { canvas }),
    artifactId: "canvas-art",
    treePath: "",
    entryPath: "index.html",
    manifest,
    // jsdom never loads the custom-scheme iframe, so nothing is read.
    readSpan: () => Promise.resolve({ unavailable: "missing" }),
    resolveOutsideReference: () => null,
  };
}

function runnerHost(): IRunnerHost {
  const bridge: SandboxArtifactBridge = {
    policySource: POLICY_SOURCE,
    artifactOrigin: ({ artifactId, mountId }: SandboxArtifactOriginParts) =>
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

interface Mounted {
  readonly listeners: {
    readonly onRelativeLink: Mock<(href: string) => void>;
    readonly onPageError: Mock<(error: CanvasPageError) => void>;
  };
  readonly frameWindow: Window;
  readonly nonce: string;
}

/** Mounts a served frame and waits until its bridge is listening. */
async function mountServed(canvas: boolean | undefined): Promise<Mounted> {
  const listeners = {
    onRelativeLink: vi.fn<(href: string) => void>(),
    onPageError: vi.fn<(error: CanvasPageError) => void>(),
  };
  const onBridge = vi.fn<(bridge: SandboxBridgeHost | null) => void>();
  render(
    <RunnerHostContext.Provider value={runnerHost()}>
      <SandboxFrame
        source={artifactSource(canvas)}
        kind="page"
        title="Canvas page"
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
        onBridge={onBridge}
        onRelativeLink={listeners.onRelativeLink}
        onPageError={listeners.onPageError}
        ref={null}
      />
    </RunnerHostContext.Provider>,
  );
  const iframe = await screen.findByTitle("Canvas page");
  await vi.waitFor(() => expect(onBridge.mock.calls.at(-1)?.[0]).toBeTruthy());
  const frameWindow =
    iframe instanceof HTMLIFrameElement ? iframe.contentWindow : null;
  const nonce = artifactServerCalls.at(-1)?.document.nonce;
  if (frameWindow === null || nonce === undefined)
    throw new Error("the served frame never mounted");
  return { listeners, frameWindow, nonce };
}

/** A message arriving at the app window from `source`. */
function post(data: unknown, source: Window | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function documentReady(nonce: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "traycer/notifications/document-ready",
    params: { nonce, height: 100 },
  };
}

function link(href: string, nonce: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "traycer/canvas/relative-link",
    params: { href, nonce },
  };
}

function pageError(message: string, nonce: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "traycer/canvas/page-error",
    params: { message, stack: null, nonce },
  };
}

describe("<SandboxFrame /> canvas notifications", () => {
  it("delivers a canvas notification from the frame's own window once the nonce is proven", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(true);
    post(documentReady(nonce), frameWindow);
    post(link("next.html", nonce), frameWindow);
    post(pageError("boom", nonce), frameWindow);

    expect(listeners.onRelativeLink).toHaveBeenCalledWith("next.html");
    expect(listeners.onPageError).toHaveBeenCalledWith({
      message: "boom",
      stack: null,
    });
  });

  it("ignores the same notification from any other window", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(true);
    post(documentReady(nonce), frameWindow);

    post(link("next.html", nonce), window);
    post(link("next.html", nonce), null);
    post(pageError("boom", nonce), window.parent);
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    post(link("next.html", nonce), sibling.contentWindow);
    sibling.remove();

    expect(listeners.onRelativeLink).not.toHaveBeenCalled();
    expect(listeners.onPageError).not.toHaveBeenCalled();
  });

  it("cannot prove the document from another window", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(true);
    // A forged ready from elsewhere must not open the gate for the frame's
    // own later messages to be trusted on its account.
    post(documentReady(nonce), window);
    post(link("next.html", nonce), frameWindow);
    expect(listeners.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops a notification from the frame that carries the wrong nonce", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(true);
    post(documentReady(nonce), frameWindow);
    post(link("next.html", "someone-else"), frameWindow);
    expect(listeners.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops a notification that arrives before the page proved itself", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(true);
    post(link("next.html", nonce), frameWindow);
    expect(listeners.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops canvas notifications from an artifact that is not a canvas", async () => {
    const { listeners, frameWindow, nonce } = await mountServed(undefined);
    post(documentReady(nonce), frameWindow);
    post(link("next.html", nonce), frameWindow);
    post(pageError("boom", nonce), frameWindow);
    expect(listeners.onRelativeLink).not.toHaveBeenCalled();
    expect(listeners.onPageError).not.toHaveBeenCalled();
  });
});
