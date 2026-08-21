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
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DEFAULT_CODE_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import type { StreamMethodSupportSource } from "@/lib/host/stream-runtime-context";

/**
 * The output window (`UI.md` §4): one interleaved timeline with timestamps,
 * opened at the tail, following live output until the human scrolls away, and
 * replaced by a single terminal notice once the command it watches is gone.
 */

const reachability = vi.hoisted<{ value: string }>(() => ({
  value: "reachable",
}));

// Two hosts, deliberately: the app's DEFAULT host (whichever tab happens to
// be active) and the host THIS tile is bound to, which a tab keeps for life
// and which can be a different machine on a different version. The tile must
// read only the second one.
const defaultHostSupport = vi.hoisted<{ value: StreamMethodSupport }>(() => ({
  value: "supported",
}));

const boundHostSupport = vi.hoisted<{ value: StreamMethodSupport }>(() => ({
  value: "supported",
}));

const virtualizerConfig = vi.hoisted<{ useFlushSync: boolean | null }>(() => ({
  useFlushSync: null,
}));

vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      virtualizerConfig.useFlushSync = options.useFlushSync ?? null;
      return actual.useVirtualizer(options);
    },
  };
});

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: reachability.value,
    hostLabel: "Work laptop",
  }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
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
  // The app-default reader. Every test below exercises the bound-host path
  // instead; a test that read THIS value would prove nothing about the tile,
  // which must never consult it.
  useStreamMethodSupport: () => defaultHostSupport.value,
  // Faithful to the real `useStreamMethodSupportFor`: a null client (no
  // session yet) answers null, otherwise the client's own negotiated support.
  useStreamMethodSupportFor: (
    client: StreamMethodSupportSource | null,
    method: keyof HostStreamRpcRegistry & string,
  ) => (client === null ? null : client.getMethodSupport(method)),
  useStreamMethodSchemaVersion: () => null,
}));

// The socket is the boundary: the stub stream factory below stands in for the
// whole transport, so this opener is never reached.
//
// Hoisted to ONE instance so it is referentially stable across renders, as the
// real hook is — see `lib/registries/__tests__/chat-session-registry.test.ts`.
const refuseDurableTransport = vi.hoisted(() => () => {
  throw new Error("no durable transport in tests");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => refuseDurableTransport,
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
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
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
let restoreLayoutGeometry: () => void;

/**
 * `factoryCalls` lets a Retry test prove a fresh stream was actually opened
 * rather than the old one quietly resuming. `emit` always answers the LATEST
 * callbacks, so a stale reference captured before a retry is never what a
 * later `emit()` call reaches.
 */
function installOutputStub(): {
  readonly emit: () => ManagedCommandOutputStreamCallbacks;
  readonly factoryCalls: () => number;
} {
  let captured: ManagedCommandOutputStreamCallbacks | null = null;
  let calls = 0;
  // The bound host's own negotiated support, read through the handle the
  // factory hands back - never through the app-default mock above.
  const boundStreamMethodSupport: StreamMethodSupportSource = {
    getMethodSupport: () => boundHostSupport.value,
    subscribeMethodSupport: () => () => undefined,
  };
  __setManagedCommandOutputStreamClientFactoryForTests(
    (_epicId, _commandId, callbacks) => {
      calls += 1;
      captured = callbacks;
      return {
        loadOlder: (frame) => {
          sentFrames.push(frame);
        },
        resnapshot: () => {
          sentFrames.push({ kind: "resnapshot", hasBinaryPayload: false });
        },
        close: () => undefined,
        streamMethodSupport: boundStreamMethodSupport,
      };
    },
  );
  return {
    emit: () => {
      if (captured === null) throw new Error("output callbacks not wired");
      return captured;
    },
    factoryCalls: () => calls,
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

/** The viewer's own role on the epic went away, mid-stream. */
const VIEWER_UNAUTHORIZED: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "UNAUTHORIZED: epic access revoked",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/** A close that is about the stream, not the shell - the host's own reader threw. */
const STREAM_FAILED: FatalErrorDetails = {
  code: "MANAGED_COMMAND_OUTPUT_FAILED",
  reason: "MANAGED_COMMAND_OUTPUT_FAILED: log reader crashed",
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
  return screen.getByTestId("managed-command-output-timeline");
}

function rowChannels(): string[] {
  return screen
    .getAllByTestId(/^managed-command-output-line-/)
    .map((node) => node.getAttribute("data-channel") ?? "");
}

beforeEach(() => {
  // TanStack Virtual reads offset geometry synchronously when the scroll
  // element attaches. jsdom's permanent 0x0 default would otherwise describe
  // a genuinely invisible viewport and correctly produce no virtual rows.
  const heightSpy = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 600 : 24;
    });
  const widthSpy = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(800);
  restoreLayoutGeometry = () => {
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  };
  reachability.value = "reachable";
  defaultHostSupport.value = "supported";
  boundHostSupport.value = "supported";
  virtualizerConfig.useFlushSync = null;
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
  restoreLayoutGeometry();
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

  it("mounts only a viewport-sized window for a large output timeline", () => {
    const stub = installOutputStub();
    renderTile();

    openAtTail(
      stub.emit,
      Array.from({ length: 10_000 }, (_, index) =>
        line("stdout", `line-${index}`),
      ),
    );

    const mountedRows = screen.queryAllByTestId(
      /^managed-command-output-line-/,
    );
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(100);
    expect(virtualizerConfig.useFlushSync).toBe(false);
  });

  it("floats live status over the log instead of titling itself", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    // The title bar is gone - the tab beside this window already says
    // "Monitor · deploy watcher", and repeating it cost the log a row.
    expect(screen.queryByTestId("managed-command-output-title")).toBeNull();
    expect(
      screen.getByTestId("managed-command-output-status").textContent,
    ).toBe("Running");

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

  it("answers what is running and where, as CURRENT facts", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    fireEvent.click(screen.getByTestId("managed-command-output-details"));

    // The log spans every run of this shell, so these describe the shell as it
    // stands now rather than whatever produced the lines being read - which is
    // exactly why the transcript's start card freezes its own copy instead.
    expect(
      screen.getByTestId("managed-command-output-details-command").textContent,
    ).toBe("tail -f deploy.log");
    expect(screen.getByText("/work/repo")).toBeTruthy();
    // Only while running: a stale pid points at whatever the OS handed out next.
    expect(screen.getByText("4410")).toBeTruthy();
    // Cadence is one short tagged line, not a sentence.
    expect(
      screen.getByTestId("managed-command-output-details-cadence").textContent,
    ).toBe("On output · 500ms quiet · 15s max wait · 5s min gap");
    // Withheld by decision: which shell binary resolved describes the machine.
    expect(screen.queryByText("/bin/sh")).toBeNull();
  });

  it("drops the pid once the shell is no longer running", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);
    act(() => {
      stub.emit().onStatus({
        ...COMMAND,
        status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 90 },
      });
    });

    fireEvent.click(screen.getByTestId("managed-command-output-details"));
    expect(screen.queryByText("4410")).toBeNull();
  });

  it("replaces the whole window with the terminal notice when the shell is deleted", () => {
    // Every control here would act on a shell that no longer exists - the
    // notice replaces the window instead of merely disabling them in place.
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "last words")]);
    act(() => {
      stub.emit().onDeleted();
    });

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(screen.getByText("This shell was deleted.")).not.toBeNull();
    expect(panel.getAttribute("data-availability")).toBe("gone");
    expect(panel.getAttribute("data-cause")).toBe("deleted");
    expect(screen.queryByTestId("managed-command-output-details")).toBeNull();
    expect(screen.queryByTestId("managed-command-output-status")).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
  });

  it("keeps its chrome off the log's flow, and reserves a lane for it", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    const status = screen.getByTestId("managed-command-output-status");
    const view = timeline();
    // Floating, not a bar: the cluster is lifted out of the column the log
    // occupies, so the log starts at the top of the pane.
    const floating = status.closest(".absolute");
    expect(floating).not.toBeNull();
    expect(floating?.contains(view)).toBe(false);
    // Status is a readout, never a control - the verbs beside it are.
    expect(status.querySelector("button")).toBeNull();
    expect(
      screen.getByTestId(`managed-command-stop-${COMMAND.id}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-delete-${COMMAND.id}`),
    ).toBeTruthy();
    // And the log holds a lane clear on the right, or the cluster would sit on
    // the tail of whichever line scrolled under it - permanently. Fluid and
    // capped: a fixed lane would take a third of a narrow pane away from the
    // log, and on a wide one it must never grow past what the cluster needs.
    expect(view.getAttribute("class")).toContain("pr-[min(30%,12rem)]");
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

  it("owns Home and End as retained-start and live-tail navigation", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "held history")]);

    const view = timeline();
    setScrollGeometry(view, {
      scrollTop: 1_000,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    view.focus();

    expect(view.tabIndex).toBe(0);
    expect(document.activeElement).toBe(view);
    expect(fireEvent.keyDown(view, { key: "Home" })).toBe(false);
    expect(view.scrollTop).toBe(0);
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].kind).toBe("loadOlder");

    act(() => {
      stub.emit().onOutput({
        lines: [line("stdout", "arrived while paused")],
        start: { segmentId: "seg-live", byteOffset: 80 },
      });
    });

    expect(fireEvent.keyDown(view, { key: "End" })).toBe(false);
    expect(view.scrollTop).toBe(4_000);
    expect(sentFrames).toContainEqual({
      kind: "resnapshot",
      hasBinaryPayload: false,
    });
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

  it("includes a changed history-marker prefix when a terminal page also evicts the tail", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "tail-1"), line("stdout", "tail-2")]);

    const view = timeline();
    setScrollGeometry(view, {
      scrollTop: 10,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    const list = screen.getByTestId("managed-command-output-virtual-list");
    let listOffsetTop = 16;
    Object.defineProperty(list, "offsetTop", {
      configurable: true,
      get: () => listOffsetTop,
    });

    // Thirty-nine valid pages leave the quiet command just below the cap.
    // The fortieth both crosses it (evicting the stale tail) and declares the
    // retained start, replacing the loading prefix with the terminal marker.
    for (let page = 0; page < 40; page += 1) {
      view.scrollTop = 10;
      fireEvent.scroll(view);
      const request = sentFrames.at(-1);
      if (request?.kind !== "loadOlder") {
        throw new Error("expected loadOlder");
      }
      const finalPage = page === 39;
      // Exaggerated deliberately: TanStack adapts its unmeasured-row estimate
      // from measured rows, so a distinctive prefix delta isolates the term
      // this regression owns without coupling to virtualizer internals.
      if (finalPage) listOffsetTop = 100_016;
      act(() => {
        stub.emit().onOlder({
          requestId: request.requestId,
          lines: Array.from({ length: 500 }, (_, index) =>
            line("stdout", `older-${page}-${index}`),
          ),
          start: { segmentId: `seg-history-${page}`, byteOffset: 0 },
          reachedStart: finalPage,
        });
      });
    }

    expect(view.scrollTop).toBeGreaterThan(100_000);
    expect(screen.getByText("Start of the retained log")).not.toBeNull();
    expect(screen.queryByText("tail-1")).toBeNull();
  });

  it("pauses live output while reading history and resnapshots on return to live", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "held history")]);

    const view = timeline();
    setScrollGeometry(view, {
      scrollTop: 1_000,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.scroll(view);

    act(() => {
      stub.emit().onOutput({
        lines: [line("stdout", "arrived while paused")],
        start: { segmentId: "seg-live", byteOffset: 80 },
      });
    });

    expect(screen.getByText("held history")).not.toBeNull();
    expect(screen.queryByText("arrived while paused")).toBeNull();
    expect(
      screen.getByTestId("managed-command-output-jump-live").textContent,
    ).toContain("New output available");

    fireEvent.click(screen.getByTestId("managed-command-output-jump-live"));

    expect(sentFrames).toContainEqual({
      kind: "resnapshot",
      hasBinaryPayload: false,
    });
    expect(
      screen.getByTestId("managed-command-output-jump-live").textContent,
    ).toContain("Loading live output");

    openAtTail(stub.emit, [line("stdout", "arrived while paused")]);

    expect(screen.getByText("arrived while paused")).not.toBeNull();
    expect(screen.queryByText("held history")).toBeNull();
    expect(screen.queryByTestId("managed-command-output-jump-live")).toBeNull();
    expect(view.scrollTop).toBe(4_000);
  });

  it("drops the cached scrollback with the shell", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "last words")]);

    act(() => {
      stub.emit().onDeleted();
    });

    // Whatever this window had read is not the history any more - the host
    // just destroyed that, and a ghost of it would contradict the deleted-
    // shell model everywhere else.
    expect(screen.queryByText("last words")).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("closes its own tab from the terminal notice", () => {
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

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText("This shell is no longer on this host."),
    ).not.toBeNull();
    expect(panel.getAttribute("data-cause")).toBe("not-found");
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("flags a lost host instead of leaving a frozen timeline looking live", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    act(() => {
      stub.emit().onConnectionStatus("reconnecting", null);
    });

    const banner = screen.getByTestId("managed-command-output-availability");
    expect(banner.getAttribute("data-availability")).toBe("stale");
    expect(screen.getByText("Reconnecting…")).not.toBeNull();
    // The lines already read stay readable while the socket is down, and the
    // shell's own controls stay in reach - a broken transport is not a claim
    // about the shell.
    expect(screen.getByText("watching src/")).not.toBeNull();
    expect(
      screen.getByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).not.toBeNull();
  });

  it("reads as too old on a host that does not serve the stream", () => {
    boundHostSupport.value = "unsupported";
    installOutputStub();
    renderTile();

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText("This host is too old to show shells."),
    ).not.toBeNull();
    expect(panel.getAttribute("data-availability")).toBe("unsupported-host");
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("covers the window when its host is unreachable", () => {
    reachability.value = "unreachable";
    installOutputStub();
    renderTile();

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText(
        'Host "Work laptop" is unreachable, so this output cannot be read. The shell and its log are kept on that host.',
      ),
    ).not.toBeNull();
    expect(panel.getAttribute("data-availability")).toBe("unreachable-host");
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
  });

  it("reads the bound host's capability, never the app's default host", () => {
    // The app default claims full support; only the BOUND host - the one
    // this tab is actually pinned to - says otherwise, and that is the
    // reading that must win.
    defaultHostSupport.value = "supported";
    boundHostSupport.value = "unsupported";
    installOutputStub();
    renderTile();

    expect(
      screen.getByText("This host is too old to show shells."),
    ).not.toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("does not blame a capable bound host for the app default's own gap", () => {
    defaultHostSupport.value = "unsupported";
    boundHostSupport.value = "supported";
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    expect(screen.getByText("watching src/")).not.toBeNull();
    expect(
      screen.queryByText("This host is too old to show shells."),
    ).toBeNull();
  });

  it("reads a mid-stream UNAUTHORIZED close as an access loss, dropping the cache", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")]);

    act(() => {
      stub.emit().onConnectionStatus("closed", {
        kind: "fatalError",
        details: VIEWER_UNAUTHORIZED,
      });
    });

    expect(
      screen.getByText("You no longer have access to this epic's shells."),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByText("watching src/")).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("keeps the shell's own status and controls under a stream failure, and Retry opens a fresh stream", () => {
    const stub = installOutputStub();
    renderTile();
    openAtTail(stub.emit, [line("stdout", "before the failure")]);

    act(() => {
      stub.emit().onConnectionStatus("closed", {
        kind: "fatalError",
        details: STREAM_FAILED,
      });
    });

    const banner = screen.getByTestId("managed-command-output-availability");
    expect(banner.getAttribute("data-availability")).toBe("stream-error");
    expect(banner.textContent).toContain("The output stream failed.");
    expect(
      screen.getByTestId("managed-command-output-availability-reason")
        .textContent,
    ).toBe(STREAM_FAILED.reason);
    // A stream failure is about the stream, not the shell: its history and
    // controls stay in reach.
    expect(screen.getByText("before the failure")).not.toBeNull();
    expect(
      screen.getByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).not.toBeNull();
    expect(screen.getByTestId("managed-command-output-status")).not.toBeNull();
    expect(stub.factoryCalls()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Retry tears the old store down and opens a brand new stream - not a
    // reconnect on the one that just failed.
    expect(stub.factoryCalls()).toBe(2);
    // The fresh stream has no snapshot yet, so the window is back to its
    // centred connecting panel - not a banner over the failed stream's lines,
    // which are gone with it.
    const reopened = screen.getByTestId("managed-command-output-availability");
    expect(reopened.getAttribute("data-availability")).toBe("bootstrapping");
    expect(reopened.getAttribute("data-phase")).toBe("connecting");
    expect(screen.queryByText("before the failure")).toBeNull();

    openAtTail(stub.emit, [line("stdout", "after the retry")]);

    expect(screen.getByText("after the retry")).not.toBeNull();
    expect(screen.queryByText("before the failure")).toBeNull();
  });

  it("stays a centred 'Connecting…' panel until the opening snapshot lands, whatever the transport reports", () => {
    const stub = installOutputStub();
    renderTile();

    // A full panel, not a strip along the top of an empty log: there is
    // nothing to keep in view yet, and a top strip reads as chrome.
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.getByText("Connecting…")).not.toBeNull();
    // The panel announces itself: queried by its live-region role, not by a
    // test hook. (`status` is not a name-from-content role, so the visible
    // copy is asserted separately rather than as an accessible name.)
    const connecting = screen.getByRole("status");
    expect(connecting.getAttribute("data-availability")).toBe("bootstrapping");
    expect(connecting.getAttribute("data-phase")).toBe("connecting");

    // The socket declaring itself open is not the snapshot landing - the host
    // only serves the tail after its first log read.
    act(() => {
      stub.emit().onConnectionStatus("open", null);
    });
    expect(screen.getByText("Connecting…")).not.toBeNull();
    expect(screen.queryByRole("log")).toBeNull();

    openAtTail(stub.emit, []);

    expect(screen.queryByText("Connecting…")).toBeNull();
    const notice = screen.getByTestId("managed-command-output-availability");
    expect(notice.getAttribute("data-availability")).toBe("empty");
    expect(notice.textContent).toBe("No output yet.");
    expect(timeline().contains(notice)).toBe(true);
    expect(screen.getByTestId("managed-command-output-status")).not.toBeNull();
  });

  it("names the host-directory wait by phase, with no way to close it", () => {
    reachability.value = "checking";
    installOutputStub();
    renderTile();

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(screen.getByText("Checking host…")).not.toBeNull();
    expect(panel.getAttribute("data-availability")).toBe("bootstrapping");
    expect(panel.getAttribute("data-phase")).toBe("checking-host");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });

  it("names the host-process wait the same way the chat's own banner does", () => {
    reachability.value = "host-starting";
    installOutputStub();
    renderTile();

    expect(screen.getByText("Waiting for the host to start…")).not.toBeNull();
  });

  it("clears the loading-older spinner and stops paging when the stream fails mid-page", () => {
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

    expect(sentFrames).toHaveLength(1);
    expect(
      screen.getByTestId("managed-command-output-loading-older"),
    ).not.toBeNull();

    act(() => {
      stub.emit().onConnectionStatus("closed", {
        kind: "fatalError",
        details: STREAM_FAILED,
      });
    });

    expect(
      screen.queryByTestId("managed-command-output-loading-older"),
    ).toBeNull();

    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 4_000,
      clientHeight: 400,
    });
    fireEvent.scroll(view);
    expect(sentFrames).toHaveLength(1);
  });

  // S5's property - `checking` and `host-starting` render a WORDED,
  // phase-named, bounded wait rather than a bare endless spinner - is owned
  // by the availability notice since the #1149 merge, and is pinned above by
  // "names the host-directory wait by phase" / "names the host-process wait
  // the same way the chat's own banner does". `TileHostLoadState` covers the
  // reachable host's LOAD window (the cases earlier in this file), below the
  // availability gate.
});
