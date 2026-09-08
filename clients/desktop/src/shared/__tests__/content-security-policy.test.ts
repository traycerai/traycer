/**
 * The first test in the repo that pins the renderer's CSP.
 *
 * It asserts the WHOLE directive string, not the presence of one source, and
 * that is the point: the policy is applied as the intersection of a response
 * header and a `<meta>` tag, so a directive silently added, removed or
 * reordered in one place is exactly the failure mode this exists to catch. A
 * `toContain("media-src")` would pass while the rest of the policy drifted.
 *
 * Any change here is a deliberate widening or narrowing of what the renderer
 * may load. Update the literal AND say why in the module's own doc comment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCspDirectives,
  devConnectSrcExtras,
} from "../content-security-policy";

/** What a packaged build ships: no dev orchestrator, so no dev extras. */
const PACKAGED_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob: https: http://127.0.0.1:*",
  "media-src 'self' blob: https: http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https: wss: ws: sentry-ipc: http://127.0.0.1:* http://localhost:5173 ws://localhost:5173",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

const DEV_AUTHN_ORIGIN = "http://127.0.0.1:4180";

describe("buildCspDirectives", () => {
  it("is the packaged policy, directive for directive and in order", () => {
    expect(buildCspDirectives({})).toEqual(PACKAGED_DIRECTIVES);
  });

  it("admits only the dev authn origin on a dev-orchestrated run", () => {
    const directives = buildCspDirectives({
      TRAYCER_DEV_AUTHN_BASE_URL: DEV_AUTHN_ORIGIN,
    });
    expect(directives).toEqual(
      PACKAGED_DIRECTIVES.map((directive) =>
        directive.startsWith("connect-src ")
          ? `${directive} ${DEV_AUTHN_ORIGIN}`
          : directive,
      ),
    );
  });

  it("adds nothing when the dev override is absent or blank", () => {
    expect(devConnectSrcExtras({})).toBe("");
    expect(devConnectSrcExtras({ TRAYCER_DEV_AUTHN_BASE_URL: "  " })).toBe("");
  });

  it("keeps `<video>` off default-src", () => {
    // The regression this ticket exists for: with no `media-src` at all a
    // clip falls back to `default-src 'self'` and every remote (or loopback)
    // source is blocked, while `<img>` on the same bytes works.
    const mediaSrc = buildCspDirectives({}).find((directive) =>
      directive.startsWith("media-src "),
    );
    expect(mediaSrc).toBeDefined();
    expect(mediaSrc).toContain("https:");
    expect(mediaSrc).toContain("http://127.0.0.1:*");
  });
});

describe("the Capacitor shell's CSP meta", () => {
  /**
   * The mobile shell hosts the same gui-app bundle behind a `<meta>` tag it
   * maintains by hand, in a workspace that cannot import this module (its
   * index.html is a static asset, and this module's transitive imports are
   * Electron-build config). Read as TEXT and compared here, which is the one
   * place both copies are in reach - two hand-written policies with no test
   * between them is precisely how the header and the meta drifted before.
   */
  it("is the packaged desktop policy verbatim", () => {
    const html = readFileSync(
      path.resolve(__dirname, "../../../../mobile/src/web/index.html"),
      "utf8",
    );
    const match =
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(PACKAGED_DIRECTIVES.join("; "));
  });
});
