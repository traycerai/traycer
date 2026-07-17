import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import {
  SearchAddon,
  type ISearchResultChangeEvent,
} from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import {
  isPlainBoundaryKey,
  isPlatformModifiedBoundaryKey,
} from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import { translateLineEditChord } from "@/lib/terminal-line-edit";
import {
  useSettingsStore,
  inactiveCursorStyleFor,
  type TerminalCursorStyle,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_MONO_FONT_STACK,
  buildFontFamilyValue,
} from "@/lib/default-font-stacks";
import { useRunnerHost } from "@/providers/use-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { cn } from "@/lib/utils";
import { useTerminalTheme } from "@/lib/terminal-theme";
import { scheduleAtlasClear } from "@/lib/terminal-theme-scheduler";
import type { TerminalDataWriter } from "@/stores/terminals/terminal-session-store";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import { registerActiveTerminalFindController } from "@/stores/find-in-page/terminal-find-store";
import {
  useActivePaneEffect,
  useVisiblePaneValue,
} from "@/components/epic-tabs/pane-visibility-context";
import { markTerminalLoad } from "@/lib/perf/terminal-load-perf";
import {
  acquireXtermHost,
  releaseXtermHost,
  type XtermHostControls,
  type XtermHostEntry,
  type XtermHostLiveCallbacks,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import {
  createTerminalTileFindAdapter,
  runTerminalXtermSearch,
  type TerminalSearchResultSource,
  type TerminalTileFindAdapter,
  type TerminalTileFindKind,
} from "@/components/epic-canvas/renderers/terminal-tile-find-adapter";

const RESIZE_DEBOUNCE_MS = 50;
const XTERM_STARTUP_DISPOSE_DELAY_MS = 0;
// Below this (px, both axes) the container is mid-relayout - a collapsed flex
// height on window restore, a hidden pane, or a box detached mid-reattach -
// rather than a real terminal surface. Measuring it yields xterm's floored 2x1
// grid, which must never reach the host's shared min-size grid. No usable
// terminal pane is this small, so the floor only ever rejects degenerate boxes.
const MIN_FIT_CONTAINER_PX = 48;

interface XtermInitialOptions extends ITerminalOptions {
  readonly vtExtensions: {
    readonly kittyKeyboard: boolean;
  };
}

const TERMINAL_PATH_ESCAPE_PATTERN = /([\\\s!"#$&'()*;<>?[\]^`{|}])/g;
const getEmptyFindTargetId = (): string | null => null;
const ignoreSearchResults = (): void => {};

// xterm measures glyph cell width on a hidden canvas using the configured
// `fontFamily`, so CSS variables (which don't resolve in that measurement
// pass) are not usable here. Instead the effective terminal font is built
// directly from settings-store values against the same default mono stack
// `theme-provider.tsx` uses for `--traycer-font-mono` - `letterSpacing` /
// `lineHeight` are pinned on the constructed Terminal so paint and
// measurement agree.
function resolveEffectiveFontFamily(
  terminalFontFamily: string | null,
  codeFontFamily: string | null,
): string {
  return buildFontFamilyValue(
    terminalFontFamily ?? codeFontFamily,
    DEFAULT_MONO_FONT_STACK,
  );
}

export interface TerminalXtermHostProps {
  /**
   * Session id this host renders, used to key first-load perf marks
   * (`xterm-open`, `writer-ready`, `first-render`) to the same timeline the
   * tile and session store report into.
   */
  readonly sessionId: string;
  readonly tileKind: TerminalTileFindKind;
  /**
   * Per-tab instance id this host's persistent xterm engine is cached under in
   * `xterm-host-registry`. Keying by `instanceId` (not `sessionId`) lets two
   * tab instances of the same session each own their own `Terminal` + container
   * and render live side by side.
   */
  readonly instanceId: string;
  /**
   * Effective grid size as decided by the host (`min(cols)` across attached
   * clients). The host calls `term.resize(cols, rows)` when this changes so
   * every viewer of the same session shows identical glyph dimensions.
   */
  readonly effectiveCols: number;
  readonly effectiveRows: number;
  /** Receives keystrokes and pasted text from the user. */
  readonly onUserInput: (data: string) => void;
  /**
   * Reports the container's "natural" cols/rows whenever it resizes; the
   * caller forwards this to `requestResize` on the store.
   */
  readonly onContainerResize: (cols: number, rows: number) => void;
  /**
   * Registers a `term.write` proxy so the parent can stream host frames
   * (snapshot + data) into the terminal. The host re-registers on every mount
   * (reattaching the persistent engine), and never clears it on unmount - the
   * session store nulls the writer in its own `dispose`, so host output that
   * arrives during a split/reparent gap still lands in the live buffer.
   */
  readonly onWriterReady: (writer: TerminalDataWriter | null) => void;
  /**
   * Focuses xterm when the surrounding retained pane becomes visible. The
   * caller passes the tile-level active state so split layouts don't race every
   * mounted terminal for focus.
   */
  readonly shouldFocusOnActivePane: boolean;
  /**
   * Whether the underlying terminal session is still live. The host keeps the
   * persistent xterm engine cached across unmount when true, so splitting a
   * pane / switching tabs / reopening does not dispose the `Terminal` and lose
   * its scrollback. Mirrors the lease-free retention rules in
   * `TerminalSessionRegistry`: a running terminal-agent's handle is kept warm
   * indefinitely and a running plain terminal's lingers for the release-linger
   * window, and in both cases the session store's writer keeps pointing at
   * this engine - so the engine must outlive the unmount with it, or the
   * reattach would render blank (the host snapshot was already consumed).
   * Exited sessions pass false: their handle is torn down with the tile, and
   * the registry follower disposes any cached engine once the handle leaves
   * the session registry.
   */
  readonly keepAlive: boolean;
  /**
   * Non-null while this terminal tile owns the app-level find bar. The xterm
   * search addon is terminal-local, so the active tile registers itself as
   * the current terminal search target instead of making the page finder scan
   * xterm's rendered DOM.
   */
  readonly findTargetId: string | null;
  /**
   * How the xterm viewport meets its container. `"padded"` insets the grid
   * from the tile's edges - the canvas tiles sit on a card, so the gutter reads
   * as tile chrome. `"flush"` gives the grid the full box; the landing panel
   * IS the terminal's frame, so an inset there just leaks panel background
   * around a rectangle of terminal background.
   */
  readonly chrome: "padded" | "flush";
}

export function TerminalXtermHost(props: TerminalXtermHostProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const canvasRef = useRef<CanvasAddon | null>(null);
  const controlsRef = useRef<XtermHostControls | null>(null);
  const findTargetIdRef = useRef(props.findTargetId);
  const terminalSearchResultSourceRef =
    useRef<TerminalSearchResultSource | null>(null);
  const dragDepthRef = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  // Stable for the host's lifetime; held in a ref so the acquire effect can tag
  // its perf marks and key the registry without taking `props.sessionId` /
  // `props.instanceId` as dependencies. `sessionId` tags perf marks and builds
  // the engine; `instanceId` is the registry cache key.
  const sessionIdRef = useRef(props.sessionId);
  const instanceIdRef = useRef(props.instanceId);

  // Theme + font tokens are read synchronously during render so the first call
  // to `new Terminal({ theme })` paints the correct palette - no flash of
  // default xterm colors. The engine factory captures these values through
  // `initialOptionsRef.current` so a parent re-render mid-mount can't change the
  // constructor inputs; subsequent updates flow through dedicated reactive
  // effects below. These initial options apply on first create only - a
  // reattached engine keeps its already-synced options.
  const theme = useTerminalTheme();
  const codeFontSize = useSettingsStore((s) => s.codeFontSize);
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const codeFontFamily = useSettingsStore((s) => s.codeFontFamily);
  const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const cursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const cursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const effectiveFontSize = terminalFontSize ?? codeFontSize;
  const fontFamily = resolveEffectiveFontFamily(
    terminalFontFamily,
    codeFontFamily,
  );
  const runnerHost = useRunnerHost();
  // Inactive panes unregister global find ownership. They stay mounted, but
  // app-level find should only target the visible terminal.
  const activeFindTargetId = useVisiblePaneValue(props.findTargetId, null);
  const markSearchResultSource = useCallback(
    (source: TerminalSearchResultSource): void => {
      terminalSearchResultSourceRef.current = source;
    },
    [],
  );
  const tileFindAdapter = useMemo(
    () =>
      createTerminalTileFindAdapter({
        tileInstanceId: props.instanceId,
        tileKind: props.tileKind,
      }),
    [props.instanceId, props.tileKind],
  );
  const tileFindAdapterRef = useRef<TerminalTileFindAdapter>(tileFindAdapter);
  useEffect(() => {
    tileFindAdapterRef.current = tileFindAdapter;
  }, [tileFindAdapter]);
  useEffect(() => {
    tileFindAdapter.setSearchAddon(searchAddonRef.current);
    tileFindAdapter.setSearchResultSourceSink(markSearchResultSource);
    return () => {
      tileFindAdapter.setSearchAddon(null);
      tileFindAdapter.setSearchResultSourceSink(null);
    };
  }, [markSearchResultSource, tileFindAdapter]);
  useRegisterTileFindAdapter(tileFindAdapter);

  const initialOptionsRef = useRef<XtermInitialOptions>({
    cursorStyle,
    cursorInactiveStyle: inactiveCursorStyleFor(cursorStyle),
    cursorBlink,
    allowProposedApi: true,
    scrollback: 5000,
    fontFamily,
    fontSize: effectiveFontSize,
    letterSpacing: 0,
    lineHeight: 1,
    theme,
    // Programs emit arbitrary/binary bytes; xterm's VT parser logs (and
    // recovers from) every malformed sequence. Under a high-rate binary stream
    // that flood of `console.error`s is itself the bottleneck - in Electron each
    // log is IPC'd renderer->main, saturating the renderer thread until it can no
    // longer answer WebSocket pings and the host's pong watchdog kills the
    // stream. Silence the parser; the errors are non-actionable (the byte stream
    // is the program's doing and xterm recovers).
    logLevel: "off",
    // Kitty keyboard protocol lets TUIs distinguish Shift+Enter from Enter (and
    // encode other modifier chords) instead of collapsing both to `\r`. This is
    // what makes Shift+Enter a newline inside chat/agent TUIs. The encoder only
    // activates once the running program opts into kitty mode, so a plain shell
    // prompt is unaffected.
    vtExtensions: { kittyKeyboard: true },
    // Keep Mac Option as the native character composer (Option+2 = @, dead-key
    // accents). Option+Arrow word-jump is handled explicitly in
    // `translateLineEditChord`, so we don't need Option-as-Meta here.
    macOptionIsMeta: false,
  });

  // Keep the latest callbacks / keep-alive flag in refs so the persistent
  // engine (which outlives this React instance across splits and reopens)
  // always reaches the current host's wiring, and the unmount cleanup reads the
  // latest keep-alive value. Refs are updated in a layout effect so the lint
  // rule forbidding ref writes during render is satisfied.
  const onUserInputRef = useRef(props.onUserInput);
  const onContainerResizeRef = useRef(props.onContainerResize);
  const onWriterReadyRef = useRef(props.onWriterReady);
  const runnerHostRef = useRef(runnerHost);
  const keepAliveRef = useRef(props.keepAlive);
  useEffect(() => {
    onUserInputRef.current = props.onUserInput;
    onContainerResizeRef.current = props.onContainerResize;
    onWriterReadyRef.current = props.onWriterReady;
    runnerHostRef.current = runnerHost;
    findTargetIdRef.current = activeFindTargetId;
    keepAliveRef.current = props.keepAlive;
  }, [
    props.onUserInput,
    props.onContainerResize,
    props.onWriterReady,
    props.keepAlive,
    activeFindTargetId,
    runnerHost,
  ]);

  // Acquire the persistent xterm engine for this session and attach its
  // container into the live mount point. The engine - `Terminal`, addons, and
  // the container it was `open()`-ed into - lives in `xterm-host-registry` keyed
  // by session id, so a pane split / tab switch / reopen reattaches the SAME
  // instance (scrollback + cursor intact) instead of disposing and recreating
  // it. A layout effect (not passive) so the reattach lands before paint and
  // before the reactive effects below read `termRef`.
  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const sessionId = sessionIdRef.current;
    const instanceId = instanceIdRef.current;
    const entry = acquireXtermHost(instanceId, () =>
      createXtermEntry(sessionId, initialOptionsRef.current),
    );
    // Point the engine's live callbacks at this host's current refs. On a
    // reattach this overwrites the previous host's wiring; the refs themselves
    // stay current via the layout effect above.
    entry.live.onUserInput = (data) => onUserInputRef.current(data);
    entry.live.onContainerResize = (cols, rows) =>
      onContainerResizeRef.current(cols, rows);
    entry.live.openExternalLink = (uri) => {
      void runnerHostRef.current.openExternalLink(uri);
    };
    const getFindTargetId = () => findTargetIdRef.current;
    const onSearchResults = (result: ISearchResultChangeEvent): void => {
      const source = terminalSearchResultSourceRef.current;
      if (source === "tile") {
        tileFindAdapterRef.current.publishResults(result);
      }
      if (source === "legacy" && getFindTargetId() !== null) {
        publishLegacyTerminalSearchResult(result);
      }
    };
    entry.live.getFindTargetId = getFindTargetId;
    entry.live.onSearchResults = onSearchResults;

    termRef.current = entry.term;
    searchAddonRef.current = entry.searchAddon;
    tileFindAdapterRef.current.setSearchAddon(entry.searchAddon);
    canvasRef.current = entry.canvasAddon;
    controlsRef.current = entry.controls;

    mount.appendChild(entry.containerEl);
    // (Re)register the writer with the current session store. Idempotent on a
    // reattach (same proxy, already-drained queue); on a fresh plain-terminal
    // open it triggers the buffered-snapshot flush.
    onWriterReadyRef.current(entry.writerProxy);
    markTerminalLoad(sessionId, "writer-ready");

    return () => {
      if (entry.containerEl.parentElement === mount) {
        mount.removeChild(entry.containerEl);
      }
      termRef.current = null;
      searchAddonRef.current = null;
      tileFindAdapterRef.current.setSearchAddon(null);
      terminalSearchResultSourceRef.current = null;
      if (entry.live.getFindTargetId === getFindTargetId) {
        entry.live.getFindTargetId = getEmptyFindTargetId;
      }
      if (entry.live.onSearchResults === onSearchResults) {
        entry.live.onSearchResults = ignoreSearchResults;
      }
      canvasRef.current = null;
      controlsRef.current = null;
      // Keep the engine cached for a still-live session; dispose it otherwise.
      // Never dispose synchronously on a layout change - that is the
      // blank-on-split bug this registry exists to prevent.
      releaseXtermHost(instanceId, keepAliveRef.current);
    };
  }, []);

  useTerminalFindRegistration(
    activeFindTargetId,
    searchAddonRef,
    markSearchResultSource,
  );
  useTerminalResizeSync(termRef, props.effectiveCols, props.effectiveRows);
  useHostGridReconcile(controlsRef, props.effectiveCols, props.effectiveRows);
  useTerminalAppearanceSync({
    termRef,
    controlsRef,
    canvasRef,
    theme,
    fontSize: effectiveFontSize,
    fontFamily,
    cursorStyle,
    cursorBlink,
  });
  useVisibleTerminalRepair({
    termRef,
    controlsRef,
    canvasRef,
    theme,
  });
  useActiveTerminalFocus(termRef, props.shouldFocusOnActivePane);

  const pastePaths = useCallback((paths: readonly string[]): void => {
    const input = terminalPathInput(uniquePaths(paths));
    if (input.length === 0) return;
    termRef.current?.paste(input);
    termRef.current?.focus();
  }, []);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [setIsDraggingFiles],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    },
    [setIsDraggingFiles],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingFiles(false);
      }
    },
    [setIsDraggingFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      const resolvedPaths = resolveFileTransferPaths(
        event.dataTransfer,
        runnerHost.fileDrops,
      );
      if (resolvedPaths === null) return;
      void resolvedPaths
        .then((paths) => {
          pastePaths(paths);
        })
        .catch(() => undefined);
    },
    [pastePaths, runnerHost.fileDrops, setIsDraggingFiles],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      const resolvedPaths = resolveFileTransferPaths(
        event.clipboardData,
        runnerHost.fileDrops,
      );
      if (resolvedPaths === null) return;
      event.preventDefault();
      event.stopPropagation();
      void resolvedPaths
        .then((paths) => {
          pastePaths(paths);
        })
        .catch(() => undefined);
    },
    [pastePaths, runnerHost.fileDrops],
  );

  // `absolute inset-0` sidesteps the percentage-height chain (`h-full` →
  // `min-h-0 flex-1` parent → flex column ancestor → ...) which fails to
  // resolve at mount in some flex layouts: the inner box collapses to its
  // content, xterm renders at default 80x24, and `fitAddon.proposeDimensions()`
  // - which reads `getComputedStyle(parent).height` - feeds those small
  // dims back to the resize roundtrip. A window resize triggers a full
  // reflow that settles the chain, which is why resizing "fixes" the
  // layout. The host's parent in TerminalLive is `relative`, so anchoring
  // the container with `inset-0` takes the size from the ancestor's box
  // directly and is robust to initial-mount timing.
  //
  // `mountRef` is the imperative attach point for the persistent xterm
  // container (owned by the registry, not React) and carries the file-transfer
  // handlers so it stays the direct parent of `data-testid="terminal-xterm-host"`.
  // Paste uses capture because xterm handles clipboard events on its hidden
  // textarea; file clipboard entries must be claimed before that target handler
  // discards their empty text payload.
  // The drag overlay is a React sibling so React never reconciles around the
  // foreign container node.
  return (
    <div className="absolute inset-0 bg-canvas">
      <div
        ref={mountRef}
        className={cn(
          "h-full w-full",
          props.chrome === "padded" ? "p-2" : "p-0",
        )}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPasteCapture={handlePaste}
      />
      {isDraggingFiles ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-10 flex items-center justify-center border-2 border-dashed border-primary bg-canvas/85 text-ui-sm font-medium text-foreground",
            props.chrome === "padded" ? "inset-2" : "inset-0",
          )}
        >
          Drop files to paste paths
        </div>
      ) : null}
    </div>
  );
}

// RIS ("\x1bc") as raw bytes, for prepending to a `Uint8Array` snapshot chunk
// (`terminal.subscribe@1.2`+) - see `writerProxy`'s reset-before-replay
// comment. ASCII-only, so this is the same 2 bytes either way.
const RESET_ESCAPE_BYTES = new Uint8Array([0x1b, 0x63]);

function prependResetEscape(chunk: string | Uint8Array): string | Uint8Array {
  if (typeof chunk === "string") return `\x1bc${chunk}`;
  const combined = new Uint8Array(RESET_ESCAPE_BYTES.length + chunk.length);
  combined.set(RESET_ESCAPE_BYTES, 0);
  combined.set(chunk, RESET_ESCAPE_BYTES.length);
  return combined;
}

/**
 * Build the long-lived xterm engine for a session: `Terminal` + addons opened
 * into a detached container element that the registry keeps alive across host
 * remounts. All user-facing wiring (input, resize, links, find) reads through
 * the mutable `live` callbacks so a reattached host can repoint them without
 * recreating anything. See `xterm-host-registry`.
 */
function createXtermEntry(
  sessionId: string,
  initialOptions: XtermInitialOptions,
): XtermHostEntry {
  const live: XtermHostLiveCallbacks = {
    onUserInput: () => {},
    onContainerResize: () => {},
    openExternalLink: () => {},
    getFindTargetId: getEmptyFindTargetId,
    onSearchResults: ignoreSearchResults,
  };

  const containerEl = document.createElement("div");
  containerEl.className = "h-full w-full overflow-hidden";
  containerEl.dataset.testid = "terminal-xterm-host";

  const term = new Terminal(initialOptions);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Route every clicked link to the host's external-browser path. Left at its
  // defaults xterm wraps `window.open(uri)` in a confirm dialog, but
  // `window.open` to an external URL is a no-op in the Electron renderer - so
  // the dialog's OK did nothing. `openExternalLink` hands the URL to the OS
  // browser (e.g. the Codex OAuth sign-in link).
  //
  // Two independent link paths both need this. `WebLinksAddon` matches
  // plain-text URLs via regex; `linkHandler` covers OSC 8 escape-sequence
  // hyperlinks through xterm's built-in OscLinkProvider. Codex emits its
  // sign-in URL as an OSC 8 link, so without `linkHandler` it kept hitting
  // OscLinkProvider's dead default confirm dialog even after WebLinksAddon was
  // wired up.
  const openClickedLink = (uri: string): void => {
    live.openExternalLink(uri);
  };
  term.loadAddon(new WebLinksAddon((_event, uri) => openClickedLink(uri)));
  term.options.linkHandler = {
    activate: (_event, uri) => openClickedLink(uri),
  };
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.loadAddon(new ClipboardAddon());

  // Use the CANVAS renderer, not WebGL. WebGL gives one GPU context per
  // terminal, and browsers cap live contexts (~16); opening many terminals
  // exhausts the pool, evicts the oldest context, and triggers a loss/rebind
  // cascade that thrashes the renderer (multi-second first paints, main-thread
  // stalls). The canvas renderer is not subject to the GPU context limit, so
  // any number of terminals coexist with no context loss - and it needs no
  // `onContextLoss` recovery. Its throughput is a hair below WebGL only for
  // pathological full-screen scroll storms, which is not the TUI workload here.
  let canvas: CanvasAddon | null = null;
  try {
    canvas = new CanvasAddon();
    term.loadAddon(canvas);
  } catch {
    // Canvas unavailable (headless / blocked); xterm falls back to its DOM
    // renderer automatically.
    canvas = null;
  }

  term.open(containerEl);
  markTerminalLoad(sessionId, "xterm-open");

  term.attachCustomKeyEventHandler((event) =>
    handleTerminalCustomKeyEvent(term, event),
  );

  let snapshotReplayDepth = 0;
  // True once this kept-alive engine has had ANY output written to it. A second
  // snapshot (transport reconnect / reopen of a kept-alive engine) then arrives
  // for a buffer that already holds pre-disconnect content: see `writerProxy`.
  let hasReceivedContent = false;
  const dataDisposable = term.onData((d) => {
    if (snapshotReplayDepth > 0) return;
    live.onUserInput(d);
  });
  const searchResultsDisposable = searchAddon.onDidChangeResults((result) => {
    live.onSearchResults(result);
  });

  const writerProxy: TerminalDataWriter = (write) => {
    if (write.kind === "snapshot") {
      // Resize the grid to the snapshot's dimensions BEFORE replaying it. The
      // host snapshot is a full-screen redraw (absolute cursor positioning, the
      // serialized emulator screen) valid only at the cols/rows the host
      // rendered it for. Replaying it into a differently-sized grid - the 80x24
      // default on a fresh open, or a wider pane under "smaller-pane-wins" -
      // lands every line at the wrong column and leaves stale cells, producing
      // garbled, overlapping frames. The post-snapshot resize via
      // `useTerminalResizeSync` runs too late: xterm can't un-mangle an
      // already-misparsed redraw (and for alt-screen content it can't reflow at
      // all). Resizing here, synchronously ahead of the write, is the fix.
      if (
        write.cols > 0 &&
        write.rows > 0 &&
        (term.cols !== write.cols || term.rows !== write.rows)
      ) {
        term.resize(write.cols, write.rows);
      }
      // Reset before replaying a snapshot into an engine that already holds
      // content. A snapshot is always the host's AUTHORITATIVE full-screen state
      // (serialized emulator screen + scrollback + OSC colour preamble), so it
      // must land on a clean buffer. On a transport reconnect / reopen the
      // engine is kept alive and still shows pre-disconnect content; replaying
      // the serialized redraw on top of it collides with the stale
      // cursor/content - dropping the tail (the "last few output chars lost on
      // resume" bug) and leaving the native OSC theme un-rasterized until a tab
      // switch forces a repaint ("theme lost, comes back on tab switch"). RIS
      // (`ESC c`) is a full reset through the parser - clears buffer + scrollback
      // and restores default colours while preserving the grid size we just set
      // - so the snapshot's OSC preamble then re-applies the native palette,
      // exactly like a fresh open. (We use the escape, not `term.reset()`, which
      // is unbound in this xterm build.) The first snapshot on a fresh engine
      // skips this - nothing to clear. Prepended to the chunk (string or, for
      // a `@1.2` binary connection, `Uint8Array` - see `prependResetEscape`)
      // so it parses in-order, ahead of the redraw, inside the
      // replay-suppression guard.
      const replay = hasReceivedContent
        ? prependResetEscape(write.chunk)
        : write.chunk;
      hasReceivedContent = true;
      snapshotReplayDepth += 1;
      term.write(replay, () => {
        snapshotReplayDepth = Math.max(0, snapshotReplayDepth - 1);
        // Ack-credit (terminal.subscribe@1.1): report the ORIGINAL
        // `write.chunk` length the host actually counted, not the
        // longer `replay` payload this proxy prepended the reset escape to.
        write.onAckable();
      });
      return;
    }
    hasReceivedContent = true;
    term.write(write.chunk, write.onAckable);
  };

  // Dedupe so the host isn't spammed with identical resize frames on every
  // render tick (cursor blink, keystroke echo, etc.).
  let lastSentCols = 0;
  let lastSentRows = 0;
  let resizeDebounce: number | null = null;

  // Measure the container's natural grid, or return null when the box is in a
  // state we must NOT report from. `proposeDimensions` floors to its 2x1
  // minimum whenever the box is 0x0 (hidden `display:none` pane / detached
  // mid-reattach) OR collapsed mid window-restore (the flex height chain hasn't
  // resettled, so the box is a few px tall while still full width). Reporting
  // that floored size to the host poisons its shared `min(cols/rows)` grid for
  // every attached client - the "terminal came back tiny and won't recover"
  // failure. Skipping keeps the last good grid; the ResizeObserver re-measures
  // once the box settles. The minimum-px floor is what catches the transient
  // collapse the plain `=== 0` guard let through: no usable terminal surface is
  // ever this small.
  const proposeContainerDims = (): { cols: number; rows: number } | null => {
    if (!containerEl.isConnected) return null;
    if (
      containerEl.clientWidth < MIN_FIT_CONTAINER_PX ||
      containerEl.clientHeight < MIN_FIT_CONTAINER_PX
    ) {
      return null;
    }
    const dims = fitAddon.proposeDimensions();
    if (dims === undefined) return null;
    if (dims.cols <= 0 || dims.rows <= 0) return null;
    return { cols: dims.cols, rows: dims.rows };
  };

  // Report the measured grid to the host. We deliberately do NOT size the local
  // `term` here. The host owns the authoritative grid - it computes the
  // effective size as `min(cols/rows)` across every attached subscriber
  // ("smaller pane wins") and echoes it back, where `useTerminalResizeSync` is
  // the single owner that applies it to `term`. Resizing locally to our own
  // proposal would let this client run wider than a legitimately-smaller peer's
  // effective grid, desyncing the local grid from the PTY. The cost is one host
  // round-trip of latency before a fresh open / drag-resize repaints at the new
  // size; the reattach snapshot path already sizes `term` to the snapshot's
  // grid up front, so reattach doesn't flash.
  const reportDims = (cols: number, rows: number): void => {
    lastSentCols = cols;
    lastSentRows = rows;
    live.onContainerResize(cols, rows);
  };

  // Fit the local grid to the container and report it to the host, deduped
  // against the last size we reported so render-tick churn doesn't re-send.
  // Repairing a stale *shared* grid (the box hasn't changed, but the host's
  // min(cols/rows) is pinned tiny) is `reconcileWithHost`'s job, not this one's.
  const fitToContainer = (): void => {
    const dims = proposeContainerDims();
    if (dims === null) return;
    if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
    reportDims(dims.cols, dims.rows);
  };

  // Recovery: when the host's authoritative grid disagrees with what this
  // healthy container would naturally propose, re-report our natural size. This
  // unsticks a session whose shared grid was latched to a stale/tiny value by a
  // transient (or by a client that has since corrected); without it the engine
  // dedupe keeps us pinned because nothing re-measures the unchanged box.
  const reconcileWithHost = (hostCols: number, hostRows: number): void => {
    const dims = proposeContainerDims();
    if (dims === null) return;
    if (dims.cols === hostCols && dims.rows === hostRows) return;
    reportDims(dims.cols, dims.rows);
  };

  // `term.onRender` is the event xterm fires after committing a render. The
  // first render is also when cell dimensions become measurable, so listening
  // here removes the need for ad-hoc rAF/setTimeout retries -
  // `fitAddon.proposeDimensions()` only ever bails because the renderer hasn't
  // measured cells yet, and that condition resolves at exactly this moment.
  // Subsequent fires are cheap because of the dedupe above.
  const renderDisposable = term.onRender(() => {
    markTerminalLoad(sessionId, "first-render");
    fitToContainer();
  });

  const observer = new ResizeObserver(() => {
    if (resizeDebounce !== null) {
      clearTimeout(resizeDebounce);
    }
    resizeDebounce = window.setTimeout(() => {
      resizeDebounce = null;
      fitToContainer();
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(containerEl);

  const disposeEngine = (): void => {
    observer.disconnect();
    renderDisposable.dispose();
    if (resizeDebounce !== null) {
      clearTimeout(resizeDebounce);
      resizeDebounce = null;
    }
    dataDisposable.dispose();
    searchResultsDisposable.dispose();
    if (canvas !== null) {
      canvas.dispose();
    }
    // xterm's Viewport schedules an initial `setTimeout(syncScrollArea)`. A
    // fast open→close (or StrictMode mount/cleanup/mount) can dispose before
    // that timer fires; disposing immediately clears xterm's renderer and the
    // pending Viewport timer then crashes reading `renderService.dimensions`.
    // Leave the terminal alive for one macrotask so xterm's startup timer
    // drains before final disposal.
    window.setTimeout(() => {
      term.dispose();
    }, XTERM_STARTUP_DISPOSE_DELAY_MS);
    containerEl.remove();
  };

  return {
    sessionId,
    containerEl,
    term,
    fitAddon,
    searchAddon,
    canvasAddon: canvas,
    writerProxy,
    live,
    controls: { fitToContainer, reconcileWithHost },
    disposeEngine,
  };
}

function handleTerminalScrollKey(
  term: Terminal,
  event: KeyboardEvent,
): boolean | null {
  // Scroll-to-top/bottom on Cmd+Home/End (macOS) / Ctrl+Home/End (elsewhere),
  // with VS Code's !terminalAltBufferActive gating: jump the viewport on the
  // normal buffer, pass through on the alternate one so the program sees the
  // chord. On macOS plain Home/End scroll too - Terminal.app convention, where
  // line editing at the prompt is Cmd+arrows / Ctrl-A/E instead. Off-mac they
  // stay shell line-edit keys.
  if (
    isPlatformModifiedBoundaryKey(event) ||
    (isMac() && isPlainBoundaryKey(event))
  ) {
    if (term.buffer.active.type === "alternate") return true;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") {
      term.scrollToTop();
    } else {
      term.scrollToBottom();
    }
    return false;
  }

  // Page keys scroll the viewport only on the normal buffer. Fullscreen
  // programs (less, vim - the alternate buffer) have no scrollback to reveal;
  // let xterm encode CSI 5~/6~ so the pager pages natively, matching VS Code's
  // !terminalAltBufferActive gating.
  if (event.key !== "PageUp" && event.key !== "PageDown") return null;
  if (term.buffer.active.type === "alternate") return true;
  event.preventDefault();
  event.stopPropagation();
  term.scrollPages(event.key === "PageUp" ? -1 : 1);
  return false;
}

function handleTerminalCustomKeyEvent(
  term: Terminal,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown") return true;

  // Inject shell line-edit escape sequences for Mac Cmd/Option chords (jump to
  // line start/end, word-jump, kill to line start, TUI newline) before xterm's
  // own key encoder runs.
  const lineEdit = translateLineEditChord(event, { isMac: isMac() });
  if (lineEdit !== null) {
    event.preventDefault();
    event.stopPropagation();
    term.input(lineEdit, true);
    return false;
  }

  // Must precede the Mac Cmd-chord early-return below: alternate-buffer
  // Home/End explicitly bypass that generic guard and reach the program.
  const scrollKeyResult = handleTerminalScrollKey(term, event);
  if (scrollKeyResult !== null) return scrollKeyResult;

  // Preserve Mac clipboard / select-all once the kitty protocol is on. With
  // kitty active inside a TUI, xterm would otherwise CSI-u encode Cmd chords
  // (and cancel the browser default), breaking copy/paste/select-all and
  // leaking the chord into the program. App-bound Cmd chords never reach here -
  // the capture-phase KeybindingProvider already claimed them.
  if (isMac() && event.metaKey && !event.ctrlKey && !event.altKey) {
    // Cmd+A selects the terminal buffer; the browser default would select the
    // surrounding page instead.
    if (event.code === "KeyA" && !event.shiftKey) {
      event.preventDefault();
      term.selectAll();
      return false;
    }
    // Ghostty's rule: on macOS, Cmd chords don't encode text. Let them bubble
    // to the browser so its keydown->copy/paste pipeline (which drives xterm's
    // clipboard events) runs. Do NOT preventDefault - that pipeline needs the
    // default action.
    return false;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
  }

  return true;
}

// Default export so `React.lazy(() => import("./terminal-tile-xterm"))`
// resolves to the host component without an adapter. Static callers
// (existing renderer registry, tests) keep using the named export.
export default TerminalXtermHost;

function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("public.file-url") ||
    dataTransferItems(dataTransfer).some((item) => item.kind === "file")
  );
}

function collectDroppedFiles(dataTransfer: DataTransfer): readonly File[] {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;
  return dataTransferItems(dataTransfer).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

function resolveFileTransferPaths(
  dataTransfer: DataTransfer,
  fileDrops: IRunnerHost["fileDrops"],
): Promise<readonly string[]> | null {
  const files = collectDroppedFiles(dataTransfer);
  // File URLs are a fallback for sources that expose no `File` object - notably
  // macOS screenshot thumbnails. Their backing file can disappear after either
  // a drag or paste, so copy it into an app-managed temporary location before
  // insertion. Real Finder files can carry a duplicate URI list; favor their
  // original path rather than a copied one.
  const fileUrlPaths =
    files.length === 0 ? collectDroppedFileUrlPaths(dataTransfer) : [];
  if (files.length === 0 && fileUrlPaths.length === 0) return null;
  const resolvedFilePaths =
    files.length === 0
      ? Promise.resolve([] as readonly string[])
      : fileDrops.resolveDroppedFilePaths(files);
  const stableUrlPaths =
    fileUrlPaths.length === 0
      ? Promise.resolve([] as readonly string[])
      : fileDrops.copyDroppedFilePaths(fileUrlPaths);
  return Promise.all([resolvedFilePaths, stableUrlPaths]).then(
    ([paths, urlPaths]) => [...paths, ...urlPaths],
  );
}

function collectDroppedFileUrlPaths(
  dataTransfer: DataTransfer,
): readonly string[] {
  const uriList = readDataTransferData(dataTransfer, "text/uri-list");
  const publicFileUrl = readDataTransferData(dataTransfer, "public.file-url");
  return uniquePaths(
    [...parseFileUriList(uriList), fileUriToPath(publicFileUrl)].filter(
      isNonNullString,
    ),
  );
}

function readDataTransferData(
  dataTransfer: DataTransfer,
  type: string,
): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
}

function dataTransferItems(
  dataTransfer: DataTransfer,
): readonly DataTransferItem[] {
  const indexedItems = Array.from(dataTransfer.items).filter(
    isDataTransferItem,
  );
  if (indexedItems.length === dataTransfer.items.length) return indexedItems;
  return Array.from({ length: dataTransfer.items.length }, (_value, index) => {
    return dataTransfer.items[index];
  }).filter(isDataTransferItem);
}

function isDataTransferItem(
  value: DataTransferItem | null | undefined,
): value is DataTransferItem {
  return value !== null && value !== undefined;
}

function parseFileUriList(value: string): readonly string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(fileUriToPath)
    .filter(isNonNullString);
}

function fileUriToPath(value: string): string | null {
  if (!value.startsWith("file://")) return null;
  const withoutScheme = value.slice("file://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) return null;
  const host = withoutScheme.slice(0, slashIndex);
  const rawPath = withoutScheme.slice(slashIndex);
  const path = decodeFileUriPath(rawPath);
  if (path === null) return null;
  if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1);
  if (host.length === 0 || host === "localhost") return path;
  return `//${host}${path}`;
}

function decodeFileUriPath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isNonNullString(value: string | null): value is string {
  return value !== null;
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}

function terminalPathInput(paths: readonly string[]): string {
  return paths.map(escapeTerminalPath).join(" ");
}

function escapeTerminalPath(path: string): string {
  return path.replace(TERMINAL_PATH_ESCAPE_PATTERN, "\\$1");
}

function useTerminalFindRegistration(
  activeFindTargetId: string | null,
  searchAddonRef: RefObject<SearchAddon | null>,
  markSearchResultSource: (source: TerminalSearchResultSource) => void,
): void {
  useEffect(() => {
    const findTargetId = activeFindTargetId;
    if (findTargetId === null) return;
    return registerActiveTerminalFindController({
      id: findTargetId,
      findNext: (query, matchCase, incremental) => {
        markSearchResultSource("legacy");
        return runLegacyTerminalSearch({
          addon: searchAddonRef.current,
          query,
          matchCase,
          forward: true,
          incremental,
        });
      },
      findPrevious: (query, matchCase) => {
        markSearchResultSource("legacy");
        return runLegacyTerminalSearch({
          addon: searchAddonRef.current,
          query,
          matchCase,
          forward: false,
          incremental: false,
        });
      },
      clear: () => {
        markSearchResultSource("legacy");
        searchAddonRef.current?.clearDecorations();
      },
    });
  }, [activeFindTargetId, markSearchResultSource, searchAddonRef]);
}

function useTerminalResizeSync(
  termRef: RefObject<Terminal | null>,
  effectiveCols: number,
  effectiveRows: number,
): void {
  // Drive `term.resize` from the host's authoritative effective size so every
  // attached client shows the same grid (the smaller pane wins). This is the
  // single owner of local grid sizing in steady state - the propose/report path
  // only reports to the host and never resizes `term` itself, so the local grid
  // can never run ahead of the effective grid. (The reattach snapshot path also
  // resizes `term`, but only once, to the snapshot's own dimensions.)
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    if (effectiveCols <= 0 || effectiveRows <= 0) return;
    if (term.cols === effectiveCols && term.rows === effectiveRows) return;
    term.resize(effectiveCols, effectiveRows);
  }, [effectiveCols, effectiveRows, termRef]);
}

function useHostGridReconcile(
  controlsRef: RefObject<XtermHostControls | null>,
  effectiveCols: number,
  effectiveRows: number,
): void {
  // When the host's authoritative grid changes, re-report this container's
  // natural size if it disagrees. A transient (window restore, a hidden-pane
  // measurement, or another client) can latch the shared `min(cols/rows)` grid
  // to a stale/tiny value; re-reporting from a healthy container is what
  // releases the latch. The engine's own dedupe would otherwise keep us pinned
  // because nothing re-measures the unchanged box, and the store dedupes the
  // re-report against its last-requested size so this can't loop.
  useEffect(() => {
    controlsRef.current?.reconcileWithHost(effectiveCols, effectiveRows);
  }, [controlsRef, effectiveCols, effectiveRows]);
}

interface TerminalAppearanceSyncInput {
  readonly termRef: RefObject<Terminal | null>;
  readonly controlsRef: RefObject<XtermHostControls | null>;
  readonly canvasRef: RefObject<CanvasAddon | null>;
  readonly theme: ITerminalOptions["theme"];
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly cursorStyle: TerminalCursorStyle;
  readonly cursorBlink: boolean;
}

function useTerminalAppearanceSync(input: TerminalAppearanceSyncInput): void {
  const {
    termRef,
    controlsRef,
    canvasRef,
    theme,
    fontSize,
    fontFamily,
    cursorStyle,
    cursorBlink,
  } = input;

  // Live theme switching: rebuild the xterm palette when the resolved
  // light/dark mode or active preset changes, then ask the WebGL atlas
  // (if any) to re-rasterize glyphs. The schedule is rAF-batched across
  // every mounted terminal so toggling a preset with N tiles open doesn't
  // fire N independent atlas clears in the same tick.
  useLayoutEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = theme;
    scheduleAtlasClear(term, canvasRef.current);
  }, [termRef, theme, canvasRef]);

  // Live font sync: `fontSize`/`fontFamily` are the effective terminal
  // values - a Settings → Terminal override when set, else the Settings →
  // Code value/font (see `resolveEffectiveFontFamily`) - so this effect
  // tracks both the size slider and any font-family change.
  useLayoutEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    scheduleAtlasClear(term, canvasRef.current);
    // A font/size change changes the cell box, so the grid must refit. Route it
    // through the engine's guarded path (not a raw `fitAddon.fit()`) so the new
    // size is reported to the host and kept in the engine's dedupe state. If the
    // renderer hasn't re-measured cells yet this proposes nothing; the onRender
    // propose loop refits on the next frame.
    controlsRef.current?.fitToContainer();
  }, [fontSize, controlsRef, fontFamily, termRef, canvasRef]);

  // Live cursor sync: shape and blink are pure renderer options - they don't
  // touch cell geometry, so unlike the font effect this neither refits the grid
  // nor clears the glyph atlas. xterm repaints the cursor on the option write.
  useLayoutEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorInactiveStyle = inactiveCursorStyleFor(cursorStyle);
    term.options.cursorBlink = cursorBlink;
  }, [termRef, cursorStyle, cursorBlink]);
}

function useVisibleTerminalRepair(input: {
  readonly termRef: RefObject<Terminal | null>;
  readonly controlsRef: RefObject<XtermHostControls | null>;
  readonly canvasRef: RefObject<CanvasAddon | null>;
  readonly theme: ITerminalOptions["theme"];
}): void {
  const { termRef, controlsRef, canvasRef, theme } = input;
  // Repaint when this pane becomes visible again. A tab switch never unmounts
  // the tile (the pane is hidden via `visibility:hidden` / `display:none` and
  // kept mounted so xterm scrollback survives), so the Traycer Host reattach pulse
  // never runs here - this hook is the ONLY recovery for the live screen.
  //
  // While hidden the container measures 0x0 (or a collapsed sub-`MIN_FIT_*`
  // box), so the engine's guarded propose skips and `term.resize` is never
  // called - the grid keeps its last cols/rows. On show, fit proposes the real
  // dims again; if they match nothing resizes and the renderer never re-issues
  // a full draw, leaving whatever the canvas last painted - and after a
  // `display:none` cycle the canvas backing store and the glyph texture atlas
  // can come back invalidated, which surfaces as a blank grid ("buffer
  // dropped") or default-colored glyphs ("theme reset").
  //
  // Order is load-bearing: re-assert the palette, clear the glyph atlas
  // SYNCHRONOUSLY, then `term.refresh(0, rows-1)` to mark every row dirty and
  // force a full repaint. The rAF-batched `scheduleAtlasClear` would run AFTER
  // this synchronous refresh, so the refresh would paint from the stale atlas
  // and nothing would repaint once the deferred clear dropped it. Clearing
  // first guarantees every cell re-rasterizes in the current theme. (The rAF
  // batching exists to coalesce a theme toggle across N tiles; reshow only
  // ever repaints the one pane becoming visible, so a direct clear is fine.)
  const refitVisiblePane = useCallback(() => {
    const term = termRef.current;
    if (term === null) return;
    const controls = controlsRef.current;
    if (controls !== null) {
      // Refit to the box this pane now occupies. This re-reports only when the
      // measured grid differs from what we last sent (the `fitToContainer`
      // dedupe), so an ordinary tab switch with an unchanged box sends nothing.
      // We deliberately do NOT `reconcileWithHost` here: it compares natural
      // dims against the host's effective grid (not lastSent), which legitimately
      // differ under "smaller-pane-wins"/rounding, so it re-reported on every
      // pane-show and caused the spurious resize-on-tab-switch. Recovery from a
      // genuinely stale shared grid is left to `useHostGridReconcile`, which
      // fires on an actual effective-size change, not on visibility.
      controls.fitToContainer();
    }
    term.options.theme = theme;
    clearTerminalAtlasSafely(canvasRef.current);
    term.refresh(0, term.rows - 1);
  }, [controlsRef, termRef, canvasRef, theme]);
  useActivePaneEffect(refitVisiblePane);
}

function clearTerminalAtlasSafely(canvas: CanvasAddon | null): void {
  if (canvas === null) return;
  try {
    canvas.clearTextureAtlas();
  } catch {
    // Addon disposed (WebGL fallback path / mid-teardown); xterm's own
    // renderer re-rasterizes glyphs on the next draw.
  }
}

function useActiveTerminalFocus(
  termRef: RefObject<Terminal | null>,
  shouldFocusOnActivePane: boolean,
): void {
  const focusVisibleTerminal = useCallback(() => {
    if (!shouldFocusOnActivePane) return;
    const focusTimer = window.setTimeout(() => {
      termRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(focusTimer);
    };
  }, [shouldFocusOnActivePane, termRef]);
  useActivePaneEffect(focusVisibleTerminal);
}

function runLegacyTerminalSearch(input: {
  readonly addon: SearchAddon | null;
  readonly query: string;
  readonly matchCase: boolean;
  readonly forward: boolean;
  readonly incremental: boolean;
}): boolean {
  const result = runTerminalXtermSearch(input);
  if (!result.attempted) return false;
  if (result.cleared) {
    useFindInPageStore.getState().setMatches(null);
    return true;
  }
  if (!result.found) {
    useFindInPageStore.getState().setMatches({ current: 0, total: 0 });
  }
  return true;
}

function publishLegacyTerminalSearchResult(
  result: ISearchResultChangeEvent,
): void {
  if (result.resultCount === 0) {
    useFindInPageStore.getState().setMatches({ current: 0, total: 0 });
    return;
  }
  if (result.resultIndex < 0) {
    useFindInPageStore.getState().setMatches({
      current: 0,
      total: result.resultCount,
    });
    return;
  }
  useFindInPageStore.getState().setMatches({
    current: result.resultIndex + 1,
    total: result.resultCount,
  });
}
