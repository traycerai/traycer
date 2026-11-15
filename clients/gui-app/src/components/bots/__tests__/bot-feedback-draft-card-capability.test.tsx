import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftPreviewRequest,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * T356. The card's source host is not the host the channel is on, and its
 * negotiated method set can be unseeded (nothing has handshaken with it) or
 * stale (it said it lacked the method before an update). The card reads that
 * set from the REAL registry, which only a request to the host fills. Nothing
 * else here sends one, so a card that waits on the registry without asking
 * would hold Send forever. The messenger below is the host: answering
 * `host.status` records its manifest as a real handshake does.
 */

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;

const HOST_STATUS: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  // `null` = this fixture's host did not report the durable attempt,
  // which is exactly what host.status@1.2-and-older peers send.
  updateOperation: null,
  updateTransaction: null,
  storeFormats: null,
  install: null,
  processMemory: null,
  crossHostMessaging: null,
  sessions: null,
  updatesExternallyManaged: null,
  previousExit: null,
};

const SOURCE_HOST_ID = mockLocalHostEntry.hostId;
const CHANNEL_HOST_ID = mockRemoteHostEntry.hostId;

const FEEDBACK_METHODS = {
  "chat.feedbackDraft.decide": { major: 1, minor: 0 },
  "chat.feedbackDraft.preview": { major: 1, minor: 0 },
} as const;

interface Boundary {
  clients: Record<string, unknown>;
  /** The directory's reported version of the source host. */
  sourceVersion: string;
}

const boundary = vi.hoisted((): Boundary => ({
  clients: {},
  sourceVersion: "0.0.0-mock",
}));

// Only host resolution is faked; the support registry and the probe run for
// real. The directory entry hook rides the same module as the client lookup.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : (boundary.clients[hostId] ?? null),
  useHostDirectoryEntryForHostId: (hostId: string | null) =>
    hostId === mockLocalHostEntry.hostId
      ? { ...mockLocalHostEntry, version: boundary.sourceVersion }
      : null,
}));

import { BotFeedbackDraftCard } from "@/components/bots/bot-feedback-draft-card";

const SOURCE = {
  hostId: SOURCE_HOST_ID,
  epicId: "epic-1",
  chatId: "chat-1",
  blockId: "block-1",
} as const;

const PENDING: ToolCallFeedbackDraftStamp = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

const requests: {
  sourceStatus: number;
  channelStatus: number;
  decide: ChatFeedbackDraftDecideRequest[];
  preview: ChatFeedbackDraftPreviewRequest[];
} = { sourceStatus: 0, channelStatus: 0, decide: [], preview: [] };
let requestCounter = 0;

/** What the host's next handshake advertises for the feedback methods. */
let advertisesFeedback = true;

function hostClient(
  entry: typeof mockLocalHostEntry,
  onStatus: () => void,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++requestCounter)}`,
      handlers: {
        "host.status": () => {
          onStatus();
          // The real transport records the handshake's manifest on its ack.
          recordNegotiatedHostManifest(
            entry.hostId,
            advertisesFeedback
              ? { "host.status": { major: 1, minor: 0 }, ...FEEDBACK_METHODS }
              : { "host.status": { major: 1, minor: 0 } },
          );
          return HOST_STATUS;
        },
        "chat.feedbackDraft.decide": (params) => {
          requests.decide.push(params);
          return new Promise(() => undefined);
        },
        "chat.feedbackDraft.preview": (params) => {
          requests.preview.push(params);
          return {
            kind: "preview",
            details: [],
            logTail: "",
            logTailTruncated: false,
          };
        },
      },
    }),
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(entry);
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

/** `null` when there is no Send button, else whether it is disabled. */
function sendDisabled(): boolean | null {
  const button = screen.queryByRole("button", { name: "Send" });
  return button === null ? null : button.hasAttribute("disabled");
}

/** One query client per mount, so a re-render is the same mount. */
function renderCard(): { readonly rerender: () => void } {
  const queryClient = new QueryClient();
  // A fresh element each time: React skips an identical one.
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <BotFeedbackDraftCard source={{ ...SOURCE }} draft={{ ...PENDING }} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNegotiatedManifests();
  requestCounter = 0;
  requests.sourceStatus = 0;
  requests.channelStatus = 0;
  requests.decide.length = 0;
  requests.preview.length = 0;
  advertisesFeedback = true;
  boundary.sourceVersion = "0.0.0-mock";
  boundary.clients = {
    [SOURCE_HOST_ID]: hostClient(mockLocalHostEntry, () => {
      requests.sourceStatus += 1;
    }),
    [CHANNEL_HOST_ID]: hostClient(mockRemoteHostEntry, () => {
      requests.channelStatus += 1;
    }),
  };
});
afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  vi.useRealTimers();
});

describe("<BotFeedbackDraftCard /> source capability", () => {
  it("learns an unseeded source host's methods by asking that host, then sends there", async () => {
    renderCard();
    await settle();

    expect(requests.sourceStatus).toBe(1);
    expect(requests.channelStatus).toBe(0);
    expect(requests.preview).toHaveLength(0);
    expect(sendDisabled()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();

    expect(requests.decide).toHaveLength(1);
    expect(requests.decide[0]).toMatchObject({
      epicId: SOURCE.epicId,
      chatId: SOURCE.chatId,
      blockId: SOURCE.blockId,
      decision: "send",
    });
  });

  it("re-asks a source host that said it lacked the methods when its version changes in the same mount, and offers Send then", async () => {
    advertisesFeedback = false;
    recordNegotiatedHostManifest(SOURCE_HOST_ID, {
      "host.status": { major: 1, minor: 0 },
    });
    const view = renderCard();
    await settle();

    expect(requests.sourceStatus).toBe(1);
    expect(requests.channelStatus).toBe(0);
    expect(sendDisabled()).toBeNull();

    // The host was updated under the same id: a new version, and its next
    // handshake has the methods.
    advertisesFeedback = true;
    boundary.sourceVersion = "0.0.1-mock";
    view.rerender();
    await settle();

    expect(requests.sourceStatus).toBe(2);
    expect(sendDisabled()).toBe(false);
    expect(requests.decide).toHaveLength(0);
  });

  it("asks a host that answers with the methods once, not on every render", async () => {
    const view = renderCard();
    await settle();
    view.rerender();
    view.rerender();
    await settle();

    expect(requests.sourceStatus).toBe(1);
  });
});
