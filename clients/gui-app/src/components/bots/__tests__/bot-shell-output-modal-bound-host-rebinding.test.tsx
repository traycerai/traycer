/**
 * The read-only shell output modal over a bot session whose viewing host is not the bot's bound host: later frames from the old host after the binding moves, a fresh reopen, and host reachability. Same real session view, background listing, modal and output body
 * as the other `bot-shell-output-modal` suites, over a drivable host stream.
 */
import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ManagedCommandChatSessionStub } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { settleLegendList } from "@/components/chat/__tests__/legend-list-test-environment";
import {
  BOUND_HOST,
  COMMAND_ID,
  ControlledSession,
  HOST_ID,
  REBINDINGS,
  ROW,
  TRUNK_ID,
  bindingControl,
  dialog,
  emitLiveness,
  emitSnapshot,
  installShellFixtureLifecycle,
  installShellSession,
  onlyStream,
  openBackground,
  openShellOutput,
  runningCommand,
  sessionTree,
  teardownShellSession,
  view,
} from "@/components/bots/__tests__/bot-shell-output-modal-support";
import {
  hostClient,
  mocks,
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

  describe("when the viewing host is not the bot's bound host", () => {
    it.each(REBINDINGS)(
      "never shows the first snapshot that arrives after the binding moved to %s",
      async (_label, nextHostId) => {
        const { mounted } = await openShellOutput(ROW, BOUND_HOST);
        const stream = onlyStream();
        expect(within(dialog()).getByText(/Loading output/)).toBeTruthy();

        mounted.rerender(
          sessionTree({
            chatId: TRUNK_ID,
            threadId: null,
            boundHostId: nextHostId,
          }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        emitSnapshot(stream, ["stale-first"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");

        expect(within(dialog()).queryByText(/stale-first/)).toBeNull();
        expect(within(dialog()).queryByText(/Loading output/)).toBeNull();
        expect(
          within(dialog()).queryByTestId("bot-shell-output-not-live"),
        ).not.toBeNull();
      },
    );

    it("leaves no dialog and no lines when the bot surface drops the session view", async () => {
      const { mounted } = await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      mounted.rerender(<StrictMode>{null}</StrictMode>);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/pinned-1/)).toBeNull();
      expect(stream.closed).toBe(true);
    });

    it("stays frozen when the binding moves before the output session exists and is back on the opened host before the stream is created", async () => {
      render(<ControlledSession initialBoundHostId={BOUND_HOST} />);
      await settleLegendList();
      openBackground();
      const trigger = within(within(view()).getByTestId(ROW)).getByRole(
        "button",
      );
      // The stream is created inside the view's effect; the binding returns in
      // the same batch as the session, never having been seen with a session.
      mocks.onTransportOpen = () => bindingControl.set(BOUND_HOST);

      act(() => {
        fireEvent.click(trigger);
        bindingControl.set("host-rebound");
      });
      const stream = onlyStream();
      emitSnapshot(stream, ["stale-first"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(within(dialog()).queryByText(/stale-first/)).toBeNull();
      expect(within(dialog()).queryByText(/Loading output/)).toBeNull();
      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
    });

    it.each(REBINDINGS)(
      "reads the new binding on a fresh reopen after the binding moved to %s",
      async (_label, nextHostId) => {
        const { mounted } = await openShellOutput(ROW, BOUND_HOST);
        const stream = onlyStream();
        emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");
        mounted.rerender(
          sessionTree({
            chatId: TRUNK_ID,
            threadId: null,
            boundHostId: nextHostId,
          }),
        );
        fireEvent.keyDown(dialog(), { key: "Escape", code: "Escape" });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        const opensBefore = transportOpens.length;

        fireEvent.click(
          within(within(view()).getByTestId(ROW)).getByRole("button"),
        );

        if (nextHostId === null) {
          expect(
            within(dialog()).getByTestId("bot-shell-output-unavailable"),
          ).toBeTruthy();
          expect(transportOpens).toHaveLength(opensBefore);
        } else {
          expect(transportOpens.length).toBeGreaterThan(opensBefore);
          expect(transportOpens.slice(opensBefore)).toContain(nextHostId);
          expect(transportOpens.slice(opensBefore)).not.toContain(BOUND_HOST);
          expect(within(dialog()).queryByText(/pinned-1/)).toBeNull();
        }
      },
    );

    it("keeps the lines and says Not live when the bound host is unreachable, though the viewing host is reachable", async () => {
      mocks.unreachableHosts.add(BOUND_HOST);
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();

      emitSnapshot(stream, ["bound-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
      expect(within(dialog()).getByText(/bound-1/)).toBeTruthy();
      expect(transportOpens).not.toContain(HOST_ID);
    });

    it("reads live when the bound host is reachable even though the viewing host is not", async () => {
      mocks.unreachableHosts.add(HOST_ID);
      await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();

      emitSnapshot(stream, ["bound-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");

      expect(
        within(dialog()).queryByTestId("bot-shell-output-not-live"),
      ).toBeNull();
      expect(within(dialog()).getByText(/bound-1/)).toBeTruthy();
    });

    it("reads Output unavailable and dials no host when the bot has no bound host", async () => {
      await openShellOutput(ROW, null);

      expect(
        within(dialog()).getByTestId("bot-shell-output-unavailable"),
      ).toBeTruthy();
      expect(transportOpens).toEqual([]);
      expect(hostClient.subscribes).toEqual([]);
    });
  });
});
