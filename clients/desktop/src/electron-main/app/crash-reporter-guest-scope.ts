/**
 * The egress policy for `@sentry/electron`'s native crash channel, and the
 * scrubbing hooks for everything else the main process sends.
 *
 * ## No renderer minidump ever uploads
 *
 * `sentryMinidumpIntegration` (the SDK's first default integration) takes one
 * option - `maxMinidumpsPerSession` - and nothing else. It registers a single
 * process-wide `app.on('render-process-gone')` handler and calls
 * `sendNativeCrashes`, which loads *every* pending dump from the crashpad
 * directory - completed and pending, whoever wrote them - and captures each
 * one with the event built from the `WebContents` of the crash that just
 * fired. So a browser guest's dump sitting on disk when the app shell
 * crashes uploads under the app shell's identity.
 *
 * Per-dump attribution would be the way out, and it does not exist: the only
 * per-dump fact the SDK has is the crashpad `process_type` annotation, which
 * says `renderer` and never which renderer. `getRendererName(contents)` is
 * handed the currently crashed contents, not the dump's, so it cannot tell
 * the two apart either - which is why this module no longer registers app
 * shell renderers at all.
 *
 * A browser guest renderer is the process that decrypted the cookie jar. Its
 * minidump is that process's heap: cookie values in the clear, the live DOM,
 * localStorage, anything typed into a form. Since a renderer dump cannot be
 * proven to be ours, none of them go. `browser`, `gpu` and `utility` dumps
 * still upload - no guest page memory ever lived in those processes - and the
 * app shell's own JavaScript errors still report in full through the renderer
 * SDK (`renderer-shell/main.tsx`), which is where its crashes are actionable
 * anyway.
 *
 * Deliberately not keyed on the URL: `crashed_url` is page-controlled text.
 */

import {
  type DesktopSentryBreadcrumb,
  type DesktopSentryEvent,
  type DesktopSentrySpan,
  type DesktopSentryTransaction,
  scrubDesktopBreadcrumbInPlace,
  scrubDesktopSentryEventInPlace,
  scrubDesktopSentrySpanInPlace,
  scrubDesktopSentryTransactionInPlace,
} from "../../shared/sentry-scrub";

/** The slice of the event hint this module reads. The dump rides here. */
export interface DesktopSentryEventHint {
  attachments?: readonly { readonly filename?: unknown }[] | undefined;
}

/** Non-renderer processes: none of them ever held decrypted jar memory. */
const NON_RENDERER_PROCESSES = new Set(["browser", "gpu", "utility"]);

/**
 * Whether the event would carry process memory off the machine. Three
 * independent markers, any one of which is enough: the `native` platform and
 * the `event.environment` tag, both stamped by `sentryMinidumpIntegration` on
 * every event it produces, and a `.dmp` attachment on the hint - the dump
 * itself, checked so that an SDK version that stops stamping either marker
 * cannot silently reopen the channel. Each marker only ever adds drops, so
 * over-matching costs a crash report and never a leaked jar. A JavaScript
 * error event has none of the three and is never in scope here.
 */
function carriesMinidump(
  event: DesktopSentryEvent,
  hint: DesktopSentryEventHint,
): boolean {
  if (event.platform === "native") return true;
  if (event.tags?.["event.environment"] === "native") return true;
  return (hint.attachments ?? []).some(
    (attachment) =>
      typeof attachment.filename === "string" &&
      attachment.filename.endsWith(".dmp"),
  );
}

/**
 * True for a minidump-bearing event that is not one of the three processes
 * that never hosted a guest page. Every renderer dump - ours, a guest's, or
 * the `renderer`/`unknown` of a dump found at startup - goes.
 */
export function shouldDropNativeCrashEvent(
  event: DesktopSentryEvent,
  hint: DesktopSentryEventHint,
): boolean {
  if (!carriesMinidump(event, hint)) return false;
  const process = event.tags?.["event.process"];
  return typeof process !== "string" || !NON_RENDERER_PROCESSES.has(process);
}

/**
 * `beforeSend` for the desktop main process: the minidump drop, then the
 * shared Sentry scrub (`shared/sentry-scrub.ts`), which the app-shell
 * renderer runs too and which detects through the same
 * `@traycer/protocol/utils/text/redaction` leaf the services use.
 */
export function desktopSentryBeforeSend<TEvent extends DesktopSentryEvent>(
  event: TEvent,
  hint: DesktopSentryEventHint,
): TEvent | null {
  if (shouldDropNativeCrashEvent(event, hint)) return null;
  scrubDesktopSentryEventInPlace(event);
  return event;
}

/**
 * `beforeBreadcrumb` for the desktop main process. Scrubbing at record time
 * and not only at send time is what matters here: breadcrumbs are persisted
 * to `scope_v3.json` as they accumulate, and a native crash event is
 * assembled from *that persisted scope* on the next launch - so a URL only
 * cleaned in `beforeSend` would already be on disk, and would ride out
 * attached to a crash from a later, unrelated run.
 */
export function desktopSentryBeforeBreadcrumb<
  TBreadcrumb extends DesktopSentryBreadcrumb,
>(breadcrumb: TBreadcrumb): TBreadcrumb {
  scrubDesktopBreadcrumbInPlace(breadcrumb);
  return breadcrumb;
}

/** `beforeSendTransaction`: `beforeSend` never sees a transaction. */
export function desktopSentryBeforeSendTransaction<
  TEvent extends DesktopSentryTransaction,
>(event: TEvent): TEvent {
  scrubDesktopSentryTransactionInPlace(event);
  return event;
}

/** `beforeSendSpan`: child spans travel outside the transaction event. */
export function desktopSentryBeforeSendSpan<TSpan extends DesktopSentrySpan>(
  span: TSpan,
): TSpan {
  scrubDesktopSentrySpanInPlace(span);
  return span;
}
