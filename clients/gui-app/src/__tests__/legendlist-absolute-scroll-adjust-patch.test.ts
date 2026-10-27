import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `patches/@legendapp%2Flist@<version>.patch` makes the web build's scroll
 * adjustments absolute writes. iOS WebKit applies a relative `scrollBy` twice
 * (the synchronous move, then the same delta again on the next scroll event),
 * so every `maintainVisibleContentPosition` compensation issued while a row
 * above the viewport is measured during a touch fling landed doubled, and the
 * library re-requested it: a flick through the chat transcript on the phone
 * bounced by whole screens. An absolute `scrollTo` lands once on every engine.
 *
 * `patchedDependencies` is keyed by the exact package version, so a bump of
 * the list silently drops the patch. This reads the installed web build, not
 * the patch file, so what it certifies is the code the renderer loads.
 */
describe("@legendapp/list absolute scroll-adjust patch", () => {
  const require = createRequire(import.meta.url);
  // The package's `exports` map hides `package.json` and has no main entry;
  // every entry point sits in the package root, so a subpath's directory is
  // that root.
  const packageDir = dirname(require.resolve("@legendapp/list/react"));

  // `react.*` is the `@legendapp/list/react` entry the chat timeline imports;
  // the `react-native.web.*` pair carries the same code for the other entry.
  for (const file of [
    "react.js",
    "react.mjs",
    "react-native.web.js",
    "react-native.web.mjs",
  ]) {
    it(`${file} writes the scroll adjustment as an absolute offset`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        'el.scrollTo({ behavior: "auto", left: el.scrollLeft + left, top: el.scrollTop + top });',
      );
      expect(source).not.toContain(
        'el.scrollBy({ behavior: "auto", left, top });',
      );
      expect(source).not.toContain(
        'target.scrollBy({ behavior: "auto", left: x, top: y });',
      );
    });
  }
});
