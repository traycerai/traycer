// Why this exists: desktop and mobile type-check against gui-app's emitted
// declarations (tsconfig.compile.json), not its source. A compile script moved
// back to tsconfig.json still passes and silently re-checks all of gui-app
// (3.33 GB again); a drifted path mapping already fails loudly with TS2307.
// The pieces below pin the parts that fail silently: the step order, the
// declarations output living inside the Nx-cached dir, and `paths` (which in
// an extending config REPLACES the base map) staying in sync with tsconfig.json.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TRAYCER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUI_APP = join(TRAYCER_ROOT, "clients/gui-app");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const guiPackage = readJson(join(GUI_APP, "package.json"));
const outputsDir = resolve(
  GUI_APP,
  guiPackage.nx.targets.compile.outputs[0].replace("{projectRoot}/", ""),
);

function showConfig() {
  const result = spawnSync(
    join(TRAYCER_ROOT, "node_modules/.bin/tsgo"),
    ["-p", "clients/gui-app/tsconfig.declarations.json", "--showConfig"],
    { cwd: TRAYCER_ROOT, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function isInside(dir, path) {
  const rel = relative(dir, path);
  return !rel.startsWith("..") && !rel.startsWith("/");
}

describe("gui-app declarations boundary", () => {
  it("runs the declarations step after the app check, joined by &&", () => {
    const compile = guiPackage.scripts.compile;
    const check = compile.indexOf("tsgo -p tsconfig.app.json");
    const declarations = compile.indexOf("tsgo -p tsconfig.declarations.json");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(declarations).toBeGreaterThan(check);
    expect(compile.slice(check, declarations)).toContain("&&");
  });

  describe("resolved declarations config", () => {
    const resolved = showConfig();
    const options = resolved.compilerOptions;

    it("emits declarations only, without checking", () => {
      expect(options.emitDeclarationOnly).toBe(true);
      expect(options.declaration).toBe(true);
      expect(options.noCheck).toBe(true);
    });

    it("writes declarations and build info inside the Nx output dir", () => {
      for (const key of ["declarationDir", "tsBuildInfoFile"]) {
        const path = resolve(GUI_APP, options[key]);
        expect(isInside(outputsDir, path), `${key}: ${path}`).toBe(true);
      }
    });

    it("includes the entry points and no test files", () => {
      const files = resolved.files.map((file) => resolve(GUI_APP, file));
      expect(files).toContain(join(GUI_APP, "src/traycer-app.tsx"));
      expect(files).toContain(join(GUI_APP, "index.ts"));
      const tests = files.filter((file) =>
        /\/__tests__\/|\.test\.|\.spec\./.test(file),
      );
      expect(tests).toEqual([]);
    });
  });

  it("keeps the declarations config out of tsconfig.json references", () => {
    const paths = readJson(join(GUI_APP, "tsconfig.json")).references.map(
      (ref) => ref.path,
    );
    expect(paths.some((p) => p.includes("tsconfig.declarations"))).toBe(false);
  });
});

const declarationDir = join(outputsDir, "clients/gui-app");

describe.each([
  {
    name: "desktop",
    aliases: {
      "@traycer-clients/gui-app": join(declarationDir, "index.d.ts"),
      "@/*": join(declarationDir, "src/*"),
    },
  },
  {
    name: "mobile",
    aliases: {
      "@traycer-clients/gui-app": join(declarationDir, "index.d.ts"),
      "@traycer-clients/gui-app/*": join(declarationDir, "*"),
      "@/*": join(declarationDir, "src/*"),
    },
  },
])("$name compile config", ({ name, aliases }) => {
  const dir = join(TRAYCER_ROOT, "clients", name);
  const compileConfig = readJson(join(dir, "tsconfig.compile.json"));
  const basePaths = readJson(join(dir, "tsconfig.json")).compilerOptions.paths;
  const paths = compileConfig.compilerOptions.paths;

  it("is what the compile script type-checks", () => {
    expect(readJson(join(dir, "package.json")).scripts.compile).toContain(
      "-p tsconfig.compile.json",
    );
    expect(compileConfig.extends).toBe("./tsconfig.json");
  });

  it("maps gui-app onto the emitted declarations", () => {
    for (const [alias, target] of Object.entries(aliases)) {
      expect(paths[alias], alias).toHaveLength(1);
      expect(resolve(dir, paths[alias][0]), alias).toBe(target);
    }
  });

  it("leaves every other alias identical to tsconfig.json", () => {
    const others = (map) =>
      Object.fromEntries(
        Object.entries(map).filter(([alias]) => !(alias in aliases)),
      );
    expect(others(paths)).toEqual(others(basePaths));
    expect(Object.keys(paths).sort()).toEqual(Object.keys(basePaths).sort());
  });
});
