import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SecretRequestDecision } from "@traycer/protocol/host/sandbox-secrets";
import type { SecretRequestDecideOutcome } from "@/hooks/sandboxes/use-secret-request-decide-mutation";
import type { SecretsNotificationDetail } from "@/lib/notifications/secrets-notification-detail";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

interface RowState {
  row: MergedNotificationRow | null;
}

const mocks = vi.hoisted(() => {
  const state: RowState = { row: null };
  return {
    state,
    mutate: vi.fn<(decision: SecretRequestDecision) => void>(),
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
  useHostDirectoryEntry: () => null,
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
vi.mock("@/hooks/sandboxes/use-secret-request-decide-mutation", () => ({
  useSecretRequestDecide: () => {
    const data: SecretRequestDecideOutcome | undefined = undefined;
    return {
      data,
      isPending: false,
      variables: undefined,
      mutate: mocks.mutate,
    };
  },
}));

import { NotificationRow } from "@/components/notifications/notification-row";

type GrantRequestDetail = Extract<
  SecretsNotificationDetail,
  { kind: "grant-request" }
>;

const GRANT: GrantRequestDetail = {
  kind: "grant-request",
  requestId: "request-1",
  secretName: "DB_PASSWORD",
  destination: "db.example.com",
  port: 3306,
  protocol: "mysql",
  reason: "Run the migration",
  sandboxName: "build-box",
  environmentId: null,
  teamName: null,
  decision: null,
  decidedBy: null,
};

function buildRow(
  overrides: Partial<MergedNotificationRow>,
): MergedNotificationRow {
  return {
    feedId: "host:secret-1",
    source: "host",
    sourceId: "secret-1",
    createdAt: 1_000,
    readAt: null,
    title: "Secret requested",
    body: "DB_PASSWORD • Waiting for your decision",
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    secrets: GRANT,
    hostKind: "secret.grant.requested",
    appLocalKind: null,
    globalEntry: null,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    sourceRef: "request-1",
    originHostId: null,
    category: "task",
    ...overrides,
  };
}

function renderRow(row: MergedNotificationRow): HTMLElement {
  mocks.state.row = row;
  render(
    <ul>
      <NotificationRow
        feedId={row.feedId}
        highlightRelocation={false}
        onActivate={vi.fn()}
        onAcknowledge={vi.fn()}
      />
    </ul>,
  );
  return screen.getByTestId("notification-entry");
}

beforeEach(() => {
  mocks.state.row = null;
  mocks.mutate.mockClear();
});
afterEach(cleanup);

describe("<NotificationRow /> secrets rows", () => {
  it("renders the grant-request card beneath the row's title and body", () => {
    const entry = renderRow(buildRow({}));
    const card = within(entry).getByTestId("secret-grant-request-card");
    const title = within(entry).getByTestId("notification-title");
    expect(title.textContent).toBe("Secret requested");
    expect(
      title.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(
      within(card).getByTestId("secret-grant-request-secret").textContent,
    ).toBe("DB_PASSWORD");
    expect(
      within(card).getByTestId("secret-grant-request-approve"),
    ).toBeTruthy();
  });

  it("keeps the answers outside the navigable body button", () => {
    const entry = renderRow(buildRow({}));
    const card = within(entry).getByTestId("secret-grant-request-card");
    expect(card.closest("button")).toBeNull();
  });

  it("withdraws the answers on a resolved grant request", () => {
    const entry = renderRow(buildRow({ resolvedAt: 5_000 }));
    expect(within(entry).getByTestId("secret-grant-request-card")).toBeTruthy();
    expect(
      within(entry).queryByTestId("secret-grant-request-approve"),
    ).toBeNull();
  });

  it("renders no card for a row with no secrets detail", () => {
    const entry = renderRow(
      buildRow({
        title: "Deploy checkout fix",
        secrets: null,
        hostKind: "approval.requested",
      }),
    );
    expect(within(entry).queryByTestId("secret-grant-request-card")).toBeNull();
    expect(within(entry).getByTestId("notification-title").textContent).toBe(
      "Deploy checkout fix",
    );
  });

  it("renders no card when the secrets field is absent", () => {
    const entry = renderRow(buildRow({ secrets: undefined }));
    expect(within(entry).queryByTestId("secret-grant-request-card")).toBeNull();
  });
});
