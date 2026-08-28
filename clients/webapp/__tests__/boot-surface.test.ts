import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The boot surface is markup, not a component, so nothing type-checks the
 * agreement between the HTML that declares it and the module that retires it.
 * These are the two halves of that agreement.
 *
 * It exists because this shell renders nothing until the app bundle has loaded
 * AND the sign-in handoff has settled - a network round trip whose worst case
 * is tens of seconds. Deleting it would not fail a test that mounts the app;
 * it would simply return the blank page it was added to remove.
 */
const WEBAPP_ROOT = join(__dirname, "..");

const indexHtml = readFileSync(join(WEBAPP_ROOT, "index.html"), "utf8");
const mainTsx = readFileSync(join(WEBAPP_ROOT, "src", "main.tsx"), "utf8");

describe("boot surface", () => {
  it("is served in the HTML itself, before the app container", () => {
    const surface = indexHtml.indexOf('id="boot-surface"');
    const root = indexHtml.indexOf('id="root"');

    // Before, and OUTSIDE, the container React takes over: it has to be
    // painted from the first byte of HTML, with no bundle and no stylesheet.
    expect(surface).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(-1);
    expect(surface).toBeLessThan(root);
    expect(indexHtml).toContain("<style>");
  });

  it("says who is asking and what is happening", () => {
    expect(indexHtml).toContain("Traycer");
    expect(indexHtml).toContain("Signing you in");
  });

  it("holds still for a visitor who asked for no motion", () => {
    expect(indexHtml).toContain("prefers-reduced-motion");
  });

  it("is retired by the same id the markup declares", () => {
    // A rename on one side and not the other leaves the splash painted over a
    // mounted app - which no rendering test would catch, because the app under
    // it renders perfectly.
    expect(mainTsx).toContain('getElementById("boot-surface")');
    expect(mainTsx).toContain("remove()");
  });
});
