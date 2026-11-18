/**
 * The read-only shell output modal over a bot session whose viewing host is not the bot's bound host: the bound host is the only one subscribed to, and a binding that moves keeps the held lines frozen. Same real session view, background listing, modal and output body
 * as the other `bot-shell-output-modal` suites, over a drivable host stream.
 */
import { act, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ManagedCommandChatSessionStub } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import {
  BOUND_HOST,
  COMMAND_ID,
  HOST_ID,
  REBINDINGS,
  ROW,
  TRUNK_ID,
  dialog,
  emitLateOutput,
  emitLiveness,
  emitSnapshot,
  endedCommand,
  installShellFixtureLifecycle,
  installShellSession,
  onlyStream,
  openShellOutput,
  openThenRebind,
  runningCommand,
  sessionTree,
  teardownShellSession,
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

  describe("when the viewing host is not the bot's bound host", () => {
    it("subscribes on the bound host only, never on the viewing host", async () => {
      await openShellOutput(ROW, BOUND_HOST);

      expect(transportOpens.length).toBeGreaterThan(0);
      expect(transportOpens).not.toContain(HOST_ID);
      expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
    });

    it.each(REBINDINGS)(
      "keeps its lines and reads Not live at once, still on the old host, after the binding moves to %s",
      async (_label, nextHostId) => {
        const { subscribesAtRebind } = await openThenRebind(nextHostId);

        expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
        expect(hostClient.subscribes).toHaveLength(subscribesAtRebind);
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
        expect(
          within(dialog()).getByTestId("bot-shell-output-not-live"),
        ).toBeTruthy();
      },
    );

    it.each(REBINDINGS)(
      "accepts no later output, snapshot or liveness frame from the old host after the binding moves to %s",
      async (_label, nextHostId) => {
        const { stream } = await openThenRebind(nextHostId);

        emitLateOutput(stream, "pinned-late");
        emitSnapshot(stream, ["pinned-resnap"], runningCommand(COMMAND_ID));
        emitLiveness(stream, "live");
        act(() => {
          stream.emit(
            {
              kind: "status",
              command: endedCommand(COMMAND_ID),
              hasBinaryPayload: false,
            },
            null,
          );
          stream.emit({ kind: "deleted", hasBinaryPayload: false }, null);
        });

        expect(
          within(dialog()).queryByText(/pinned-late|pinned-resnap/),
        ).toBeNull();
        expect(
          within(dialog()).queryByTestId("bot-shell-output-unavailable"),
        ).toBeNull();
        expect(
          within(dialog()).queryByText(/exited|ended|finished/i),
        ).toBeNull();
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
        expect(
          within(dialog()).getByTestId("bot-shell-output-not-live"),
        ).toBeTruthy();
      },
    );

    it("stays frozen when the binding returns to the host it opened on", async () => {
      const { mounted } = await openShellOutput(ROW, BOUND_HOST);
      const stream = onlyStream();
      emitSnapshot(stream, ["pinned-1"], runningCommand(COMMAND_ID));
      emitLiveness(stream, "live");
      for (const boundHostId of ["host-rebound", BOUND_HOST]) {
        mounted.rerender(
          sessionTree({ chatId: TRUNK_ID, threadId: null, boundHostId }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
      }

      emitLateOutput(stream, "pinned-late");
      emitLiveness(stream, "live");

      expect(
        within(dialog()).getByTestId("bot-shell-output-not-live"),
      ).toBeTruthy();
      expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();
      expect(within(dialog()).queryByText(/pinned-late/)).toBeNull();
      expect(new Set(transportOpens)).toEqual(new Set([BOUND_HOST]));
    });

    it.each(REBINDINGS)(
      "clears the held lines when the old host then denies access, after the binding moves to %s",
      async (_label, nextHostId) => {
        const { stream } = await openThenRebind(nextHostId);
        expect(within(dialog()).getByText(/pinned-1/)).toBeTruthy();

        act(() =>
          stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
        );

        expect(within(dialog()).queryByText(/pinned-1/)).toBeNull();
        expect(
          within(dialog()).getByTestId("bot-shell-output-unavailable"),
        ).toBeTruthy();
      },
    );
  });
});
