import { app } from "electron";
import { config, DESKTOP_PROTOCOL_SCHEME } from "../../config";
import { log } from "../app/logger";
import {
  devDesktopSlotForEnvironment,
  devDesktopSlotProtocolScheme,
} from "../host/dev-desktop-slot";

// Environment-specific so a dev build doesn't share `traycer://` with an installed staging/prod app (see `DESKTOP_PROTOCOL_SCHEME`), and slot-specific under multi-run dev so.
// The renderer derives the matching redirect URI in `renderer-shell/sign-in-url.ts`; the two MUST agree or the cloud's redirect lands on a scheme nobody registered.
const PROTOCOL_SCHEME = devDesktopSlotProtocolScheme(
  DESKTOP_PROTOCOL_SCHEME,
  devDesktopSlotForEnvironment(config.environment, process.env),
);
const AUTH_CALLBACK_PATH = "auth/callback";

/** Login still completes poll-only if it never fires. */
export type AuthReturnSignalHandler = () => void;

/** A stray legacy `?code=…` is tolerated - we never read it. */
function isAuthCallbackUri(uri: string): boolean {
  if (!uri.startsWith(`${PROTOCOL_SCHEME}://`)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const path = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return path === AUTH_CALLBACK_PATH;
}

export function registerDeepLinkHandling(
  handler: AuthReturnSignalHandler,
): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        process.argv[1],
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  const deliver = (uri: string): void => {
    if (!isAuthCallbackUri(uri)) {
      return;
    }
    log.info("[deep-link] auth return signal - nudging the device poll");
    handler();
  };

  app.on("open-url", (event, url) => {
    event.preventDefault();
    log.info("[deep-link] open-url", { url: redactDeepLinkUrl(url) });
    deliver(url);
  });

  app.on("second-instance", (_event, argv) => {
    const url = findTraycerUrlInArgv(argv);
    if (url !== null) {
      log.info("[deep-link] second-instance", { url: redactDeepLinkUrl(url) });
      deliver(url);
    }
  });

  const initial = findTraycerUrlInArgv(process.argv);
  if (initial !== null) {
    log.info("[deep-link] initial argv contained deep link", {
      url: redactDeepLinkUrl(initial),
    });
    app.whenReady().then(() => deliver(initial));
  }
}

function redactDeepLinkUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<malformed>";
  }
}

function isTraycerUrl(value: string): boolean {
  return value.startsWith(`${PROTOCOL_SCHEME}://`);
}

function findTraycerUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (isTraycerUrl(arg)) {
      return arg;
    }
  }
  return null;
}

export { PROTOCOL_SCHEME };
