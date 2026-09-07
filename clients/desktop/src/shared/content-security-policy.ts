/** Byte-identical CSP for the session header and the renderer meta tag. Vite loads this outside Electron, so imports stay electron-free and relative. */
import {
  DEV_AUTHN_BASE_URL_ENV,
  devBackendUrlFromEnv,
} from "../../../shared/platform/dev-backend-urls";
import { config } from "../config";

export function devConnectSrcExtras(env: NodeJS.ProcessEnv): string {
  const origin = devBackendUrlFromEnv(
    config.environment,
    DEV_AUTHN_BASE_URL_ENV,
    "",
    env,
  );
  return origin.length === 0 ? "" : ` ${origin}`;
}

export function buildCspDirectives(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data: https: wss: ws: sentry-ipc: http://localhost:5173 ws://localhost:5173${devConnectSrcExtras(
      env,
    )}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}

export const CSP_DIRECTIVES = buildCspDirectives(process.env);

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");
