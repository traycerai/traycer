import { z } from "zod";

/**
 * WHO MAY BE HANDED A GUEST'S PIXELS.
 *
 * `browser-session.ts` denies every `getDisplayMedia` and every
 * `display-capture` permission by default, and that default must stay correct
 * for every page a user can navigate to. The one exception is a recording
 * helper window this process opened itself (D15), and it is an exception for
 * exactly one guest - its own.
 *
 * The decision lives here rather than in `browser-session.ts` for two reasons.
 * It is the whole security boundary, so it belongs in one file that is read as
 * one thing; and this module imports NOTHING - no Electron, no window
 * machinery - so `browser-session.ts` keeps its current import surface and the
 * grant matrix is testable without an Electron app.
 *
 * A registration is a pair of live-reads, never captured objects: a helper's
 * main frame is replaced across a navigation and a guest's `WebContents` can
 * die under us, so the registry asks at grant time and a stale answer is
 * `null` (denied) rather than a frame that no longer exists.
 */

/**
 * A frame's identity as the display-media request reports it. `processId` +
 * `routingId` is what Electron uses to address a `WebFrameMain`, and the pair
 * is what survives the trip through the `unknown` the policy session hands the
 * handler - object identity does not, because the helper's main frame object
 * is a different one after its document loads.
 */
export interface RecordingHelperFrameId {
  readonly processId: number;
  readonly routingId: number;
}

export interface RecordingHelperRegistration {
  /** Diagnostic only - the registry is addressed by frame, never by this. */
  readonly recordingId: string;
  /** The helper window's `webContents.id`, for the permission handlers. */
  readonly helperWebContentsId: number;
  /** The helper's CURRENT main frame, or `null` once it is gone. */
  readonly helperFrame: () => RecordingHelperFrameId | null;
  /**
   * The `WebFrameMain` of the ONE guest this helper may record, or `null` once
   * that guest is gone. Opaque here on purpose: this module never learns what
   * an Electron frame is, it only decides whose it may hand back.
   */
  readonly video: () => object | null;
}

const displayMediaRequestSchema = z.object({
  frame: z.object({ processId: z.number(), routingId: z.number() }),
});
const webContentsSchema = z.object({ id: z.number() });

const registrations = new Map<string, RecordingHelperRegistration>();

/**
 * Admits one helper window for one guest. The returned disposer is idempotent
 * and revokes the grant; every terminal path in
 * `recording-helper-window.ts` runs it, which is what makes "the grant is
 * revoked on stop, on guest destruction and on session close" one line rather
 * than three.
 */
export function registerRecordingHelper(
  registration: RecordingHelperRegistration,
): () => void {
  registrations.set(registration.recordingId, registration);
  return () => {
    if (registrations.get(registration.recordingId) !== registration) return;
    registrations.delete(registration.recordingId);
  };
}

/**
 * Is this the `WebContents` of a live recording helper window?
 *
 * The `display-capture` permission test, and nothing wider: a guest page that
 * asks for it is still refused, and the static
 * `BROWSER_ALLOWED_PERMISSIONS` set is deliberately not grown, because a
 * member of that set is granted to EVERY guest.
 */
export function isRecordingHelperWebContents(webContents: unknown): boolean {
  const parsed = webContentsSchema.safeParse(webContents);
  if (!parsed.success) return false;
  for (const registration of registrations.values()) {
    if (registration.helperWebContentsId === parsed.data.id) return true;
  }
  return false;
}

/**
 * The video source this display-media request may have, or `null` for "deny".
 *
 * `null` is the answer for everything that is not a registered helper's own
 * main frame - every ordinary guest page, a helper whose registration has been
 * revoked, and a request whose shape this build does not recognise.
 */
export function resolveRecordingDisplayMediaVideo(
  request: unknown,
): object | null {
  const parsed = displayMediaRequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { processId, routingId } = parsed.data.frame;
  for (const registration of registrations.values()) {
    const frame = registration.helperFrame();
    if (
      frame === null ||
      frame.processId !== processId ||
      frame.routingId !== routingId
    ) {
      continue;
    }
    return registration.video();
  }
  return null;
}

/** Test-only: the registry is module-global and outlives one suite's windows. */
export function recordingHelperRegistrationCount(): number {
  return registrations.size;
}
