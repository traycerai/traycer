import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftDecideResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

interface BoundaryState {
  row: MergedNotificationRow | null;
  originEntry: HostDirectoryEntry | null;
  supported: boolean | null;
  data: ChatFeedbackDraftDecideResponse | undefined;
  client: HostClient<HostRpcRegistry> | null;
}

const mocks = vi.hoisted(() => {
  const state: BoundaryState = {
    row: null,
    originEntry: null,
    supported: true,
    data: undefined,
    client: null,
  };
  return {
    state,
    mutate: vi.fn<(request: ChatFeedbackDraftDecideRequest) => void>(),
  };
});

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationRow: () => mocks.state.row,
  };
});
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.state.originEntry,
}));
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.state.client,
}));
vi.mock("@/hooks/chats/use-chat-feedback-draft", () => ({
  useChatFeedbackDraftSupported: () => mocks.state.supported,
  useChatFeedbackDraftDecideMutation: () => ({
    data: mocks.state.data,
    isPending: false,
    mutate: mocks.mutate,
  }),
}));

import { NotificationRow } from "@/components/notifications/notification-row";

const ORIGIN_HOST_ID = "host-origin";

const AVAILABLE_ORIGIN: HostDirectoryEntry = {
  hostId: ORIGIN_HOST_ID,
  label: "Origin computer",
  kind: "local",
  websocketUrl: null,
  version: null,
  transportDialability: "dialable",
};

const STAMP = {
  category: "tool-bug",
  toolName: null,
  goal: "Read a file",
  observed: "It failed",
  suggestion: null,
  suggestDiagnostics: false,
  decidedAt: null,
  failureReason: null,
} as const;

function buildRow(
  overrides: Partial<MergedNotificationRow>,
): MergedNotificationRow {
  return {
    feedId: "host:draft-1",
    source: "host",
    sourceId: "draft-1",
    createdAt: 1_000,
    readAt: null,
    title: "Fix the build",
    body: "Agent • Feedback draft to review",
    payload: {
      kind: "feedbackDraft",
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "block-1",
    },
    secrets: null,
    hostKind: "feedback.drafted",
    appLocalKind: null,
    globalEntry: null,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    sourceRef: "block-1",
    originHostId: ORIGIN_HOST_ID,
    category: "task",
    ...overrides,
  };
}

function renderRow(
  row: MergedNotificationRow,
  onActivate: (row: MergedNotificationRow) => void,
): void {
  mocks.state.row = row;
  render(
    <ul>
      <NotificationRow
        feedId={row.feedId}
        highlightRelocation={false}
        onActivate={onActivate}
        onAcknowledge={vi.fn()}
      />
    </ul>,
  );
}

beforeEach(() => {
  mocks.state.row = null;
  mocks.state.originEntry = AVAILABLE_ORIGIN;
  mocks.state.supported = true;
  mocks.state.data = undefined;
  mocks.state.client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
    findHostById: () => AVAILABLE_ORIGIN,
  });
  mocks.mutate.mockClear();
});
afterEach(cleanup);

describe("<NotificationRow /> feedback draft rows", () => {
  it("sends the draft without diagnostics and does not open the row", () => {
    const onActivate = vi.fn<(row: MergedNotificationRow) => void>();
    renderRow(buildRow({}), onActivate);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [request] = mocks.mutate.mock.calls[0];
    const { clientActionId, ...rest } = request;
    expect(rest).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "block-1",
      decision: "send",
      includeDiagnostics: false,
    });
    expect(clientActionId.length).toBeGreaterThan(0);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("offers no Send on a resolved row", () => {
    renderRow(buildRow({ resolvedAt: 5_000 }), vi.fn());
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("offers no Send when the host lacks the method", () => {
    mocks.state.supported = false;
    renderRow(buildRow({}), vi.fn());
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("offers no Send when the origin host is unavailable", () => {
    mocks.state.originEntry = null;
    renderRow(buildRow({}), vi.fn());
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("confirms a sent draft and withdraws Send", () => {
    mocks.state.data = {
      kind: "settled",
      feedbackDraft: { ...STAMP, state: "sent", decidedAt: 6_000 },
    };
    renderRow(buildRow({}), vi.fn());
    expect(screen.getByText("Sent to the Traycer team.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows why a send failed and keeps Send available", () => {
    mocks.state.data = {
      kind: "settled",
      feedbackDraft: {
        ...STAMP,
        state: "failed",
        failureReason: "Network unreachable",
      },
    };
    renderRow(buildRow({}), vi.fn());
    expect(screen.getByText(/Network unreachable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
