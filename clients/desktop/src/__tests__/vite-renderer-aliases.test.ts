import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for `make dev-desktop` startup.
 *
 * The desktop renderer's vite config consumes `@traycer-clients/gui-app` as a
 * workspace library. `gui-app` reaches into sibling workspaces via bare
 * specifiers (`@traycer/protocol/*`,
 * `@traycer-clients/shared/*`, `@traycer-clients/gui-app/*`) and into its own
 * `src/` via the `@/` alias. Vite only resolves these when a matching entry
 * lives in the renderer config's `resolve.alias` block. A missing alias
 * surfaces at dev-server startup as `Failed to run dependency scan ... could
 * not be resolved` - exactly how the notifications-store /
 * notification-formatter / notification-room imports broke the stack
 * previously.
 *
 * Rather than rely on an in-browser reproducer, this test parses the vite
 * config, walks every production source file under `gui-app/src`, and
 * asserts each workspace-prefixed specifier has an alias that would match
 * it under vite's prefix-with-slash-boundary rule.
 */

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const GUI_APP_ROOT = path.resolve(DESKTOP_ROOT, "..", "gui-app");
const VITE_RENDERER_CONFIG = path.resolve(
  DESKTOP_ROOT,
  "vite.renderer.config.ts",
);

/**
 * Prefixes that imply the import crosses a workspace boundary that vite
 * must resolve through the alias table. Pure `@radix-ui/*`, `@tanstack/*`,
 * etc. flow through node_modules and are intentionally excluded.
 */
const WORKSPACE_SCOPE_PREFIXES = [
  "@/",
  "@traycerai/",
  "@traycer/",
  "@traycer-clients/",
] as const;

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function walkFiles(
  root: string,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name);
      if (extensions.has(ext)) out.push(full);
    }
  }
  return out;
}

const IMPORT_REGEX =
  /\b(?:import|export)[^'"]*?\bfrom\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_REGEX)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function crossesWorkspaceBoundary(specifier: string): boolean {
  if (specifier === "@") return true;
  return WORKSPACE_SCOPE_PREFIXES.some((prefix) =>
    specifier.startsWith(prefix),
  );
}

/**
 * Extracts every left-hand alias key from the vite config's `resolve.alias`
 * object literal. The config uses a plain string-keyed object, so a targeted
 * regex over the declared quoted keys is both simpler and more robust than
 * an on-the-fly TS evaluation.
 */
function extractAliasKeys(viteConfigSource: string): string[] {
  const aliasBlockMatch = viteConfigSource.match(
    /alias:\s*\{([\s\S]*?)\n\s*\},/,
  );
  if (aliasBlockMatch === null) {
    throw new Error(
      "vite.renderer.config.ts: could not locate resolve.alias block",
    );
  }
  const keys: string[] = [];
  for (const entry of aliasBlockMatch[1].matchAll(/["']([^"']+)["']\s*:/g)) {
    keys.push(entry[1]);
  }
  return keys;
}

/**
 * Vite matches a string alias against a specifier when
 * `specifier === alias || specifier.startsWith(alias + "/")`. We deliberately
 * sort longest-first so a more specific alias like `@traycer-clients/gui-app`
 * wins over a shorter one like `@traycer-clients/shared` even if both were
 * viable prefixes.
 */
function findMatchingAlias(
  specifier: string,
  aliases: readonly string[],
): string | null {
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) {
      return alias;
    }
  }
  return null;
}

describe("vite renderer alias coverage", () => {
  it("does not expose the private updater token through renderer env prefixes", async () => {
    const viteConfigSource = await readText(VITE_RENDERER_CONFIG);

    expect(viteConfigSource).toMatch(/envPrefix:\s*rendererEnvPrefix/);
    expect(viteConfigSource).toContain('"VITE_APP_"');
    expect(viteConfigSource).toContain('"VITE_DESKTOP_"');
    expect(viteConfigSource).toContain('"VITE_POSTHOG_KEY"');
    expect(viteConfigSource).toContain('"VITE_TRAYCER_OSS_REPO"');
    expect(viteConfigSource).not.toMatch(/["']VITE_["']/);
    expect(viteConfigSource).not.toContain("VITE_TRAYCER_DESKTOP_UPDATE_REPO");
    expect(viteConfigSource).not.toContain("VITE_TRAYCER_DESKTOP_UPDATE_TOKEN");
  });

  it("aliases every workspace-prefixed specifier reachable from gui-app", async () => {
    const viteConfigSource = await readText(VITE_RENDERER_CONFIG);
    const aliasKeys = extractAliasKeys(viteConfigSource);
    expect(
      aliasKeys.length,
      "vite.renderer.config.ts resolve.alias block parsed to zero entries - parser is broken.",
    ).toBeGreaterThan(0);

    const sources = await walkFiles(
      path.join(GUI_APP_ROOT, "src"),
      new Set([".ts", ".tsx"]),
    );
    const unaliased = new Map<string, string[]>();
    for (const source of sources) {
      if (source.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const contents = await readText(source);
      for (const specifier of extractImportSpecifiers(contents)) {
        if (!crossesWorkspaceBoundary(specifier)) continue;
        if (findMatchingAlias(specifier, aliasKeys) !== null) continue;
        const relSource = path.relative(GUI_APP_ROOT, source);
        const seen = unaliased.get(specifier);
        if (seen === undefined) {
          unaliased.set(specifier, [relSource]);
        } else if (!seen.includes(relSource)) {
          seen.push(relSource);
        }
      }
    }

    const formatted = Array.from(unaliased.entries())
      .map(([specifier, files]) => `  ${specifier}  (in ${files[0]})`)
      .join("\n");
    expect(
      unaliased.size,
      `${unaliased.size} workspace-prefixed specifier(s) imported by gui-app are not resolvable by the desktop vite config:\n${formatted}\nAdd each missing prefix to vite.renderer.config.ts resolve.alias.`,
    ).toBe(0);
  });
});
