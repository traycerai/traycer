/**
 * Per-dump attribution would be the way out, and it does not exist: the only per-dump fact the SDK has is the crashpad `process_type` annotation, which says `renderer` and never.
 * `getRendererName(contents)` is handed the currently crashed contents, not the dump's, so it cannot tell the two apart either.
 */

import {
  type ClientSentryEvent,
  scrubSentryEventInPlace,
} from "@traycer-clients/shared/platform/sentry-scrub";

/** The slice of the event hint this module reads. The dump rides here. */
export interface DesktopSentryEventHint {
  attachments?: readonly { readonly filename?: unknown }[] | undefined;
}

/** Non-renderer processes: none of them ever held decrypted jar memory. */
const NON_RENDERER_PROCESSES = new Set(["browser", "gpu", "utility"]);

/**
 * Three independent markers, any one of which is enough: the `native` platform and the `event.environment` tag, both stamped by `sentryMinidumpIntegration` on every event it.
 * Each marker only ever adds drops, so over-matching costs a crash report and never a leaked jar.
 */
function carriesMinidump(
  event: ClientSentryEvent,
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

/** True for a minidump-bearing event that is not one of the three processes that never hosted a guest page. */
export function shouldDropNativeCrashEvent(
  event: ClientSentryEvent,
  hint: DesktopSentryEventHint,
): boolean {
  if (!carriesMinidump(event, hint)) return false;
  const process = event.tags?.["event.process"];
  return typeof process !== "string" || !NON_RENDERER_PROCESSES.has(process);
}

export function desktopSentryBeforeSend<TEvent extends ClientSentryEvent>(
  event: TEvent,
  hint: DesktopSentryEventHint,
): TEvent | null {
  if (shouldDropNativeCrashEvent(event, hint)) return null;
  scrubSentryEventInPlace(event);
  return event;
}
