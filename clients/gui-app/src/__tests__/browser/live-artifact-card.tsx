import { useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";
import {
  LiveArtifactRow,
  type ArtifactReadScope,
  type LiveArtifactCardInput,
} from "@/components/chat/segments/artifact-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  FixtureArtifactBridge,
  base64Of,
  type ServedFile,
} from "./chat-artifact-card-host-support";
import "@/lib/theme-applier";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * THE REAL `LiveArtifactRow` over the real sandbox frame, artifact server and
 * expansion owner, for what jsdom cannot decide about the live card: the page
 * really loads in one sandboxed iframe; Expand and lower keep that very
 * iframe element, while a save that changes the page bytes replaces the frame
 * once inside the surviving raised card (a save that changes none keeps it);
 * revoking the reader's lifetime lowers the raise and withdraws the page; a
 * missing entry stops at Retry, which asks the provider and reloads nothing
 * until a new admission. `?theme=dark` sets the real settings-store theme
 * before the first render, so the real theme applier paints the dark theme.
 *
 * The provider, controller and registry are NOT here (their cases are jsdom
 * ones): this fixture hands the row exactly what an admitted provider hands it,
 * a ready input, `{ hostId, client, lifetime }` and the two callbacks.
 *
 * `window.__liveCardProbe` is the spec's handle; counters live on `body`.
 */
const HOST_ID = "live-card-host";
const EPIC_ID = "live-card-epic";
const ARTIFACT_ID = "live-report";
const ENTRY_PATH = "index.html";

function pageHtml(version: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}body{font:16px/1.4 sans-serif;padding:8px 16px}
</style></head><body><h2 id="known">Live report version ${String(version)}</h2></body></html>`;
}

const bytesBySha = new Map<string, Uint8Array>();
function storeVersion(version: number): { sha: string; bytes: Uint8Array } {
  const sha = version.toString(16).padStart(64, "a");
  const bytes = new TextEncoder().encode(pageHtml(version));
  bytesBySha.set(sha, bytes);
  return { sha, bytes };
}

interface CardState {
  readonly version: number;
  readonly readerGeneration: number;
  readonly entryMissing: boolean;
  /** Bumped by a save that changes no bytes: a new manifest object, the same shas. */
  readonly revision: number;
}
let state: CardState = {
  version: 1,
  readerGeneration: 1,
  revision: 0,
  entryMissing: new URLSearchParams(location.search).get("entry") === "missing",
};
const listeners = new Set<() => void>();
function update(next: Partial<CardState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function bump(name: "reads" | "retries" | "opens"): void {
  const body = document.body;
  body.dataset[name] = String(Number(body.dataset[name] ?? "0") + 1);
}

const lifetimeController = new AbortController();
const lifetime = {
  signal: lifetimeController.signal,
  isCurrent: () => !lifetimeController.signal.aborted,
};

function readObject(
  request: EpicReadArtifactObjectRequest,
): EpicReadArtifactObjectResponse {
  bump("reads");
  const bytes = bytesBySha.get(request.sha256);
  if (bytes === undefined || state.entryMissing)
    return { kind: "unavailable", reason: "missing" };
  if (request.want.kind !== "range")
    throw new Error("this fixture serves ranges only");
  const { offset, length } = request.want;
  return {
    kind: "bytes",
    bytesBase64: base64Of(bytes.slice(offset, offset + length)),
    offset,
    totalBytes: bytes.length,
    mediaType: "text/html",
  };
}

const readScope: ArtifactReadScope = {
  hostId: HOST_ID,
  lifetime,
  client: {
    requestWithSignal: (_method, request) =>
      Promise.resolve(readObject(request)),
  },
};

const bridge = new FixtureArtifactBridge();
const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/live-card",
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
// A browser has no native artifact scheme: the mock declares `sandboxArtifacts`
// as null, so the frame would show the desktop-only placeholder.
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: bridge },
);

interface LiveCardProbe {
  readonly serve: (url: string) => Promise<ServedFile>;
  /**
   * A routine head save: a new manifest under the same generations. The
   * page's commit has happened when this returns, so what the spec reads next
   * is the card AFTER the save, with no wait.
   */
  readonly saveHead: () => void;
  /** A save that rewrites the manifest object but not one byte of the page. */
  readonly saveSameBytes: () => void;
  /** The reader's lifetime ends, as on revoke, sign-out or a host change. */
  readonly revoke: () => void;
  /** The provider's re-admission: a new reader generation, entry present. */
  readonly admitAgain: () => void;
}
declare global {
  interface Window {
    __liveCardProbe?: LiveCardProbe;
  }
}

storeVersion(1);
window.__liveCardProbe = {
  serve: (url) => bridge.serve(url),
  saveHead: () => {
    const next = state.version + 1;
    storeVersion(next);
    flushSync(() => update({ version: next }));
  },
  saveSameBytes: () =>
    flushSync(() => update({ revision: state.revision + 1 })),
  revoke: () => lifetimeController.abort(),
  admitAgain: () =>
    flushSync(() =>
      update({
        readerGeneration: state.readerGeneration + 1,
        entryMissing: false,
      }),
    ),
};

function snapshot(): CardState {
  return state;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function inputOf(card: CardState): LiveArtifactCardInput {
  const { sha, bytes } = storeVersion(card.version);
  return {
    kind: "ready",
    artifactId: ARTIFACT_ID,
    epicId: EPIC_ID,
    hostId: HOST_ID,
    title: "Live report",
    manifest: {
      files: {
        [ENTRY_PATH]: {
          sha256: sha,
          byteLength: bytes.length,
          mediaType: "text/html",
        },
      },
    },
    treePath: ARTIFACT_ID,
    entryPath: ENTRY_PATH,
    readerGeneration: card.readerGeneration,
    sourceGeneration: 1,
  };
}

const queryClient = new QueryClient();

export function LiveArtifactCardFixture(): ReactNode {
  const card = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <div className="w-full p-2">
            <LiveArtifactRow
              artifact={inputOf(card)}
              readScope={readScope}
              onOpen={() => bump("opens")}
              onRetry={() => bump("retries")}
            />
          </div>
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

// The real theme store, set BEFORE mount: the module-level applier reacts to it.
if (new URLSearchParams(location.search).get("theme") === "dark")
  useSettingsStore.setState({ theme: "dark" });

const container = document.getElementById("root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<LiveArtifactCardFixture />);
