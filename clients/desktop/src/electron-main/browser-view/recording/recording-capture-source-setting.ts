import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import type { RecordingCaptureSourceKind } from "@traycer-clients/shared/platform/browser-view";
import { createJsonFileStore } from "../../app/json-file-store";

/**
 * WHICH STREAM THE HELPER RECORDS.
 *
 * Two implementations, one helper document (D15 amendment, 2026-09-08):
 *
 * - `display-media` - the hidden helper window calls `getDisplayMedia` and the
 *   session policy answers it with the guest's own frame. No per-frame cost,
 *   and the guest must be presented on-screen (opacity 0) for its life, which
 *   is why the renderer holds a recording posture while one runs.
 * - `capture-page` - the PiP-proven `capturePage` poll, pushed into the same
 *   helper document, which draws it on a canvas and records
 *   `canvas.captureStream()`. Works on any placement and costs a full-frame
 *   capture per tick.
 *
 * The override is the file itself - `browser-recording-capture-source.json` in
 * desktop userData, `{ "source": "capture-page" }` - written by hand, with no
 * writer and no toggle in this process. A setter would be a second way to
 * reach a value nothing in the product chooses, and this one exists only until
 * one GPU-desktop run settles the DEFAULT for everyone.
 *
 * The default is `display-media`. The only thing that can choose between the
 * two is evidence from a real GPU desktop - the sandbox probe could not decide
 * it (D15 PROBE STATUS) - and `recording-probe.ts` is the dev command that
 * produces that evidence. Until then a machine where display-media freezes
 * writes this file and records correctly with no new build; once one run
 * settles it for everyone, the DEFAULT changes and this file stops mattering.
 *
 * Per machine, in desktop userData, like every other desktop-shaped
 * preference: it is a statement about this GPU and this compositor, never
 * about the account.
 */
export type { RecordingCaptureSourceKind };

export const DEFAULT_RECORDING_CAPTURE_SOURCE: RecordingCaptureSourceKind =
  "display-media";

const STORE_FILE_NAME = "browser-recording-capture-source.json";

interface RecordingCaptureSourceState {
  readonly source: RecordingCaptureSourceKind;
}

const DEFAULT_STATE: RecordingCaptureSourceState = {
  source: DEFAULT_RECORDING_CAPTURE_SOURCE,
};

const stateSchema = z.object({
  source: z.enum(["display-media", "capture-page"]),
});

function parseState(value: unknown): RecordingCaptureSourceState {
  return stateSchema.safeParse(value).data ?? DEFAULT_STATE;
}

// `app.getPath("userData")` is only valid after the app module boots, so the
// store is built per call rather than at module load (mirrors
// `desktop-log-level.ts`).
function store() {
  return createJsonFileStore<RecordingCaptureSourceState>(
    join(app.getPath("userData"), STORE_FILE_NAME),
    DEFAULT_STATE,
    parseState,
  );
}

/** Never throws: an unreadable or absent file reads back as the default. */
export async function readRecordingCaptureSource(): Promise<RecordingCaptureSourceKind> {
  return (await store().load()).source;
}
