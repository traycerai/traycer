import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { QueryClient } from "@tanstack/react-query";
import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";
import { answerArtifactObjectRead } from "@/lib/host/test-support/artifact-object-answer";
import {
  createTestHostClient,
  resetTestHostClients,
} from "@/lib/host/test-support/test-host-client";
import type {
  LiveArtifactCardInput,
  LiveArtifactReadyInput,
} from "@/components/chat/segments/artifact-row";

type ObjectMode = "ok" | "missing" | "deferred";

interface RecordedRead {
  readonly method: string;
}

interface DeferredRead {
  readonly resolve: () => void;
}

export interface ArtifactReadScopeRecorder {
  readonly scope: {
    readonly hostId: string;
    readonly client: HostClient<HostRpcRegistry>;
    readonly lifetime: {
      readonly signal: AbortSignal;
      isCurrent(): boolean;
    };
  };
  readonly calls: ReadonlyArray<RecordedRead>;
  revoke(): void;
  /** Reads the host is holding and has not answered yet. */
  deferredCount(): number;
  settleDeferredReads(options: { readonly onlyFirst: boolean }): Promise<void>;
}

const INDEX_SHA = "a".repeat(64);
const CONTENT = "<html></html>";
const ROW_VIEWER_ID = "row-viewer";

export function createArtifactReadScopeRecorder(
  hostId: string,
  options: { readonly objectResponse: ObjectMode },
): ArtifactReadScopeRecorder {
  return buildRecorder(hostId, options, [], null);
}

/** A host that has every object except the ones whose sha256 are named. */
export function createArtifactReadScopeRecorderMissing(
  hostId: string,
  missingShas: ReadonlyArray<string>,
): ArtifactReadScopeRecorder {
  return buildRecorder(hostId, { objectResponse: "ok" }, missingShas, null);
}

/** A host that answers every object at once except the ones whose sha256 are named, which it holds until settled. */
export function createArtifactReadScopeRecorderHolding(
  hostId: string,
  heldShas: ReadonlyArray<string>,
): ArtifactReadScopeRecorder {
  return buildRecorder(hostId, { objectResponse: "ok" }, [], heldShas);
}

function buildRecorder(
  hostId: string,
  options: { readonly objectResponse: ObjectMode },
  missingShas: ReadonlyArray<string>,
  heldShas: ReadonlyArray<string> | null,
): ArtifactReadScopeRecorder {
  resetTestHostClients();
  const calls: RecordedRead[] = [];
  const deferred: DeferredRead[] = [];
  const controller = new AbortController();
  const answer = (
    request: EpicReadArtifactObjectRequest,
  ):
    | Promise<EpicReadArtifactObjectResponse>
    | EpicReadArtifactObjectResponse => {
    calls.push({ method: "epic.readArtifactObject" });
    if (missingShas.includes(request.sha256)) {
      return { kind: "unavailable", reason: "missing" };
    }
    const response = answerArtifactObjectRead(request, CONTENT, "text/html");
    const held =
      heldShas === null
        ? options.objectResponse === "deferred"
        : heldShas.includes(request.sha256);
    if (held) {
      return new Promise((resolve) => {
        deferred.push({ resolve: () => resolve(response) });
      });
    }
    if (options.objectResponse === "missing") {
      return { kind: "unavailable", reason: "missing" };
    }
    return response;
  };
  const client = createTestHostClient(
    hostId,
    ROW_VIEWER_ID,
    new QueryClient(),
    {
      "epic.readArtifactObject": answer,
    },
  );
  return {
    scope: {
      hostId,
      client,
      lifetime: {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      },
    },
    calls,
    revoke: () => controller.abort(),
    deferredCount: () => deferred.length,
    settleDeferredReads: async ({ onlyFirst }) => {
      const pending = onlyFirst ? deferred.slice(0, 1) : deferred.slice();
      for (const read of pending) read.resolve();
      await Promise.resolve();
    },
  };
}

export function readyLiveInput(
  overrides: Partial<Omit<LiveArtifactReadyInput, "kind">>,
): LiveArtifactCardInput {
  return {
    kind: "ready",
    artifactId: "art-1",
    epicId: "epic-1",
    hostId: "host-a",
    title: "Roadmap",
    manifest: {
      files: {
        "index.html": {
          sha256: INDEX_SHA,
          byteLength: 13,
          mediaType: "text/html",
        },
      },
    },
    treePath: "roadmap",
    entryPath: "index.html",
    readerGeneration: 1,
    sourceGeneration: 1,
    ...overrides,
  };
}
