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
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  NO_OUTSIDE_REFERENCE,
  type ArtifactManifest,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The real `HtmlArtifactFrame` filling a fixed-height tile with a one-page
 * artifact whose title sits at the very top of the page, full width, so it
 * reaches under the controls chip floating over the tile's top-right corner.
 * jsdom has no layout, so only a browser can say whether the title opens
 * below the chip and whether the room above it scrolls away with the page.
 *
 * The page resets `html` the way real pages do, which the inline inset must
 * survive. The tile is fixed-height so the frame has a box to fill.
 */
const ARTIFACT_ID = "inset-artifact";
const FRAME_TITLE = "Inset page";
const ENTRY_PATH = "index.html";
const PAGE_SHA = "a".repeat(64);
const TILE_HEIGHT_PX = 480;
const PARAGRAPH_COUNT = 40;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}html{padding:0}body{padding:16px;font:16px/1.4 sans-serif}h1{margin:0 0 16px;font-size:28px}p{margin:0 0 12px}</style></head><body><h1>A long page title that runs the full width of the page, so it reaches all the way under the controls floating over the top right corner</h1>${Array.from(
  { length: PARAGRAPH_COUNT },
  (_, index) => `<p>Paragraph ${String(index + 1)} of the page.</p>`,
).join("")}</body></html>`;
const pageBytes = new TextEncoder().encode(PAGE_HTML);

const manifest: ArtifactManifest = {
  files: {
    [ENTRY_PATH]: {
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

interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}
interface InsetProbe {
  readonly serve: (url: string) => Promise<ServedFile>;
}
interface ProbeWindow extends Window {
  __insetProbe?: InsetProbe;
}
const probeWindow: ProbeWindow = window;

const SPAN_BYTES = 4 * 1024 * 1024;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Native handlers reach the page through requests; this one is reached by `serve`. */
class FixtureArtifactBridge implements SandboxArtifactBridge {
  readonly policySource = null;
  private readonly handlers = new Set<
    (request: SandboxArtifactRequest) => void
  >();
  private readonly replies = new Map<
    string,
    (reply: SandboxArtifactReply) => void
  >();
  private requestCounter = 0;

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
    const requestId = `inset-${String((this.requestCounter += 1))}`;
    return new Promise<SandboxArtifactReply>((resolve) => {
      this.replies.set(requestId, resolve);
      for (const handler of this.handlers)
        handler({ requestId, mountId, path, offset, length: SPAN_BYTES });
    });
  }

  async serve(url: string): Promise<ServedFile> {
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
const artifactBridge = new FixtureArtifactBridge();
probeWindow.__insetProbe = { serve: (url) => artifactBridge.serve(url) };

const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: "inset-host",
    websocketUrl: "ws://127.0.0.1:9/inset",
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
// The mock declares `sandboxArtifacts` as null; a browser has no native scheme,
// so the frame would show the desktop-only placeholder instead of the page.
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: artifactBridge },
);

const queryClient = new QueryClient();

const container = document.getElementById("root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <TooltipProvider>
        <div style={{ height: TILE_HEIGHT_PX }}>
          <HtmlArtifactFrame
            source={{
              kind: "artifact",
              artifactId: ARTIFACT_ID,
              treePath: "",
              entryPath: ENTRY_PATH,
              manifest,
              readSpan,
              resolveOutsideReference: NO_OUTSIDE_REFERENCE,
            }}
            title={FRAME_TITLE}
          />
        </div>
      </TooltipProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
