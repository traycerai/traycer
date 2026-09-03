import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLIENTS_ROOT = path.resolve(DESKTOP_SRC, "..", "..");
/** The renderer library is the fifth place these patterns used to live. */
const GUI_APP_SRC = path.resolve(CLIENTS_ROOT, "gui-app", "src");
/** The scrub policy now lives here, and the mobile shell is its third caller. */
const SHARED_ROOT = path.resolve(CLIENTS_ROOT, "shared");
const MOBILE_SRC = path.resolve(CLIENTS_ROOT, "mobile", "src");

/**
 * The scrub functions themselves are exercised in
 * `clients/shared/platform/__tests__/sentry-scrub.test.ts`. What stays here is
 * the desktop's WIRING of them, pinned at the source.
 */
describe("desktop Sentry scrub wiring", () => {
  /**
   * Ruling 3: the renderer used to install only the breadcrumb URL rewrite, so
   * every `exception.value` and console breadcrumb argument uploaded raw. The
   * hooks live in `Sentry.init`'s options object, which is why this is pinned
   * at the source rather than by driving the SDK.
   */
  it("wires both hooks into the renderer-shell Sentry init", async () => {
    const source = await fs.readFile(
      path.join(DESKTOP_SRC, "renderer-shell", "main.tsx"),
      "utf8",
    );
    expect(source).toContain("scrubSentryEventInPlace(event)");
    expect(source).toContain("scrubSentryBreadcrumbInPlace(breadcrumb)");
  });

  /**
   * Ruling 5: the detection set is a security control and must not differ by
   * call site. Every client redaction path reaches
   * `@traycer/protocol/utils/text/redaction`; a module that declares a
   * credential pattern of its own has, by definition, forked the set.
   */
  it("declares no credential pattern outside the shared leaf", async () => {
    const offenders: string[] = [];
    const stack = [DESKTOP_SRC, GUI_APP_SRC, SHARED_ROOT, MOBILE_SRC];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = await fs.readFile(full, "utf8");
        if (
          /\b(?:SENSITIVE_(?:KEY|QUERY_PARAM|INLINE_VALUE)_PATTERN|BEARER_PATTERN|BASIC_AUTH_PATTERN|TOKEN_SHAPE_PATTERN|SESSION_COOKIE_PATTERN|COOKIE_HEADER_PATTERN|AUTHORIZATION_HEADER_PATTERN)\s*=/.test(
            source,
          )
        ) {
          offenders.push(full);
        }
      }
    }
    expect(
      offenders,
      `these modules define their own credential patterns instead of importing @traycer/protocol/utils/text/redaction:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
