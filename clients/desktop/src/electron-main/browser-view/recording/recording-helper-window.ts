import { BrowserWindow, webContents as electronWebContents } from "electron";
import type { RecordingEvent } from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";
import type { BrowserViewWebContents } from "../browser-view-port";
import {
  DEFAULT_RECORDING_CAPTURE_SOURCE,
  readRecordingCaptureSource,
  type RecordingCaptureSourceKind,
} from "./recording-capture-source-setting";
import { registerRecordingHelper } from "./recording-helper-registry";

/**
 * THE HIDDEN RECORDING HELPER WINDOW (D15, D16, ticket 20).
 *
 * One `BrowserWindow({ show: false })` per recording, loading the SAME helper
 * document the headless plane opens, served from the host's own loopback
 * listener. Chunks leave the helper by same-origin `POST` (D15), so nothing
 * here ever sees a recording byte: main opens the window, decides who may be
 * handed the guest's pixels, and answers with two frames.
 *
 * ## Two capture sources behind one seam
 *
 * The sandbox probe could not settle whether a hidden window's
 * `getDisplayMedia` stream ADVANCES on a real GPU desktop (D15 PROBE STATUS:
 * every placement froze under Xvfb software compositing, which is expected
 * there and proves nothing about a real machine). Rather than block the epic
 * on a manual probe, both stream origins ship behind
 * {@link RecordingCaptureSource} and the choice is a per-machine file
 * (`recording-capture-source-setting.ts`). The helper document is the same one
 * either way; only where its `MediaRecorder` gets its stream differs, which
 * the helper is told by the `source=` query parameter.
 *
 * ## Three probe findings this file obeys
 *
 * 1. The display-media handler must be answered with the guest's
 *    `mainFrame` (a `WebFrameMain`), never its `WebContents`.
 * 2. A guest at the ADR's retained OFF-SCREEN rect cannot start a capture at
 *    all (`AbortError: Timeout starting video source`). The guest must be
 *    presented on-screen for the recording's life - the renderer holds a
 *    recording posture (opacity 0, inert, under the canvas) while one runs.
 * 3. `win.destroy()` on a helper mid-process breaks the NEXT helper window's
 *    navigation. Teardown is always `win.close()`.
 */

/**
 * How often the `capture-page` source samples the guest.
 *
 * ponytail: 10 fps and a base64 hop per frame - a fallback that trades CPU and
 * smoothness for working on any placement. If it ever becomes the default,
 * the upgrade is a dedicated helper preload with an `ipcRenderer` channel
 * carrying the bytes, which removes the base64 leg entirely.
 */
const CAPTURE_PAGE_FRAME_INTERVAL_MS = 100;
const CAPTURE_PAGE_FRAME_QUALITY = 80;

/** The frame rate the helper's encoder is asked for on the display-media path. */
const HELPER_RECORDING_FPS = 30;

/** How long a helper gets to get its recorder running before we give up. */
const HELPER_START_TIMEOUT_MS = 20_000;

/**
 * A helper that loaded and then never got its recorder running, kept distinct
 * from one that failed to load at all: it is the signature of a display-media
 * grant that resolved to nothing, which is the exact failure the capture
 * source seam exists for, and reading it in a support log is how anyone finds
 * out.
 */
const HELPER_START_TIMEOUT_REASON = "helper-start-timeout";

/** How long the helper gets to finalize before its window is closed. */
const HELPER_STOP_TIMEOUT_MS = 5_000;

/**
 * The helper window's size. It is never shown and it does not set the clip's
 * geometry either way - display-media takes the guest's, and on capture-page
 * the first frame the helper accepts fixes it - but a `BrowserWindow` with no
 * size is not a thing, and a helper laid out at a plausible viewport is one
 * less difference from the headless plane's page.
 */
const HELPER_WINDOW_WIDTH = 1280;
const HELPER_WINDOW_HEIGHT = 800;

/**
 * THE HELPER DOCUMENT'S API (ticket 19). Two globals, and the second exists
 * only under `source=capture-page`, which is why every use of it is
 * feature-detected in the page rather than assumed here.
 *
 * - `window.__traycerRecordingHelper.start({ fps })` / `.stop(reason)`, both
 *   idempotent. `start` is what gets the `MediaRecorder` running on the
 *   display-media path; `stop` is how a recording is FINALIZED, which is why
 *   the window is never closed until it has run.
 * - `window.__traycerRecordingFrames.push(frame)` with `frame: ImageBitmap |
 *   Blob`. Void and fire-and-forget - frames are drawn in call order on the
 *   helper's own promise chain. The FIRST accepted frame fixes the geometry
 *   and starts the encoder, so on this path readiness IS the first push
 *   landing and there is no `start()` call.
 *
 * The helper reports its own terminal state to the host over
 * `POST /recording/<id>/end`; the `recordingEnded` frame this module emits is
 * the desktop's answer for the paths the helper cannot observe - its window
 * closed underneath it, the guest destroyed, a load that never happened.
 *
 * Delivered by `executeJavaScript` rather than a preload channel deliberately:
 * a second preload bundle is a build entry, a package-shape assertion and an
 * `electron-builder` glob, and PiP's frame channel goes the other way (main to
 * the APP renderer), so there is nothing here to reuse. The cost is one base64
 * encode per frame, named in the ponytail note above.
 */
const HELPER_START_SCRIPT = `Promise.resolve(window.__traycerRecordingHelper.start({ fps: ${HELPER_RECORDING_FPS} })).then(() => true)`;

function helperStopScript(reason: string): string {
  return `Promise.resolve(window.__traycerRecordingHelper?.stop(${JSON.stringify(reason)})).then(() => true)`;
}

/** `false` when the document exposes no frame sink, i.e. it is not in capture-page mode. */
function pushFrameScript(base64: string): string {
  return `(() => { const sink = window.__traycerRecordingFrames; if (sink === undefined) return false; sink.push(new Blob([Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))], { type: "image/jpeg" })); return true; })()`;
}

/**
 * The stream a helper's `MediaRecorder` records. Two implementations; the
 * helper document is the same for both.
 */
interface RecordingCaptureSource {
  readonly kind: RecordingCaptureSourceKind;
  /**
   * Runs BEFORE the helper document loads. The display-media grant has to
   * exist by then: the helper asks for the stream as it loads, and a grant
   * registered after that races a request the session policy has already
   * refused.
   */
  beforeHelperLoad(): void;
  /**
   * Runs once the document has loaded, and RESOLVES when the helper's recorder
   * is actually running - `start({ fps })` on the display-media path, the
   * first accepted frame on the capture-page one. That resolution is what
   * `recordingHelperReady` reports, which is the whole reason the protocol
   * waits for this frame rather than for the start it sent.
   */
  startHelper(): Promise<void>;
  /** Idempotent; runs on every terminal path. */
  stop(): void;
  /** What this source has handed the helper. Both 0 for `display-media`. */
  frameStats(): RecordingFrameStats;
}

export interface RecordingFrameStats {
  readonly pushed: number;
  /** Of those, how many differed byte-for-byte from the frame before. */
  readonly distinct: number;
}

const NO_FRAMES: RecordingFrameStats = { pushed: 0, distinct: 0 };

interface ActiveRecording {
  readonly recordingId: string;
  readonly helper: BrowserWindow;
  readonly source: RecordingCaptureSource;
  readonly onEvent: (event: RecordingEvent) => void;
  readonly releaseGuest: () => void;
}

const activeRecordings = new Map<string, ActiveRecording>();

export interface RecordingHelperStartRequest {
  readonly recordingId: string;
  /**
   * The host's own loopback URL with `mode=record`, the `recordingId` and the
   * recording's one-shot bearer token already in it. It is a CREDENTIAL: it
   * never reaches a log line, an error message or a `recordingEnded` reason.
   */
  readonly helperUrl: string;
  readonly guest: BrowserViewWebContents;
  /**
   * Forces a source instead of reading the machine's setting. Only the dev
   * probe passes one; production always passes `null` so one machine records
   * one way.
   */
  readonly source: RecordingCaptureSourceKind | null;
  readonly onEvent: (event: RecordingEvent) => void;
}

/**
 * Opens the helper for one recording.
 *
 * Rejects only for what is knowable BEFORE a window exists - a guest that is
 * gone, a helper URL that is not a URL, a `recordingId` already running.
 * Everything after that is reported as `recordingEnded { reason }`, because by
 * then there is a window to tear down and a host waiting for an answer rather
 * than a rejected call.
 */
export async function startRecordingHelper(
  request: RecordingHelperStartRequest,
): Promise<void> {
  if (activeRecordings.has(request.recordingId)) {
    throw new Error("A recording with this id is already running");
  }
  const guestId = request.guest.id;
  const guest = electronWebContents.fromId(guestId);
  if (guest === undefined || guest.isDestroyed()) {
    throw new Error("Electron browser tab is not available for recording");
  }
  const kind = request.source ?? (await readRecordingCaptureSourceSafely());
  // Re-proved after the await: reading the per-machine setting touches the
  // disk, and a guest that died in that window would be handed to
  // `new BrowserWindow({ session: guest.session })` below, which throws on a
  // destroyed WebContents rather than answering this call.
  if (guest.isDestroyed() || request.guest.isDestroyed()) {
    throw new Error("Electron browser tab is not available for recording");
  }
  const url = helperUrlForSource(request.helperUrl, kind);

  const helper = new BrowserWindow({
    show: false,
    width: HELPER_WINDOW_WIDTH,
    height: HELPER_WINDOW_HEIGHT,
    webPreferences: {
      // The GUEST'S session, so the recording grant is answered by the very
      // display-media handler this ticket narrowed (`browser-session.ts`) and
      // no second policy surface has to be kept in step with it.
      session: guest.session,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // A recorder opens nothing. The helper is our own document, but it is the
  // one window in this process holding a display-capture grant, so the cheapest
  // way for it never to become a window factory is for it to have no opener.
  helper.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const source =
    kind === "capture-page"
      ? createCapturePageSource(helper, request.guest)
      : createDisplayMediaSource(helper, guestId, request.recordingId);

  const onGuestDestroyed = (): void => {
    endRecording(request.recordingId, "guest-destroyed");
  };
  request.guest.on("destroyed", onGuestDestroyed);

  const active: ActiveRecording = {
    recordingId: request.recordingId,
    helper,
    source,
    onEvent: request.onEvent,
    releaseGuest: () => {
      request.guest.off("destroyed", onGuestDestroyed);
    },
  };
  activeRecordings.set(request.recordingId, active);

  helper.on("closed", () => {
    endRecording(request.recordingId, "helper-window-closed");
  });
  helper.webContents.on("render-process-gone", () => {
    endRecording(request.recordingId, "helper-render-process-gone");
  });
  helper.webContents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      // A subframe the helper document pulls in is not the recording; only the
      // document itself failing to load ends one.
      if (!isMainFrame) return;
      // The code, never the URL: the helper URL carries the recording's bearer
      // token and this line is INFO+.
      log.warn("[browser-view] recording helper failed to load", {
        recording: request.recordingId,
        errorCode,
      });
      endRecording(request.recordingId, "helper-load-failed");
    },
  );

  source.beforeHelperLoad();
  log.info("[browser-view] recording helper opening", {
    recording: request.recordingId,
    source: kind,
  });

  void driveHelper(active, url, source).catch((error: unknown) => {
    log.warn("[browser-view] recording helper start failed", {
      recording: active.recordingId,
      error: describeLogError(error),
    });
    endRecording(
      active.recordingId,
      error instanceof Error && error.message === HELPER_START_TIMEOUT_REASON
        ? HELPER_START_TIMEOUT_REASON
        : "helper-start-failed",
    );
  });
}

/** Tears the helper down. A `recordingId` this process is not running is a no-op. */
export function stopRecordingHelper(recordingId: string, reason: string): void {
  endRecording(recordingId, reason);
}

/** Every helper this process holds - app quit, manager disposal. */
export function stopAllRecordingHelpers(reason: string): void {
  for (const recordingId of [...activeRecordings.keys()]) {
    endRecording(recordingId, reason);
  }
}

/** Test-only / probe-only: how many recordings are live right now. */
export function activeRecordingCount(): number {
  return activeRecordings.size;
}

/** Probe-only: what the `capture-page` source has handed this helper. */
export function recordingFrameStats(recordingId: string): RecordingFrameStats {
  return activeRecordings.get(recordingId)?.source.frameStats() ?? NO_FRAMES;
}

/**
 * Probe-only: evaluates a script in the helper document. Refuses a recording
 * this process is not running, so a caller cannot aim it at an arbitrary
 * window.
 */
export async function evaluateInRecordingHelper(
  recordingId: string,
  script: string,
): Promise<unknown> {
  const active = activeRecordings.get(recordingId);
  if (active === undefined || active.helper.isDestroyed()) {
    throw new Error("Recording helper is not running");
  }
  return active.helper.webContents.executeJavaScript(script, false);
}

async function driveHelper(
  active: ActiveRecording,
  url: string,
  source: RecordingCaptureSource,
): Promise<void> {
  // Electron renders the failing URL into `loadURL`'s rejection
  // (`ERR_FAILED (-2) loading '<url>'`), and this URL IS the recording's
  // bearer token. The caller logs whatever comes out of here at WARN, so the
  // error is REBUILT rather than wrapped - the code the `did-fail-load`
  // listener already logs is the diagnostic.
  try {
    await active.helper.loadURL(url);
  } catch {
    throw new Error("The recording helper document failed to load");
  }
  if (!isThisRunLive(active)) return;
  await withTimeout(
    source.startHelper(),
    HELPER_START_TIMEOUT_MS,
    HELPER_START_TIMEOUT_REASON,
  );
  if (!isThisRunLive(active)) return;
  log.info("[browser-view] recording helper ready", {
    recording: active.recordingId,
    source: source.kind,
  });
  active.onEvent({ kind: "helperReady", recordingId: active.recordingId });
}

/**
 * The ONE terminal path.
 *
 * Every way a recording can end routes here - the host's `stopTabRecording`,
 * the helper window closing, its renderer dying, the load failing, the guest
 * being destroyed, readiness timing out, the app quitting - so
 * `recordingEnded { reason }` is emitted exactly once for each of them. The
 * map entry is removed FIRST: closing the window re-enters through the
 * `closed` listener, and a second emission would settle the host's next
 * recording under this one's id.
 */
function endRecording(recordingId: string, reason: string): void {
  const active = activeRecordings.get(recordingId);
  if (active === undefined) return;
  activeRecordings.delete(recordingId);
  active.releaseGuest();
  active.source.stop();
  log.info("[browser-view] recording ended", {
    recording: recordingId,
    reason,
  });
  active.onEvent({ kind: "ended", recordingId, reason });
  void closeHelperWindow(active.helper, reason);
}

/**
 * Finalize, then close - in that order and never the other way round.
 *
 * `__traycerRecordingHelper.stop(reason)` is what flushes the last chunk and
 * tells the host the recording is over (`POST /recording/<id>/end`); closing
 * the window first would take the tail of every clip with it. Bounded, and
 * every failure is swallowed: a helper whose document never loaded, or whose
 * renderer is already gone, has nothing to finalize and the window still has
 * to go. `close()`, never `destroy()`: destroying a helper mid-process leaves
 * the NEXT helper window unable to navigate (D15 probe finding 3).
 */
async function closeHelperWindow(
  helper: BrowserWindow,
  reason: string,
): Promise<void> {
  if (helper.isDestroyed()) return;
  try {
    await withTimeout(
      helper.webContents.executeJavaScript(helperStopScript(reason), false),
      HELPER_STOP_TIMEOUT_MS,
      "helper-stop-timeout",
    );
  } catch (error) {
    log.warn("[browser-view] recording helper did not finalize", {
      error: describeLogError(error),
    });
  }
  if (!helper.isDestroyed()) helper.close();
}

/**
 * The host mints the whole URL, including `source=display-media`, and the
 * desktop REPLACES that one parameter when this machine's setting says
 * `capture-page`. Nothing else is touched - the origin, the path, `mode`, the
 * `recordingId` and the bearer token are the host's - and the helper reads
 * `source` from its own `location.search`, so the chunk POST and the end
 * report are unaffected either way. The desktop is the only side that knows
 * which source it chose, which is why it is the side that writes it.
 */
function helperUrlForSource(
  helperUrl: string,
  kind: RecordingCaptureSourceKind,
): string {
  const url = new URL(helperUrl);
  url.searchParams.set("source", kind);
  return url.toString();
}

async function readRecordingCaptureSourceSafely(): Promise<RecordingCaptureSourceKind> {
  try {
    return await readRecordingCaptureSource();
  } catch (error) {
    log.warn("[browser-view] recording capture source read failed", {
      error: describeLogError(error),
    });
    return DEFAULT_RECORDING_CAPTURE_SOURCE;
  }
}

function createDisplayMediaSource(
  helper: BrowserWindow,
  guestWebContentsId: number,
  recordingId: string,
): RecordingCaptureSource {
  let revoke: (() => void) | null = null;
  return {
    kind: "display-media",
    beforeHelperLoad: () => {
      revoke = registerRecordingHelper({
        recordingId,
        helperWebContentsId: helper.webContents.id,
        helperFrame: () => {
          if (helper.isDestroyed() || helper.webContents.isDestroyed()) {
            return null;
          }
          const frame = helper.webContents.mainFrame;
          return {
            processId: frame.processId,
            routingId: frame.routingId,
          };
        },
        // Resolved at GRANT time, not captured: the guest may have died
        // between the registration and the request, and a dead frame must
        // read as "deny" rather than as a frame.
        video: () => {
          const guest = electronWebContents.fromId(guestWebContentsId);
          if (guest === undefined || guest.isDestroyed()) return null;
          return guest.mainFrame;
        },
      });
    },
    // The grant is live by now, so the helper's own `getDisplayMedia` is what
    // the session policy answers; this only tells it to record what it got.
    startHelper: async () => {
      await helper.webContents.executeJavaScript(HELPER_START_SCRIPT, false);
    },
    stop: () => {
      revoke?.();
      revoke = null;
    },
    frameStats: () => NO_FRAMES,
  };
}

function createCapturePageSource(
  helper: BrowserWindow,
  guest: BrowserViewWebContents,
): RecordingCaptureSource {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let pushed = 0;
  let distinct = 0;
  let previous: Buffer | null = null;

  /**
   * One `capturePage` sample into the helper's frame sink. `false` means there
   * was nothing to send this tick (a guest that painted nothing yet); a THROW
   * means the document is not a capture-page helper at all, which must end the
   * recording rather than poll a sink that will never exist.
   */
  const pushOnce = async (): Promise<boolean> => {
    const image = await guest.capturePage();
    if (stopped || image.isEmpty()) return false;
    const jpeg = Buffer.from(image.toJPEG(CAPTURE_PAGE_FRAME_QUALITY));
    if (jpeg.byteLength === 0) return false;
    const accepted: unknown = await helper.webContents.executeJavaScript(
      pushFrameScript(jpeg.toString("base64")),
      false,
    );
    if (accepted !== true) {
      throw new Error("Recording helper exposes no capture-page frame sink");
    }
    pushed += 1;
    // A frozen guest re-encodes to the same bytes, so this counts the only
    // thing the dev probe actually asks: did the picture move.
    if (previous === null || !previous.equals(jpeg)) distinct += 1;
    previous = jpeg;
    return true;
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, CAPTURE_PAGE_FRAME_INTERVAL_MS);
  };

  const pump = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pushOnce();
    } catch (error) {
      if (!stopped) {
        log.warn("[browser-view] recording frame push failed", {
          error: describeLogError(error),
        });
      }
    }
    scheduleNext();
  };

  return {
    kind: "capture-page",
    beforeHelperLoad: () => undefined,
    // The helper has no `start()` on this path: the FIRST accepted frame is
    // what fixes the geometry and starts its encoder, so readiness is that
    // push landing. A guest that has painted nothing yet is retried until the
    // caller's start timeout gives up, which is the honest bound - an empty
    // capture is not a failure, it is a guest that is not ready.
    startHelper: async () => {
      while (!stopped && pushed === 0) {
        if (await pushOnce()) break;
        await delay(CAPTURE_PAGE_FRAME_INTERVAL_MS);
      }
      scheduleNext();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      previous = null;
    },
    frameStats: () => ({ pushed, distinct }),
  };
}

/**
 * Is the map entry still THIS run's?
 *
 * By identity, not by id: `endRecording` deletes the entry first precisely so
 * a later start can reuse the id, and an id check would let a torn-down run's
 * in-flight drive report `helperReady` for its successor.
 */
function isThisRunLive(active: ActiveRecording): boolean {
  return activeRecordings.get(active.recordingId) === active;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(reason));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
