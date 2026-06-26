import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { platform as osPlatform } from "node:os";
import { AddressInfo } from "node:net";
import {
  exchangeCodeForTokens,
  validateAuthTokenViaHttp,
} from "../../../shared/auth/auth-validation";
import {
  CODE_CHALLENGE_METHOD,
  deriveCodeChallenge,
  generateCodeVerifier,
} from "../../../shared/auth/pkce";
import { writeCredentials } from "../store/credentials";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";

const CALLBACK_PATH = "/callback";
const CODE_QUERY_PARAM = "code";
const STATE_QUERY_PARAM = "state";
const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

// Browser landing page rendered after the OAuth redirect lands on our
// loopback handler. Modeled on the post-auth screens of gh / gcloud /
// claude: centered card, single-color accent, light + dark mode, subtle
// pop-in for the status icon, best-effort `window.close()`. Everything
// is inlined so the page is self-contained.
function callbackHtml(
  variant: "success" | "error",
  message: string,
): string {
  const success = variant === "success";
  const title = success ? "You're signed in" : "Sign-in failed";
  const icon = success
    ? '<polyline points="20 6 9 17 4 12"></polyline>'
    : '<line x1="6" y1="6" x2="18" y2="18"></line><line x1="6" y1="18" x2="18" y2="6"></line>';
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traycer CLI - ${title}</title>
<style>
  :root {
    --bg: #fafafa;
    --fg: #0a0a0a;
    --muted: #6b7280;
    --card: #ffffff;
    --border: rgba(0, 0, 0, 0.06);
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.04);
    --success-bg: rgba(22, 163, 74, 0.1);
    --success-fg: #16a34a;
    --error-bg: rgba(220, 38, 38, 0.1);
    --error-fg: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a;
      --fg: #fafafa;
      --muted: #9ca3af;
      --card: #111111;
      --border: rgba(255, 255, 255, 0.08);
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.3);
      --success-bg: rgba(34, 197, 94, 0.15);
      --success-fg: #4ade80;
      --error-bg: rgba(239, 68, 68, 0.15);
      --error-fg: #f87171;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
      system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 48px 40px 40px;
    max-width: 420px;
    width: calc(100% - 32px);
    text-align: center;
    box-shadow: var(--shadow);
    animation: fade 0.25s ease-out;
  }
  .icon {
    width: 56px;
    height: 56px;
    margin: 0 auto 24px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--success-bg);
    color: var(--success-fg);
  }
  .icon.error {
    background: var(--error-bg);
    color: var(--error-fg);
  }
  .icon svg {
    width: 28px;
    height: 28px;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    animation: pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
  }
  p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
  }
  .brand {
    display: block;
    margin-top: 28px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  @keyframes fade {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pop {
    from { transform: scale(0.4); opacity: 0; }
    to   { transform: scale(1);   opacity: 1; }
  }
</style>
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    <div class="icon${success ? "" : " error"}" aria-hidden="true">
      <svg viewBox="0 0 24 24">${icon}</svg>
    </div>
    <h1>${title}</h1>
    <p>${safeMessage}</p>
    <span class="brand">Traycer CLI</span>
  </main>
  ${success ? '<script>setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);</script>' : ""}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface LoginSuccess {
  readonly token: string;
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly authnBaseUrl: string;
}

export async function runLoginFlow(): Promise<LoginSuccess> {
  const logger = createCliLogger(config.environment);
  const { authnBaseUrl, cloudUiBaseUrl } = config;
  logger.info("Login flow started", {
    environment: config.environment,
    platform: osPlatform(),
  });
  // PKCE (RFC 7636): the verifier stays in this process; only its S256
  // challenge goes to cloud-ui, which issues a one-time `code` (not tokens) in
  // the redirect. A sibling process that races the loopback callback gets a
  // code it can't redeem without the verifier. `state` still binds the callback
  // to this in-flight call.
  const state = randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  const { port, server, waitForCallback } = await startCallbackServer(
    state,
    logger,
  );
  logger.info("Login callback server started", {
    environment: config.environment,
    port,
  });
  // State has to live INSIDE the redirect_uri's query string, not as a
  // top-level param on the cloud-ui URL. The Traycer web UI's callback page
  // builds the final redirect via
  // `new URL(redirect_uri); url.searchParams.set("code", …)`, which preserves
  // anything already in redirect_uri's query but ignores unrelated params on
  // the cloud-ui URL.
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}?state=${encodeURIComponent(state)}`;
  const signInUrl =
    `${cloudUiBaseUrl}?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=${CODE_CHALLENGE_METHOD}`;

  // Runtime discipline (see runner/output.ts): stdout is reserved for
  // NDJSON envelopes (`--json` mode) or the terminal human result;
  // stderr carries progress + side info + errors. The browser-prompt
  // lines are informational, not the command's result - they belong on
  // stderr so `--json` consumers keep a clean NDJSON stream and human
  // callers piping stdout still see only the final "Signed in as …".
  process.stderr.write(`Opening browser to sign in: ${signInUrl}\n`);
  process.stderr.write(
    `If the browser does not open, paste the URL above manually.\n`,
  );
  openInBrowser(signInUrl);

  let code: string;
  try {
    ({ code } = await waitForCallback());
    logger.info("Login callback received authorization code", {
      environment: config.environment,
      hasCode: code.length > 0,
    });
  } finally {
    server.close();
    logger.debug("Login callback server closed", {
      environment: config.environment,
    });
  }

  // Exchange the one-time code (+ our verifier) for the token pair.
  const exchange = await exchangeCodeForTokens(
    authnBaseUrl,
    code,
    codeVerifier,
  );
  if (exchange.kind !== "exchanged") {
    logger.warn("Login code exchange failed", {
      environment: config.environment,
      outcome: exchange.kind,
    });
    throw new Error(
      exchange.kind === "rejected"
        ? "Sign-in succeeded but the authorization code could not be exchanged."
        : "Sign-in succeeded but the authn service is unreachable.",
    );
  }
  logger.info("Login code exchange succeeded", {
    environment: config.environment,
    hasToken: exchange.token.length > 0,
    hasRefreshToken: exchange.refreshToken.length > 0,
  });
  const token = exchange.token;
  const refreshToken = exchange.refreshToken;

  const validation = await validateAuthTokenViaHttp(
    authnBaseUrl,
    token,
    refreshToken,
  );
  if (validation.kind !== "valid") {
    logger.warn("Login token validation failed", {
      environment: config.environment,
      outcome: validation.kind,
    });
    throw new Error(
      validation.kind === "rejected"
        ? "Sign-in succeeded but the token was rejected by the authn service."
        : "Sign-in succeeded but the authn service is unreachable.",
    );
  }
  // The auth-validation helper may rotate both tokens once on a stale lookup;
  // honor the refreshed values if present so the stored credential matches
  // what the server now considers current.
  const finalToken =
    "refreshedToken" in validation ? validation.refreshedToken : token;
  const finalRefreshToken =
    "refreshedRefreshToken" in validation
      ? validation.refreshedRefreshToken
      : refreshToken;

  const creds: LoginSuccess = {
    token: finalToken,
    user: {
      id: validation.profile.userId,
      email: validation.profile.email,
      name: validation.profile.userName,
    },
    authnBaseUrl,
  };
  await writeCredentials({
    token: creds.token,
    refreshToken: finalRefreshToken,
    authnBaseUrl,
    savedAt: new Date().toISOString(),
    user: creds.user,
  });
  logger.info("Login credentials persisted", {
    environment: config.environment,
    tokenRotatedDuringValidation: finalToken !== token,
    refreshTokenRotatedDuringValidation: finalRefreshToken !== refreshToken,
  });
  return creds;
}

interface CallbackCode {
  readonly code: string;
}

interface CallbackServer {
  readonly port: number;
  readonly server: Server;
  readonly waitForCallback: () => Promise<CallbackCode>;
}

async function startCallbackServer(
  expectedState: string,
  logger: ILogger,
): Promise<CallbackServer> {
  let resolveToken: (result: CallbackCode) => void = () => {};
  let rejectToken: (err: Error) => void = () => {};
  const tokenPromise = new Promise<CallbackCode>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (url.pathname !== CALLBACK_PATH) {
      logger.warn("Login callback rejected unexpected path", {
        environment: config.environment,
        path: url.pathname,
      });
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const incomingState = url.searchParams.get(STATE_QUERY_PARAM);
    if (incomingState !== expectedState) {
      logger.warn("Login callback rejected state mismatch", {
        environment: config.environment,
        hasState: incomingState !== null,
      });
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackHtml(
          "error",
          "The callback didn't match the in-flight sign-in session. Re-run the command and try again.",
        ),
      );
      rejectToken(new Error("auth callback: state mismatch"));
      return;
    }
    // A genuine provider rejection (user deny, consent error, …) comes back as
    // `?error=...`. Surface it directly instead of collapsing it into the
    // generic "missing code" message, which is reserved for a broken redirect.
    const oauthError = url.searchParams.get("error");
    if (oauthError !== null && oauthError.length > 0) {
      const description = url.searchParams.get("error_description");
      logger.warn("Login callback received OAuth error", {
        environment: config.environment,
        oauthError,
        hasDescription: description !== null && description.length > 0,
      });
      const detail =
        description !== null && description.length > 0
          ? `${oauthError}: ${description}`
          : oauthError;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackHtml(
          "error",
          `Sign-in was not completed (${detail}). Re-run the command and try again.`,
        ),
      );
      rejectToken(new Error(`auth callback: ${detail}`));
      return;
    }
    const code = url.searchParams.get(CODE_QUERY_PARAM);
    if (code === null || code.length === 0) {
      logger.warn("Login callback missing authorization code", {
        environment: config.environment,
      });
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackHtml(
          "error",
          "The redirect didn't include an authorization code. Re-run the command and try again.",
        ),
      );
      rejectToken(new Error("auth callback: missing code"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    logger.info("Login callback accepted", {
      environment: config.environment,
      hasCode: true,
    });
    res.end(
      callbackHtml("success", "You can close this window and return to your terminal."),
    );
    resolveToken({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  const waitForCallback = (): Promise<CallbackCode> =>
    new Promise<CallbackCode>((resolve, reject) => {
      const timer = setTimeout(() => {
        rejectToken(
          new Error(
            `login timed out after ${LOGIN_TIMEOUT_MS / 1000}s - re-run \`traycer login\` to try again.`,
          ),
        );
      }, LOGIN_TIMEOUT_MS);
      tokenPromise.then(
        (tokens) => {
          clearTimeout(timer);
          resolve(tokens);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

  return { port: address.port, server, waitForCallback };
}

function openInBrowser(url: string): void {
  const plat = osPlatform();
  const { cmd, args } =
    plat === "darwin"
      ? { cmd: "open", args: [url] }
      : plat === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };
  const notify = (): void => {
    process.stderr.write(
      "Couldn't open browser automatically - please open the URL above manually.\n",
    );
  };
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", notify);
    child.unref();
  } catch {
    notify();
  }
}
