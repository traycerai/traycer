import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  managedCommandSubscribeOutputServerFrameSchema,
  type ManagedCommandLogLine,
  type ManagedCommandSubscribeOutputClientFrame,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DEFAULT_CODE_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";

/**
 * The output window (`UI.md` §4): one interleaved timeline with timestamps,
 * opened at the tail, following live output until the human scrolls away, and
 * still readable after the command it watches is deleted.
 */

const reachability = vi.hoisted<{ value: string }>(() => ({
  value: "reachable",
}));

const streamSupport = vi.hoisted<{ value: string }>(() => ({
  value: "supported",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: reachability.value,
    hostLabel: "Work laptop",
  }),
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => streamSupport.value,
  useStreamMethodSchemaVersion: () => null,
}));

// The socket is the boundary: the stub stream factory below stands in for the
// whole transport, so this opener is never reached.
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => {
    throw new Error("no durable transport in tests");
  },
}));

import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { __setManagedCommandOutputStreamClientFactoryForTests } from "@/providers/managed-command-output-stream-factory-override";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { ManagedCommandOutputTile } from "../managed-command-output-tile";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const COMMAND_ID = "cmd-1";

const COMMAND: ManagedCommand = {
  id: COMMAND_ID,
  notifying: true,
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

// 2024-01-01T09:30:05Z, rendered in the viewer's own locale/zone.
const AT_MS = Date.UTC(2024, 0, 1, 9, 30, 5);

function line(
  channel: ManagedCommandLogLine["channel"],
  text: string,
): ManagedCommandLogLine {
  return { channel, text, atMs: AT_MS };
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;
let sentFrames: ManagedCommandSubscribeOutputClientFrame[];

function installOutputStub(): {
  emit: () => ManagedCommandOutputStreamCallbacks;
} {
  let captured: ManagedCommandOutputStreamCallbacks | null = null;
  __setManagedCommandOutputStreamClientFactoryForTests(
    (_epicId, _commandId, callbacks) => {
      captured = callbacks;
      return {
        loadOlder: (frame) => {
          sentFrames.push(frame);
        },
        close: () => undefined,
      };
    },
  );
  return {
    emit: () => {
      if (captured === null) throw new Error("output callbacks not wired");
      return captured;
    },
  };
}

function renderTile(): { readonly instanceId: string } {
  const node = makeManagedCommandOutputTileRef({
    commandId: COMMAND_ID,
    hostId: "host-1",
  });
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);
  // `tileId` is the pane the canvas mounted the tile into - the same id its
  // own Close action has to name.
  const opened = findOpenArtifactInTab(TAB_ID, COMMAND_ID);
  if (opened === null) throw new Error("tile did not open");
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>
        <ManagedCommandOutputTile
          node={node}
          viewTabId={TAB_ID}
          tileId={opened.paneId}
          epicId={EPIC_ID}
        />
      </TooltipProvider>
    </EpicSessionContext.Provider>,
  );
  return { instanceId: node.instanceId };
}

/**
 * The opening snapshot, authored through the wire schema so a fixture that
 * could never come off the socket fails here rather than passing quietly.
 */
function snapshotFrame(lines: readonly ManagedCommandLogLine[]) {
  const frame = managedCommandSubscribeOutputServerFrameSchema.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    command: COMMAND,
    lines,
    start: { segmentId: "seg-2", byteOffset: 40 },
    reachedStart: false,
  });
  if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
  return frame;
}

function openAtTail(
  emit: () => ManagedCommandOutputStreamCallbacks,
  lines: readonly ManagedCommandLogLine[],
): void {
  const frame = snapshotFrame(lines);
  act(() => {
    emit().onSnapshot({
      command: frame.command,
      lines: frame.lines,
      start: frame.start,
      reachedStart: frame.reachedStart,
    });
  });
}

/** How the host refuses a command it no longer has (`NOT_FOUND` verbatim). */
const COMMAND_GONE: FatalErrorDetails = {
  code: "MANAGED_COMMAND_NOT_FOUND",
  reason: "MANAGED_COMMAND_NOT_FOUND: no such managed command in this epic",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/**
 * jsdom has no layout, so the scroll geometry a follow-mode decision reads has
 * to be stated outright. `scrollHeight` is installed as a getter over a box the
 * test owns, because prepend compensation is only meaningful when the document
 * can actually grow between two reads.
 */
function setScrollGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): { setScrollHeight: (value: number) => void } {
  const box = { scrollHeight: geometry.scrollHeight };
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => box.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  element.scrollTop = geometry.scrollTop;
  return {
    setScrollHeight: (value: number) => {
      box.scrollHeight = value;
    },
  };
}

function timeline(): HTMLElement {
  return screen.getByRole("log");
}

function rowChannels(): string[] {
  return screen
    .getAllByTestId(/^managed-command-output-line-/)
    .map((node) => node.getAttribute("data-channel") ?? "");
}

beforeEach(() => {
  reachability.value = "reachable";
  streamSupport.value = "supported";
  sentFrames = [];
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
});

afterEach(() => {
  cleanup();
  __setManagedCommandOutputStreamClientFactoryForTests(null);
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSettingsStore.setState({
    terminalFontFamily: null,
    terminalFontSize: null,
    codeFontFamily: null,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
  });
});

describe("managed-command output window", () => {
  it("follows the Terminal font settings, not the Code font it falls back to", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    // Unset means "follow the Code font", which is what the fallback stack is
    // for - and the size utility classes must not be carrying it instead.
    expect(timeline().style.fontSize).toBe(`${DEFAULT_CODE_FONT_SIZE}px`);
    expect(timeline().className).not.toContain("font-mono");

    act(() => {
      useSettingsStore.setState({
        terminalFontFamily: "Iosevka",
        terminalFontSize: 17,
      });
    });

    expect(timeline().style.fontSize).toBe("17px");
    expect(timeline().style.fontFamily).toContain("Iosevka");
  });

  it("interleaves output and lifecycle records in one timestamped timeline", () => {
    const stub = installOutputStub();
    renderTile();

    openAtTail(stub.emit, [
      line("lifecycle", "started (pid 4410)"),
      line("stdout", "watching src/"),
      line("stderr", "warning: slow build"),
    ]);

    // Order is the log's own; the channel rides on the row so stderr can be
    // tinted and a lifecycle record can be set apart without re-parsing text.
    expect(rowChannels()).toEqual(["lifecycle", "stdout", "stderr"]);
    expect(screen.getByText("warning: slow build")).not.toBeNull();
    // Timestamps are on by default (§4) and carry seconds - a 3am restart is
    // matched against other logs by time of day, not by minute. Asserted by
    // shape rather than by a literal, which would move with the runner's
    // locale and time zone.
    expect(
      screen.getAllByTestId(/^managed-command-output-time-/)[0].textContent,
    ).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("names the kind and the live status in its header", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    expect(screen.getByTestId("managed-command-output-title").textContent).toBe(
      "Shell · deploy watcher",
    );

    act(() => {
      stub.emit().onStatus({
        ...COMMAND,
        status: { state: "exited", exitCode: 1, signal: null, exitedAtMs: 90 },
      });
    });

    expect(
      screen.getByTestId("managed-command-output-status").textContent,
    ).toBe("Exited · code 1");
  });

  it("follows new output until the human scrolls up, then offers a way back", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "first")]);

    expect(screen.queryByTestId("managed-command-output-jump-live")).toBeNull();

    const view = timeline();
    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.scroll(view);

    expect(
      screen.getByTestId("managed-command-output-jump-live"),
    ).not.toBeNull();

    setScrollGeometry(view, {
      scrollTop: 3_600,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.click(screen.getByTestId("managed-command-output-jump-live"));
    fireEvent.scroll(view);

    expect(screen.queryByTestId("managed-command-output-jump-live")).toBeNull();
  });

  it("asks for older lines when the viewer reaches the top", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "first")]);

    const view = timeline();
    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.scroll(view);

    // The position the host handed over with the snapshot, returned verbatim.
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].kind).toBe("loadOlder");
    expect(
      sentFrames[0].kind === "loadOlder" ? sentFrames[0].before : null,
    ).toEqual({ segmentId: "seg-2", byteOffset: 40 });
  });

  it("holds the reading position when a page of older lines is prepended", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "tail")]);

    const view = timeline();
    const geometry = setScrollGeometry(view, {
      scrollTop: 10,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.scroll(view);
    const request = sentFrames[0];
    if (request.kind !== "loadOlder") throw new Error("expected loadOlder");

    // The page lands and the document grows by 5,000px ABOVE the viewport.
    geometry.setScrollHeight(9_000);
    act(() => {
      stub.emit().onOlder({
        requestId: request.requestId,
        lines: [line("stdout", "older-1"), line("stdout", "older-2")],
        start: { segmentId: "seg-1", byteOffset: 0 },
        reachedStart: false,
      });
    });

    // Without compensation the viewport stays at 10 and the line the human was
    // reading is 5,000px below - the whole point of scrolling up is lost.
    // Chromium's native scroll anchoring cannot save this: the spec disables it
    // at the very top, which is exactly where a load-older fires.
    expect(view.scrollTop).toBe(5_010);
  });

  it("keeps the scrollback readable after the command is deleted", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "last words")]);

    act(() => {
      stub.emit().onDeleted();
    });

    expect(screen.getByTestId("managed-command-output-deleted")).not.toBeNull();
    expect(screen.getByText("last words")).not.toBeNull();
  });

  it("closes its own tab from the dead-state banner", () => {
    const stub = installOutputStub();
    const { instanceId } = renderTile();
    openAtTail(stub.emit, [line("stdout", "last words")]);
    act(() => {
      stub.emit().onDeleted();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));

    expect(
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId[
        instanceId
      ],
    ).toBeUndefined();
    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).toBeNull();
  });

  it("explains itself when restored for a command the host no longer has", () => {
    const stub = installOutputStub();
    renderTile();

    // No snapshot ever arrives: the host refused the open. Without this the
    // window sits blank forever, titled "Output", with nothing to read.
    act(() => {
      stub.emit().onConnectionStatus("closed", {
        kind: "fatalError",
        details: COMMAND_GONE,
      });
    });

    expect(screen.getByTestId("managed-command-output-deleted")).not.toBeNull();
  });

  it("flags a lost host instead of leaving a frozen timeline looking live", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    act(() => {
      stub.emit().onConnectionStatus("reconnecting", null);
    });

    expect(
      screen.getByTestId("managed-command-output-disconnected"),
    ).not.toBeNull();
    // The lines already read stay readable while the socket is down.
    expect(screen.getByText("watching src/")).not.toBeNull();
  });

  it("reads as unavailable on a host that does not serve the stream", () => {
    streamSupport.value = "unsupported";
    installOutputStub();
    renderTile();

    expect(
      screen.getByTestId("managed-command-output-unavailable"),
    ).not.toBeNull();
  });

  it("covers the window when its host is unreachable", () => {
    reachability.value = "unreachable";
    installOutputStub();
    renderTile();

    expect(
      screen.getByTestId("managed-command-output-unreachable"),
    ).not.toBeNull();
  });
});
