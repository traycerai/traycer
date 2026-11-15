import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { StoppedSandboxSendReceiptStrip } from "@/components/sandboxes/stopped-sandbox-send-receipts";
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  stoppedReceiptPicks,
  useStoppedSandboxSendReceiptStore,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";

const SANDBOX_HOST = "sandbox-host";
const TILE_HOST = "tile-host";
const SANDBOX_ID = "sbx-failed";
const EPIC_ID = "receipt-epic";
const PERSONAL_ENVIRONMENT_ID = "env-personal";

const lists = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-list-query")
  >()),
  useSandboxList: () => ({
    data: { sandboxes: lists.rows },
    dataUpdatedAt: 0,
    isError: false,
    refetch: () => Promise.resolve(undefined),
  }),
}));
vi.mock("@/hooks/epic/use-task-sandbox-end", () => ({
  useTaskSandboxHost: () => ({ kind: "other" }),
}));

beforeEach(() => {
  lists.rows = [
    sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "failed",
      environmentId: PERSONAL_ENVIRONMENT_ID,
    }),
  ];
});

afterEach(() => {
  cleanup();
  useStoppedSandboxSendReceiptStore.setState({ receipts: {}, strips: {} });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a receipt's failed-sandbox actions in a tile bound to another host", () => {
  it("read the environment list on the sandbox's host, not on the tile's", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: AUTHENTICATED_USER_FIXTURE_ID,
        userName: "Viewer",
        email: "viewer@example.test",
      },
      contextMetadata: {
        userId: AUTHENTICATED_USER_FIXTURE_ID,
        username: "viewer",
      },
    });
    useNewConversationModalStore.getState().setContent(EPIC_ID, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "keep this" }] },
      ],
    });
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    useStoppedSandboxSendReceiptStore.setState({
      receipts: {
        receipt: {
          id: "receipt",
          kind: "ended",
          sandboxId: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          confirmedAt: Date.now() + 60_000,
          userId: AUTHENTICATED_USER_FIXTURE_ID,
          epicId: EPIC_ID,
          returned: {
            kind: "task",
            epicId: EPIC_ID,
            parentId: null,
            placement: null,
            draftId,
          },
          existingSendIds: new Set(),
          picks: stoppedReceiptPicks(EPIC_ID, {}, {}),
        },
      },
    });
    const requestedOn: Array<string | null> = [];

    // The runtime runs on the sandbox's host, the one host it knows; the tile
    // is bound to a host it does not know.
    render(
      <SandboxBillingRuntime
        answer={{ kind: "ready", role: "admin" }}
        hostId={SANDBOX_HOST}
        environmentId={PERSONAL_ENVIRONMENT_ID}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
        onBinding={null}
        onEnvironmentListRequest={(hostId) => requestedOn.push(hostId)}
      >
        <TabHostContext.Provider value={TILE_HOST}>
          <StoppedSandboxSendReceiptStrip epicId={EPIC_ID} tabId="tab" />
        </TabHostContext.Provider>
      </SandboxBillingRuntime>,
    );

    await waitFor(() => expect(requestedOn).toContain(SANDBOX_HOST));
    expect(requestedOn).not.toContain(TILE_HOST);
  });
});
