/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function source(relativePath: string): string {
  return readFileSync(path.join(srcDir, relativePath), "utf8");
}

/**
 * The scope's seat, which no test can mount: the app's whole runtime sits
 * between it and its readers. The palette renders beside the provider's
 * children and the Settings modal under the router, both outside `AppShell`, so
 * a scope any lower hides the collapse row from them while the strip offers it.
 */
describe("MobileStripFormScope's seat", () => {
  it("wraps the command palette and the routes in the runtime", () => {
    const app = source("traycer-app.tsx");
    const seat = app.indexOf("<MobileStripFormScope>");

    expect(seat).toBeGreaterThan(-1);
    expect(seat).toBeLessThan(app.indexOf("<CommandPaletteProvider"));
    expect(seat).toBeLessThan(app.indexOf("<TraycerAppRuntimeSurface"));
    expect(app.indexOf("</MobileStripFormScope>")).toBeGreaterThan(
      app.indexOf("</CommandPaletteProvider>"),
    );
  });

  it("is mounted once, so every reader shares one measurement", () => {
    expect(source("components/layout/app-shell.tsx")).not.toContain(
      "MobileStripFormScope",
    );
    expect(source("routes/root-route-components.tsx")).not.toContain(
      "MobileStripFormScope",
    );
  });
});
