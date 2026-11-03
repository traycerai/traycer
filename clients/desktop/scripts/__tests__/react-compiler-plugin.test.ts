// @vitest-environment node
import type { PluginOptions } from "babel-plugin-react-compiler";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reactCompilerPlugin } from "../react-compiler-plugin";

const COMPONENT = [
  'import { useState } from "react";',
  "export function App() {",
  "  const [count] = useState(0);",
  "  return <div>{count}</div>;",
  "}",
].join("\n");

// A conditional hook call. Under `panicThreshold: "all_errors"` the compiler
// raises it as a fatal diagnostic and the transform throws.
const CONDITIONAL_HOOK = [
  'import { useState } from "react";',
  "export function App({ on }: { on: boolean }) {",
  "  if (on) {",
  "    useState(0);",
  "  }",
  "  return <div />;",
  "}",
].join("\n");

let root: string;
let cacheDir: string;
let lockfile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "react-compiler-plugin-"));
  cacheDir = join(root, "cache");
  lockfile = join(root, "bun.lock");
  writeFileSync(lockfile, "lockfile v1");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function compileApp(
  source: string,
  compilerOptions: PluginOptions,
): Promise<string> {
  const entry = join(root, "App.tsx");
  writeFileSync(entry, source);
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      await reactCompilerPlugin({
        compilerOptions,
        cacheDir,
        keyFiles: [lockfile],
      }),
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: { input: entry, external: [/^react(\/|$)/] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("build returned a watcher");
  return output.output[0].code;
}

function entries(): string[] {
  return readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
}

// Replaces every stored entry's code with a side effect the build keeps, so a
// build that emits the marker was served from the cache and one that does not
// compiled the module again.
function markEntries(marker: string): void {
  for (const name of entries()) {
    const file = join(cacheDir, name);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({ ...stored, code: `console.log("${marker}");` }),
    );
  }
}

describe("reactCompilerPlugin's compiled-module cache", () => {
  it("compiles the module, stores it, and serves it again unchanged", async () => {
    const compiled = await compileApp(COMPONENT, {});
    expect(compiled).toContain("react/compiler-runtime");
    expect(entries()).toHaveLength(1);

    markEntries("served-from-cache");
    expect(await compileApp(COMPONENT, {})).toContain("served-from-cache");
    expect(entries()).toHaveLength(1);
  });

  it("never stores a module whose compile raises a fatal diagnostic", async () => {
    const options: PluginOptions = { panicThreshold: "all_errors" };
    await expect(compileApp(CONDITIONAL_HOOK, options)).rejects.toThrow();
    expect(entries()).toEqual([]);
    await expect(compileApp(CONDITIONAL_HOOK, options)).rejects.toThrow();
    expect(entries()).toEqual([]);
  });

  it("misses when a compiler option changes", async () => {
    await compileApp(COMPONENT, {});
    markEntries("stale");

    const recompiled = await compileApp(COMPONENT, { compilationMode: "all" });
    expect(recompiled).not.toContain("stale");
    expect(recompiled).toContain("react/compiler-runtime");
    expect(entries()).toHaveLength(2);
  });

  it("misses when a key file changes", async () => {
    await compileApp(COMPONENT, {});
    markEntries("stale");

    writeFileSync(lockfile, "lockfile v2");
    expect(await compileApp(COMPONENT, {})).not.toContain("stale");
    expect(entries()).toHaveLength(2);
  });

  it("misses when the module's code changes", async () => {
    await compileApp(COMPONENT, {});
    markEntries("stale");

    const changed = COMPONENT.replace("useState(0)", "useState(1)");
    expect(await compileApp(changed, {})).not.toContain("stale");
    expect(entries()).toHaveLength(2);
  });
});
