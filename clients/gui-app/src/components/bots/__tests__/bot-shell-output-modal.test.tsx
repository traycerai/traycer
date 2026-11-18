/**
 * The read-only shell output modal over a bot session: opening it from a shell row, what it shows while the stream is live, held, dropped or denied, and where focus returns when it closes. Same real session view, background listing, modal and output body
 * as the other `bot-shell-output-modal` suites, over a drivable host stream.
 */
import { act, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ManagedCommandChatSessionStub } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import {
  BOUND_HOST,
  COMMAND_ID,
  dialog,
  emitLiveness,
  emitSnapshot,
  endedCommand,
  expectEverySubscribeIs,
  installShellFixtureLifecycle,
  installShellSession,
  onlyStream,
  openShellOutput,
  runningCommand,
  teardownShellSession,
} from "@/components/bots/__tests__/bot-shell-output-modal-support";
import {
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

  it("opens from a running shell row on the bound host with the bot, the viewed session and the command, and reads Loading until the first snapshot", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );

    expect(transportOpens.length).toBeGreaterThan(0);
    expect(transportOpens.every((id) => id === BOUND_HOST)).toBe(true);
    expectEverySubscribeIs(COMMAND_ID);
    expect(within(dialog()).getByText("Shell output")).toBeTruthy();
    expect(within(dialog()).getByText(/Loading output/)).toBeTruthy();
  });

  it("shows the lines live once the snapshot and the live word have both arrived, with no lifecycle or input control", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();

    emitSnapshot(
      stream,
      ["listening on 3000", "ready"],
      runningCommand(COMMAND_ID),
    );
    emitLiveness(stream, "live");

    expect(within(dialog()).getByText(/listening on 3000/)).toBeTruthy();
    expect(
      within(dialog()).queryByTestId("bot-shell-output-not-live"),
    ).toBeNull();
    expect(
      within(dialog()).queryByTestId("bot-shell-output-unavailable"),
    ).toBeNull();
    // The output itself is a read-only region; nothing in the window takes input.
    for (const box of within(dialog()).queryAllByRole("textbox")) {
      expect(box.getAttribute("aria-readonly")).toBe("true");
    }
    expect(
      within(dialog()).queryByRole("button", {
        name: /stop|restart|delete|start|send|run|deliver/i,
      }),
    ).toBeNull();
  });

  it("shows the ended status once the shell ends while the window is open", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["building"], runningCommand(COMMAND_ID));
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
    });

    expect(within(dialog()).getByText(/exited|ended|finished/i)).toBeTruthy();
    expect(within(dialog()).getByText(/building/)).toBeTruthy();
  });

  it("keeps the lines and says Not live while the host holds, and again when it resumes", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    emitLiveness(stream, "holding");
    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();

    emitLiveness(stream, "live");
    expect(
      within(dialog()).queryByTestId("bot-shell-output-not-live"),
    ).toBeNull();
  });

  it("keeps the lines and says Not live when the connection drops", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() => stream.emitStatus("reconnecting"));

    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
  });

  it("keeps the lines and says Not live while the bound host is unreachable, though the stream says live", async () => {
    mocks.reachable = false;
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();

    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    expect(
      within(dialog()).getByTestId("bot-shell-output-not-live"),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
  });

  it("clears the lines and reads Output unavailable when the host denies access", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["secret-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() =>
      stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
    );

    expect(within(dialog()).queryByText(/secret-1/)).toBeNull();
    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
  });

  it("keeps the lines but reads Output unavailable when the command is deleted after open", async () => {
    await openShellOutput(
      `managed-command-background-row-${COMMAND_ID}`,
      BOUND_HOST,
    );
    const stream = onlyStream();
    emitSnapshot(stream, ["tail-1"], runningCommand(COMMAND_ID));
    emitLiveness(stream, "live");

    act(() => stream.emit({ kind: "deleted", hasBinaryPayload: false }, null));

    expect(within(dialog()).getByText(/tail-1/)).toBeTruthy();
    expect(
      within(dialog()).getByTestId("bot-shell-output-unavailable"),
    ).toBeTruthy();
  });
});
