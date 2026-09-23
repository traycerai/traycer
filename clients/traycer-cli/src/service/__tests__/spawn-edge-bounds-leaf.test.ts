import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finiteDurationMs } from "../spawn-edge-bounds";

const HERE = dirname(fileURLToPath(import.meta.url));

// `spawn-edge-bounds.ts` is deliberately a LEAF (see its module docblock):
// its only import is protocol's `host/lifecycle-constants`, which itself
// imports nothing, so the module can never sit on an import cycle - a cycle
// that would make its module-load-time constants read as `NaN` in the
// released esbuild CJS bundle. This is a static text-shape pin over both
// files' specifier lists, not a runtime check, since the runtime shape
// (module-load-time throw) is covered separately below.

// A simple regex over the source text, not a real parser - this is a static
// pin on the text shape, matching every module specifier a file references:
// static `import ... from "..."`, `import type ... from "..."`, a bare
// side-effecting `import "...";` with no `from` clause, `export ... from
// "..."`, dynamic `import(...)`, and `require(...)`.
function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /from\s+["']([^"']+)["']/g;
  const bareImportPattern = /import\s+["']([^"']+)["']\s*;/g;
  const dynamicImportPattern = /import\(\s*["']([^"']+)["']/g;
  const requirePattern = /require\(\s*["']([^"']+)["']/g;
  for (const pattern of [
    fromPattern,
    bareImportPattern,
    dynamicImportPattern,
    requirePattern,
  ]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("spawn-edge-bounds.ts is a pinned leaf", () => {
  it("imports exactly one specifier: @traycer/protocol/host/lifecycle-constants", () => {
    const source = readFileSync(
      join(HERE, "..", "spawn-edge-bounds.ts"),
      "utf8",
    );

    expect(extractModuleSpecifiers(source)).toEqual([
      "@traycer/protocol/host/lifecycle-constants",
    ]);
  });

  it("protocol's host/lifecycle-constants.ts exists and itself imports nothing", () => {
    const lifecycleConstantsPath = join(
      HERE,
      "..",
      "..",
      "..",
      "..",
      "..",
      "protocol",
      "src",
      "host",
      "lifecycle-constants.ts",
    );

    expect(existsSync(lifecycleConstantsPath)).toBe(true);

    const source = readFileSync(lifecycleConstantsPath, "utf8");

    expect(extractModuleSpecifiers(source)).toEqual([]);
  });
});

describe("finiteDurationMs", () => {
  it("returns a finite value unchanged", () => {
    expect(finiteDurationMs("SOME_NAME", 42)).toBe(42);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("throws naming the term for %s", (_label, value) => {
    expect(() => finiteDurationMs("SOME_NAME", value)).toThrow(/SOME_NAME/);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a non-finite term at module load throws naming HOST_START_ADOPTION_MAX_AGE_MS", async () => {
    vi.resetModules();
    vi.doMock(
      "@traycer/protocol/host/lifecycle-constants",
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("@traycer/protocol/host/lifecycle-constants")
          >();
        return { ...actual, SHUTDOWN_FORCE_EXIT_MS: Number.NaN };
      },
    );

    await expect(import("../spawn-edge-bounds")).rejects.toThrow(
      /HOST_START_ADOPTION_MAX_AGE_MS/,
    );

    vi.doUnmock("@traycer/protocol/host/lifecycle-constants");
    vi.resetModules();
  });
});
