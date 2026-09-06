import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: true }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));

const ENTRY = join(import.meta.dirname, "..", "src", "web", "main.tsx");
const POLICY = join(
  import.meta.dirname,
  "..",
  "src",
  "web",
  "single-context-tabs.ts",
);

function importedSpecifiersInOrder(source: string): string[] {
  return Array.from(source.matchAll(/^import\s[^;]*?["']([^"']+)["'];$/gm)).map(
    (match) => match[1],
  );
}

/**
 * Re-evaluates the policy module and reads the answer off the SAME module
 * instance it wrote to.
 *
 * `resetModules` hands the re-import a fresh copy of the whole graph, so a
 * reading import taken at the top of this file would be a different instance
 * and would report the default no matter what the entry decided - green, and
 * about nothing.
 */
async function evaluatePolicy(): Promise<boolean> {
  vi.resetModules();
  await import("../src/web/single-context-tabs");
  const policy = await import("@/stores/tabs/tabs-local-restore-policy");
  return policy.isTabsLocalRestoreEnabled();
}

describe("mobile entry tab-restore policy", () => {
  afterEach(() => {
    platform.native = true;
  });

  it("keeps the restore on an installed app", async () => {
    platform.native = true;

    // One webview, one origin, alone on the screen: a cold launch coming back
    // to the arrangement it was left in is what a person expects here, and
    // suppressing it would be a regression rather than a fix.
    expect(await evaluatePolicy()).toBe(true);
  });

  it("suppresses the restore when the same bundle is a browser tab", async () => {
    platform.native = false;

    // Same bundle, different surroundings: the contexts come from the tab bar,
    // and a per-ORIGIN layout would hand a freshly opened tab the surface of a
    // different one.
    expect(await evaluatePolicy()).toBe(false);
  });
});

describe("mobile entry import order", () => {
  it("states the tab-restore policy before anything else", () => {
    const specifiers = importedSpecifiersInOrder(readFileSync(ENTRY, "utf8"));

    // Sanity: the parse found the entry's imports at all, so a regex that
    // silently matched nothing cannot pass as "it is first".
    expect(specifiers.length).toBeGreaterThan(3);
    expect(specifiers[0]).toBe("./single-context-tabs");
  });

  it("reaches nothing but a leaf before it decides", () => {
    const specifiers = importedSpecifiersInOrder(readFileSync(POLICY, "utf8"));

    // The decision is only early enough if what it imports cannot itself pull
    // the tab store in first. `@capacitor/core` depends on `tslib` alone, and
    // the policy module it writes to imports nothing at all - so this list is
    // the guarantee, and anything added to it has to be checked the same way.
    expect(specifiers).toEqual([
      "@capacitor/core",
      "@/stores/tabs/tabs-local-restore-policy",
    ]);
  });
});
