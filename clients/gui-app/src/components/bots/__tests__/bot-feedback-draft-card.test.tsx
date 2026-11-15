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
  ChatFeedbackDraftDecideResponse,
  ChatFeedbackDraftPreviewRequest,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * T356. The card a bot's channel shows for a feedback draft. It acts through
 * the existing `chat.feedbackDraft.preview` / `decide` hooks against the
 * SOURCE host the projection names, with no source transcript mounted: the
 * boundary faked here is only the host client the id resolves to, the host's
 * advertised methods, and the chat-session registry (empty - the source chat
 * is evicted or never opened on this device). The hooks, the card and its
 * state run for real.
 */

interface Boundary {
  readonly requestedHostIds: Array<string | null>;
  supported: boolean | null;
  clients: Record<string, HostClient<HostRpcRegistry> | null>;
}

const boundary = vi.hoisted((): Boundary => ({
  requestedHostIds: [],
  supported: true,
  clients: {},
}));
const sessionLookups = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    boundary.requestedHostIds.push(hostId);
    return hostId === null ? null : (boundary.clients[hostId] ?? null);
  },
  useHostDirectoryEntryForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => boundary.supported,
  useHostSupportsMethod: () => boundary.supported === true,
}));
vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => {
    sessionLookups.count += 1;
    return null;
  },
}));

import { BotFeedbackDraftCard } from "@/components/bots/bot-feedback-draft-card";

const SOURCE = {
  hostId: mockLocalHostEntry.hostId,
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

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const UNAVAILABLE_COPY =
  "This feedback draft is unavailable. Try again when its computer is connected.";
let requestCounter = 0;
const decideCalls: ChatFeedbackDraftDecideRequest[] = [];
const previewCalls: ChatFeedbackDraftPreviewRequest[] = [];
let decideGate: Gate<ChatFeedbackDraftDecideResponse>;
/** The host never answers the decide: the transport fails after the send. */
let decideTransportFails = false;

/**
 * A requester pinned to the source host, as `useHostClientForHostId` hands the
 * card: an unpinned client refuses every request at its preflight. The
 * messenger is the host: it records what reached it and answers the decide
 * from a deferred gate.
 */
function clientFor(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++requestCounter)}`,
      handlers: {
        "chat.feedbackDraft.decide": (params) => {
          decideCalls.push(params);
          if (decideTransportFails) {
            throw new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "connection lost",
              requestId: "lost",
              method: "chat.feedbackDraft.decide",
              fatalDetails: null,
            });
          }
          return decideGate.promise;
        },
        "chat.feedbackDraft.preview": (params) => {
          previewCalls.push(params);
          return {
            kind: "preview",
            details: [{ label: "Host version", value: "1.6.0" }],
            logTail: "[INFO] started",
            logTailTruncated: false,
          };
        },
      },
    }),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

/** Lets the fake clock and every queued promise run, as the host answers. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

function renderCard(draft: ToolCallFeedbackDraftStamp): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BotFeedbackDraftCard source={SOURCE} draft={draft} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  requestCounter = 0;
  decideCalls.length = 0;
  previewCalls.length = 0;
  boundary.requestedHostIds.length = 0;
  boundary.supported = true;
  boundary.clients = { [SOURCE.hostId]: clientFor() };
  sessionLookups.count = 0;
  decideGate = gate();
  decideTransportFails = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<BotFeedbackDraftCard />", () => {
  it("sends on the source host with no source transcript mounted, and shows Sent only once the handler says so", async () => {
    renderCard(PENDING);

    expect(screen.getByText(PENDING.goal)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(decideCalls).toHaveLength(1);

    const { clientActionId, ...request } = decideCalls[0];
    expect(request).toEqual({
      epicId: SOURCE.epicId,
      chatId: SOURCE.chatId,
      blockId: SOURCE.blockId,
      decision: "send",
      includeDiagnostics: false,
    });
    expect(clientActionId.length).toBeGreaterThan(0);
    expect(boundary.requestedHostIds).toContain(SOURCE.hostId);
    expect(boundary.requestedHostIds).not.toContain(null);
    // The terminal answer is still held: nothing is optimistic.
    expect(screen.queryByText("Sent")).toBeNull();

    decideGate.resolve({
      kind: "settled",
      feedbackDraft: { ...PENDING, state: "sent", decidedAt: 5 },
    });

    await settle();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("skips without diagnostics and never shows Sent", async () => {
    renderCard({ ...PENDING, suggestDiagnostics: true });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await settle();
    expect(decideCalls).toHaveLength(1);
    decideGate.resolve({
      kind: "settled",
      feedbackDraft: { ...PENDING, state: "skipped", decidedAt: 5 },
    });

    expect(decideCalls[0]).toMatchObject({
      decision: "skip",
      includeDiagnostics: false,
    });
    await settle();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.queryByText("Sent")).toBeNull();
  });

  it("reads the diagnostics preview only after the person asks to View", async () => {
    renderCard(PENDING);
    expect(previewCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    await settle();
    expect(screen.getByText("[INFO] started")).toBeTruthy();
    expect(previewCalls).toEqual([
      { epicId: SOURCE.epicId, chatId: SOURCE.chatId, blockId: SOURCE.blockId },
    ]);
  });

  it("turns read-only once the host says the person may not act, and sends nothing", async () => {
    renderCard(PENDING);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(decideCalls).toHaveLength(1);
    decideGate.resolve({
      kind: "error",
      code: "not-allowed",
      feedbackDraft: null,
    });

    await settle();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByText("Sent")).toBeNull();
    expect(decideCalls).toHaveLength(1);
  });

  it("goes read-only with the unavailable copy after an unknown transport result, and dispatches nothing more", async () => {
    decideTransportFails = true;
    renderCard(PENDING);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();

    expect(decideCalls).toHaveLength(1);
    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
    await settle();
    expect(decideCalls).toHaveLength(1);
  });

  it("reports the source unavailable, never Sent, when the host cannot serve it", async () => {
    renderCard(PENDING);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(decideCalls).toHaveLength(1);
    decideGate.resolve({
      kind: "error",
      code: "session-unavailable",
      feedbackDraft: null,
    });

    await settle();
    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.queryByText("Skipped")).toBeNull();
    expect(screen.getByText(PENDING.goal)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
  });

  it("goes read-only with the unavailable copy when the source block no longer carries the draft", async () => {
    renderCard(PENDING);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    decideGate.resolve({
      kind: "error",
      code: "not-draft-block",
      feedbackDraft: null,
    });
    await settle();

    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
    expect(decideCalls).toHaveLength(1);
  });

  it("shows a failed send with its retry affordance and its reason", () => {
    renderCard({
      ...PENDING,
      state: "failed",
      decidedAt: 5,
      failureReason: "network down",
    });

    expect(screen.getByText(/Not sent: network down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("is read-only, with nothing sent, on a source host lacking the method", () => {
    boundary.supported = false;
    renderCard(PENDING);

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(decideCalls).toHaveLength(0);
  });

  it("is read-only when the source host cannot be reached, with no fallback to another host", () => {
    boundary.clients = { "host-other": clientFor() };
    renderCard(PENDING);

    expect(boundary.requestedHostIds).not.toContain("host-other");
    expect(boundary.requestedHostIds).not.toContain(null);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
    expect(decideCalls).toHaveLength(0);
  });

  it("collapses a settled draft with no actions and never reads the source chat registry", () => {
    renderCard({ ...PENDING, state: "sent", decidedAt: 5 });

    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(sessionLookups.count).toBe(0);
  });
});
