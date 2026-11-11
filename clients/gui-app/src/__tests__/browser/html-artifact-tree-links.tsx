import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactOriginParts,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { HtmlArtifactFrame } from "@/components/html-artifact/html-artifact-frame";
import { HtmlArtifactLinkContext } from "@/components/html-artifact/html-artifact-link-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  NO_OUTSIDE_REFERENCE,
  type ArtifactManifest,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The real `HtmlArtifactFrame` showing a page at tree path `a/b` that links to
 * other artifacts in the tree, under a context that records what the frame
 * hands the app. Only a real browser can make a click trusted, and the prelude
 * reports only trusted clicks.
 */
interface ProbeWindow extends Window {
  __treeLinks?: {
    readonly links: SandboxArtifactLink[];
    readonly serve: (url: string) => Promise<{
      status: number;
      mediaType: string;
      base64: string;
    }>;
  };
}
const probeWindow: ProbeWindow = window;
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Tree links page</h1><p><a id="sibling" href="../sibling/index.html">Sibling</a> <a id="top" href="../../top/">Top</a> <a id="self" href="?tab=2">This page</a></p></body></html>`;
const pageBytes = new TextEncoder().encode(PAGE_HTML);
const PAGE_SHA = "b".repeat(64);
const manifest: ArtifactManifest = {
  files: {
    "index.html": {
      sha256: PAGE_SHA,
      byteLength: pageBytes.length,
      mediaType: "text/html",
      status: "local-only",
    },
  },
};
const readSpan: ArtifactReadSpan = (hash, offset, length, signal) => {
  signal.throwIfAborted();
  if (hash !== PAGE_SHA) return Promise.resolve({ unavailable: "missing" });
  return Promise.resolve({
    bytes: pageBytes.slice(offset, offset + length),
    totalBytes: pageBytes.length,
    mediaType: "text/html",
  });
};

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class Bridge implements SandboxArtifactBridge {
  readonly policySource = null;
  private readonly handlers = new Set<
    (request: SandboxArtifactRequest) => void
  >();
  private readonly replies = new Map<
    string,
    (reply: SandboxArtifactReply) => void
  >();
  private counter = 0;
  artifactOrigin({ artifactId, mountId }: SandboxArtifactOriginParts): string {
    return `https://artifact-${artifactId}--${mountId}.traycer-artifact.invalid`;
  }
  register(): Promise<void> {
    return Promise.resolve();
  }
  unregister(): Promise<void> {
    return Promise.resolve();
  }
  onRequest(handler: (request: SandboxArtifactRequest) => void): Disposable {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }
  onCancel(_handler: (cancel: SandboxArtifactCancel) => void): Disposable {
    return { dispose: () => undefined };
  }
  respond(reply: SandboxArtifactReply): Promise<void> {
    this.replies.get(reply.requestId)?.(reply);
    this.replies.delete(reply.requestId);
    return Promise.resolve();
  }
  private ask(mountId: string, path: string, offset: number) {
    const requestId = `tree-links-${String((this.counter += 1))}`;
    return new Promise<SandboxArtifactReply>((resolve) => {
      this.replies.set(requestId, resolve);
      for (const handler of this.handlers)
        handler({ requestId, mountId, path, offset, length: 4 * 1024 * 1024 });
    });
  }
  async serve(url: string) {
    const address = parseArtifactAddress(url);
    if (address === null)
      return { status: 404, mediaType: "text/plain", base64: "" };
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const reply = await this.ask(address.mountId, address.path, offset);
      if (reply.kind === "unavailable")
        return { status: reply.status, mediaType: "text/plain", base64: "" };
      chunks.push(reply.bytes);
      offset += reply.bytes.length;
      if (offset >= reply.totalBytes || reply.bytes.length === 0) {
        const whole = new Uint8Array(offset);
        let at = 0;
        for (const chunk of chunks) {
          whole.set(chunk, at);
          at += chunk.length;
        }
        return {
          status: 200,
          mediaType: reply.mediaType,
          base64: base64Of(whole),
        };
      }
    }
  }
}
const bridge = new Bridge();
const links: SandboxArtifactLink[] = [];
probeWindow.__treeLinks = { links, serve: (url) => bridge.serve(url) };

const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: "tree-links-host",
    websocketUrl: "ws://127.0.0.1:9/tree-links",
    version: "0.0.0-fixture",
    pid: 1,
    systemHostName: "fixture",
    displayName: "fixture",
    availability: "available",
  },
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: bridge },
);

const container = document.getElementById("root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <QueryClientProvider client={new QueryClient()}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <TooltipProvider>
        <HtmlArtifactLinkContext value={(link) => links.push(link)}>
          <div style={{ height: 700 }}>
            <HtmlArtifactFrame
              source={{
                kind: "artifact",
                artifactId: "tree-links-artifact",
                treePath: "a/b",
                entryPath: "index.html",
                manifest,
                readSpan,
                resolveOutsideReference: NO_OUTSIDE_REFERENCE,
              }}
              title="Tree links page"
            />
          </div>
        </HtmlArtifactLinkContext>
      </TooltipProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
