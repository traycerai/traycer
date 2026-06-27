import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "../app/logger";
import { parseAuthCallbackParams, type AuthCallbackHandler } from "./deep-link";

// The OS browser redirects here after sign-in. A fixed, well-known path keeps
// the redirect_uri stable across the dynamic port.
const CALLBACK_PATH = "/auth/callback";

export interface LoopbackCallbackServer {
  // `http://127.0.0.1:<port>/auth/callback` - the exact redirect_uri the
  // renderer hands the cloud sign-in page. The port is OS-assigned so it never
  // collides with a sibling process.
  readonly redirectUri: string;
  readonly close: () => void;
}

/**
 * Starts a long-lived loopback HTTP server that receives the OAuth callback for
 * the DEV desktop build.
 *
 * The dev build is unpackaged, so macOS LaunchServices won't register a custom
 * `traycer-dev://` scheme for it (and a shared `traycer://` is hijacked by any
 * installed staging/prod app). The RFC 8252 loopback-redirect pattern - the
 * same one the CLI uses (`traycer-cli/src/auth/login-flow.ts`) - sidesteps the
 * OS scheme registry entirely: the cloud redirects the browser to
 * `http://127.0.0.1:<port>/auth/callback?traycer-tokens=…`, this server parses
 * it, and hands the result to the SAME `deliverAuthCallback` path the deep-link
 * handler uses.
 *
 * Unlike the CLI's per-invocation server, this one stays up for the app's
 * lifetime: sign-in can be retried at any time, so each callback fires the
 * handler again rather than resolving a single promise.
 */
export async function startLoopbackCallbackServer(
  handler: AuthCallbackHandler,
): Promise<LoopbackCallbackServer> {
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      // A malformed request target must not throw out of this long-lived
      // main-process server callback (an uncaught throw would crash Electron).
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        log.warn("[auth] dev loopback callback rejected malformed request");
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const result = parseAuthCallbackParams(url.searchParams);
      const ok = !("error" in result);
      res.writeHead(ok ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(callbackHtml(ok));
      handler(result);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  log.info("[auth] dev loopback callback server listening", { redirectUri });

  return {
    redirectUri,
    close: () => {
      server.close();
    },
  };
}

// Minimal self-contained landing page. The renderer drives the real post-auth
// UX once the token reaches it; this is only what the OS browser shows.
function callbackHtml(success: boolean): string {
  const title = success ? "You're signed in" : "Sign-in failed";
  const body = success
    ? "You can close this window and return to Traycer."
    : "The redirect didn't include a valid sign-in token. Return to Traycer and try again.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traycer - ${title}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
      system-ui, sans-serif;
    background: #0a0a0a; color: #fafafa;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; text-align: center;
  }
  main { max-width: 420px; width: calc(100% - 32px); padding: 0 16px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.55; }
</style>
</head>
<body>
  <main role="status" aria-live="polite">
    <h1>${title}</h1>
    <p>${body}</p>
  </main>
  ${success ? "<script>setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);</script>" : ""}
</body>
</html>`;
}
