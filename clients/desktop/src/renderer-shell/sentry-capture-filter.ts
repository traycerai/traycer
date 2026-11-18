/**
 * The one renderer error the desktop app-shell Sentry init refuses to report.
 *
 * Releasing a browser guest ends with `sheetClipper.remove()` in
 * `persistent-browser-guest-host.ts`, which disconnects the guest's
 * `<webview>`. Electron's own `WebViewElement.disconnectedCallback` then makes
 * a synchronous IPC call to main to detach the guest, and destructures the
 * reply (`const [error, result] = sendSync(...)`). When the reply comes back
 * `null` the destructuring throws `object null is not iterable`.
 *
 * Nothing is lost when it does. The throw is Electron's, raised inside a
 * custom-element callback, so the browser reports it to `window.onerror`
 * instead of throwing it out of `remove()`: the DOM removal still completes,
 * and every other step of the release has already run, because `remove()` is
 * its last statement. The `<webview>` is discarded either way, so there is no
 * site of ours left to guard.
 */

/** The slice of a Sentry error event this filter reads. */
export interface RendererSentryErrorEvent {
  exception?:
    | {
        values?:
          | {
              value?: string | undefined;
              stacktrace?:
                | {
                    frames?:
                      | {
                          filename?: string | undefined;
                          function?: string | undefined;
                        }[]
                      | undefined;
                  }
                | undefined;
            }[]
          | undefined;
      }
    | undefined;
}

const NULL_SYNC_REPLY_MESSAGE = "object null is not iterable";
const ELECTRON_BUNDLE_PREFIX = "node:electron/js2c/";
const WEBVIEW_DETACH_FUNCTION = "WebViewElement.disconnectedCallback";

/**
 * True for exactly that error: the message of a destructured `null` and an
 * innermost frame inside Electron's own webview disconnect callback. Sentry
 * orders frames oldest call first, so the throw site is the last one. Any
 * other `object null is not iterable` - ours included - still reports.
 */
export function isElectronWebviewDetachNoise(
  event: RendererSentryErrorEvent,
): boolean {
  const values = event.exception?.values;
  if (values === undefined || values.length !== 1) return false;
  const [exception] = values;
  if (exception === undefined) return false;
  if (!exception.value?.startsWith(NULL_SYNC_REPLY_MESSAGE)) return false;
  const frames = exception.stacktrace?.frames;
  const thrownAt = frames?.[frames.length - 1];
  return (
    thrownAt?.function === WEBVIEW_DETACH_FUNCTION &&
    thrownAt.filename?.startsWith(ELECTRON_BUNDLE_PREFIX) === true
  );
}
