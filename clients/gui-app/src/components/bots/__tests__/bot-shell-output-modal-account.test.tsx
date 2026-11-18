/**
 * The read-only shell output modal over a bot session: closing and focus return when its row is gone, a held shell row, and what happens when the signed-in account changes under an open window. Same real session view, background listing, modal and output body
 * as the other `bot-shell-output-modal` suites, over a drivable host stream.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { type FakeStreamSession } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { type ManagedCommandChatSessionStub } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { settleLegendList } from "@/components/chat/__tests__/legend-list-test-environment";
import {
  BOUND_HOST,
  COMMAND_ID,
  ROW,
  TRUNK_ID,
  USER_A,
  USER_B,
  dialog,
  emitLateOutput,
  emitLiveness,
  emitSnapshot,
  expectEverySubscribeIs,
  installShellFixtureLifecycle,
  installShellSession,
  mountSession,
  onlyStream,
  openBackground,
  openShellOutput,
  runningCommand,
  signInAs,
  signOut,
  teardownShellSession,
  view,
} from "@/components/bots/__tests__/bot-shell-output-modal-support";
import {
  hostClient,
  transportOpens,
} from "@/components/bots/__tests__/bot-shell-output-modal-mocks";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).routerMock(await importOriginal<typeof import("@tanstack/react-router")>()),
);
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).hostReachabilityMock(
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >(),
  ),
);
vi.mock("@/lib/host/use-durable-stream-transport", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).durableStreamTransportMock(),
);
vi.mock("@/lib/host/runtime", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).hostRuntimeMock(
    await importOriginal<typeof import("@/lib/host/runtime")>(),
  ),
);
vi.mock("@/hooks/host/use-host-directory-entry", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).hostDirectoryEntryMock(),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).chatSessionRegistryMock(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).hostClientForHostIdMock(),
);
vi.mock("@/hooks/host/use-tab-host-client", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).tabHostClientMock(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).guiHarnessCatalogMock(),
);
vi.mock("@/hooks/bots/use-bot-turn-locate-query", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).botTurnLocateQueryMock(),
);
vi.mock("@/hooks/chats/use-chat-locate-row", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).chatLocateRowMock(),
);
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  async () =>
    (
      await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
    ).managedCommandMutationsMock(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).hostDirectoryListMock(),
);
vi.mock("@/lib/links/open-link", async () =>
  (
    await import("@/components/bots/__tests__/bot-shell-output-modal-mocks")
  ).openLinkMock(),
);

installShellFixtureLifecycle();

describe("the read-only shell output modal over a bot session", () => {
  let session: ManagedCommandChatSessionStub;

  beforeEach(() => {
    session = installShellSession();
  });

  afterEach(() => {
    teardownShellSession(session);
  });

  it("reads Output unavailable on a host that lacks the bot stream, with no epic subscription", async () => {
    hostClient.support = "unsupported";

    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );

    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
    expect(
      hostClient.subscribes.some(
        (open) => open.method === "managedCommand.subscribeOutput",
      ),
    ).toBe(false);
  });

  it("returns focus to the row that opened it when the modal closes", async () => {
    const { trigger } = await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
    // Radix restores focus on a zero-delay timer once the content unmounts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  describe("when the row that opened the modal is gone by the time it closes", () => {
    const OTHER = "shell-other";

    async function closeWithTriggerRowGone(
      remaining: ManagedCommand[],
    ): Promise<void> {
      await openShellOutput(ROW, BOUND_HOST);
      act(() => {
        session.setCommands(remaining);
      });
      fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    }

    function focusIsInsideTheSessionView(): boolean {
      const active = document.activeElement;
      return (
        active !== null && active !== document.body && view().contains(active)
      );
    }

    it("lands focus inside the session view when other rows remain", async () => {
      await closeWithTriggerRowGone([runningCommand(OTHER)]);

      expect(focusIsInsideTheSessionView()).toBe(true);
    });

    it("lands focus inside the session view when it was the last row", async () => {
      await closeWithTriggerRowGone([]);

      expect(focusIsInsideTheSessionView()).toBe(true);
    });
  });

  it("opens from a held shell row too", async () => {
    session.setHeldUpdates([
      { commandId: "shell-held", description: "held watcher", heldAtMs: 4_000 },
    ]);
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      boundHostId: BOUND_HOST,
    });
    await settleLegendList();
    openBackground();

    const heldRow = within(view()).getByText("Held").closest("button");
    if (heldRow === null) throw new Error("the held row is not a button");
    fireEvent.click(heldRow);

    expectEverySubscribeIs("shell-held");
  });

  describe("when the signed-in account changes under an open window", () => {
    async function openWithLines(): Promise<FakeStreamSession> {
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["alpha-secret"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");
      expect(within(dialog()).getByText(/alpha-secret/)).toBeTruthy();
      return stream;
    }

    it("closes the modal and drops the lines at once for a different account, and a late frame from the old stream cannot bring them back", async () => {
      const stream = await openWithLines();
      const subscribesBefore = hostClient.subscribes.length;

      signInAs(USER_B, "signed-in");

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/alpha-secret/)).toBeNull();
      expect(stream.closed).toBe(true);

      emitLateOutput(stream, "alpha-late");
      emitSnapshot(stream, ["alpha-resnap"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen.queryByText(/alpha-late|alpha-resnap|alpha-secret/),
      ).toBeNull();
      expect(hostClient.subscribes).toHaveLength(subscribesBefore);
    });

    it("clears when the account signs out", async () => {
      const stream = await openWithLines();

      signOut();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/alpha-secret/)).toBeNull();
      expect(stream.closed).toBe(true);
    });

    it("offers no shell opener while no account is admitted, and opens nothing from the row", async () => {
      signOut();
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        boundHostId: BOUND_HOST,
      });
      await settleLegendList();
      openBackground();

      const row = within(view()).getByTestId(ROW);
      expect(within(row).queryByRole("button")).toBeNull();
      fireEvent.click(row);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(transportOpens).toEqual([]);
    });

    it("keeps the held lines when the same account goes unverified, as the same identity", async () => {
      const stream = await openWithLines();
      const subscribesBefore = hostClient.subscribes.length;

      signInAs(USER_A, "unverified");

      expect(within(dialog()).getByText(/alpha-secret/)).toBeTruthy();
      expect(stream.closed).toBe(false);
      expect(hostClient.subscribes).toHaveLength(subscribesBefore);
    });
  });
});
