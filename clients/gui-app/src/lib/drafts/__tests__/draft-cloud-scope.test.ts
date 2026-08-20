import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { DraftWrite } from "@traycer/protocol/host";
import {
  acquireDraftMirrorSession,
  draftsCloudScopeId,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";

const HOST_ID = "host-scope";
const SCOPE_ID = "scp_testdraftsscopeid000001";

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
});

function streamHarness(): {
  readonly client: { subscribe: () => IStreamSession };
  readonly emit: (frame: {
    readonly kind: string;
    readonly hasBinaryPayload: boolean;
    readonly scopeId?: string;
  }) => void;
  readonly subscribeCalls: { count: number };
} {
  let onFrame: ServerFrameHandler | null = null;
  const subscribeCalls = { count: 0 };
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: (handler) => {
      onFrame = handler;
    },
    onStatusChange: () => undefined,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    emit: (frame) => {
      onFrame?.(frame, null);
    },
    subscribeCalls,
    client: {
      subscribe: () => {
        subscribeCalls.count += 1;
        return session;
      },
    },
  };
}

function listNullClient() {
  return {
    request: (method: string, params: unknown) => {
      void params;
      if (method === "drafts.list") {
        return Promise.resolve({
          drafts: [],
          tombstones: [],
          snapshotSeq: 0,
          scopeId: null,
        });
      }
      if (method === "drafts.upsert") {
        const write = (params as { draft: DraftWrite }).draft;
        return Promise.resolve({
          draft: {
            ...write,
            ownerHostId: HOST_ID,
            origin: "own" as const,
            adoption: { state: "adopted" as const, hostId: HOST_ID },
            publication: {
              status: "unpublished" as const,
              lastPublishedAt: null,
              publishedRevision: null,
              halted: null,
            },
            revision: 1,
          },
        });
      }
      return Promise.reject(new Error(`unexpected ${String(method)}`));
    },
  };
}

describe("cloud-drafts scope subscribe frame", () => {
  it("makes the cloud-drafts section visible after an advisory scope frame", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    expect(draftsCloudScopeId(HOST_ID)).toBeNull();
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(false);
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(draftsCloudScopeId(HOST_ID)).toBe(SCOPE_ID);
    });
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
  });

  it("makes the section visible when the first subscribe frame is a late-joiner peek", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(draftsCloudScopeId(HOST_ID)).toBe(SCOPE_ID);
    });
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
  });
});
