import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export function assertUiModuleGraph(ids: readonly string[]): {
  moduleCount: number;
  baseModuleCount: number;
} {
  const baseFiles = new Map<string, string>();
  for (const id of ids) {
    const file = id.replaceAll("\0", "").split("?")[0];
    const normalized = (
      existsSync(file) ? realpathSync(file) : file
    ).replaceAll("\\", "/");
    if (
      /\/node_modules\/(?:@radix-ui\/[^/]+|radix-ui|vaul|cmdk)(?:\/|$)/.test(
        normalized,
      )
    ) {
      throw new Error(`Retired UI dependency in emitted graph: ${id}`);
    }
    // CommonJS wrappers do not execute a second copy of the file.
    if (/[?&]commonjs-(?:proxy|es-import|exports|module)(?:[=&]|$)/.test(id))
      continue;
    // Match Vite's asset-loader rawRE/urlRE: `?raw=1` is still JavaScript.
    if (/[?&](?:raw|url)(?:&|$)/.test(id)) continue;
    const marker = "/node_modules/@base-ui/react/";
    const index = normalized.lastIndexOf(marker);
    if (index < 0) continue;
    // ESM and CJS are distinct runtime identities for the same logical module.
    const logical = normalized
      .slice(index + marker.length)
      .replace(/^esm\//, "")
      .replace(/\.[cm]?js$/, "");
    const previous = baseFiles.get(logical);
    if (previous !== undefined && previous !== id) {
      throw new Error(
        `Duplicate Base UI module ${logical}:\n${previous}\n${id}`,
      );
    }
    baseFiles.set(logical, id);
  }
  return { moduleCount: ids.length, baseModuleCount: baseFiles.size };
}

/** Check emitted chunks, not installed peers or modules removed by tree shaking. */
export function uiModuleGraph(): Plugin {
  let cacheDir = "";
  return {
    name: "traycer-ui-module-graph",
    apply: "build",
    configResolved(config) {
      cacheDir = config.cacheDir;
    },
    generateBundle(_options, bundle) {
      const modules = [
        ...new Set(
          Object.values(bundle).flatMap((output) =>
            output.type === "chunk" ? Object.keys(output.modules) : [],
          ),
        ),
      ].sort();
      const counts = assertUiModuleGraph(modules);
      if (counts.baseModuleCount === 0) {
        throw new Error(
          "Renderer graph contains no Base UI modules; cannot verify UI migration",
        );
      }
      // Build evidence belongs in the cache, not in shipped application assets.
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "ui-module-graph.json"),
        JSON.stringify({ ...counts, modules }, null, 2),
      );
      this.info(
        `[ui-module-graph] ${counts.moduleCount} emitted modules; ${counts.baseModuleCount} Base UI files, one identity each; no retired UI dependencies`,
      );
    },
  };
}
