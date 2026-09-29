/// <reference types="node" />

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `@lobehub/ui` pins `@base-ui/react` to an EXACT `1.6.0`, incompatible with
 * gui-app's own `1.8.0` pin. Resolving through Node's own require (rooted at
 * gui-app's package.json, exactly what an import inside gui-app sees) rather
 * than reading the lockfile catches a stale or mis-hoisted `node_modules`
 * symlink that a lockfile-only assertion cannot.
 */
const GUI_APP_PACKAGE_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);

describe("@base-ui/react version resolution", () => {
  it("resolves the package gui-app actually installs to 1.8.0", () => {
    const requireFromGuiApp = createRequire(GUI_APP_PACKAGE_JSON);
    const resolvedPackageJson = requireFromGuiApp.resolve(
      "@base-ui/react/package.json",
    );
    const installedVersion = (
      JSON.parse(readFileSync(resolvedPackageJson, "utf8")) as {
        version: string;
      }
    ).version;

    expect(installedVersion).toBe("1.8.0");
  });
});
