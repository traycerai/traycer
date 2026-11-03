import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOptions } from "babel-plugin-react-compiler";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

interface ReactCompilerPluginInput {
  /** JSON data only: the options are part of every cache key. */
  compilerOptions: PluginOptions;
  /**
   * Where compiled modules are kept between builds, or undefined (or empty)
   * to compile every module on every build, as a release build does.
   */
  cacheDir: string | undefined;
  /**
   * Files whose content decides the output beyond a module's own code: the
   * lockfile, which fixes the compiler, Babel, Vite and plugin versions, and
   * the config that composes the plugin chain.
   */
  keyFiles: string[];
}

/**
 * The React Compiler as a Babel transform, optionally keeping each module's
 * compiled output so a build compiles only the modules that changed.
 *
 * An entry is keyed on the module's code and path, the environment and module
 * type the hook is given, the compiler options, this file's own source and the
 * content of `keyFiles`.
 * Babel reads no configuration file here (`@rolldown/plugin-babel` passes
 * `babelrc: false` and `configFile: false`), and the compiler reads one module
 * at a time, so nothing else reaches the output. Only a compile that returns
 * code is stored: a module that fails to compile throws before anything is
 * written, and fails every build that reaches it. A hit refreshes the entry's
 * modification time, which is how CI keeps only the entries its last build
 * used.
 */
export async function reactCompilerPlugin(
  input: ReactCompilerPluginInput,
): Promise<Plugin> {
  const plugin: Plugin = await babel({
    presets: [reactCompilerPreset(input.compilerOptions)],
  });
  const dir = input.cacheDir;
  const transform = plugin.transform;
  if (dir === undefined || dir === "" || typeof transform !== "object") {
    return plugin;
  }
  mkdirSync(dir, { recursive: true });
  const salt = createHash("sha256").update(
    JSON.stringify(input.compilerOptions),
  );
  // This module decides how the compiler is configured, so its own source is
  // part of every key.
  for (const file of [fileURLToPath(import.meta.url), ...input.keyFiles]) {
    salt.update("\0").update(readFileSync(file));
  }
  const saltHex = salt.digest("hex");
  const compile = transform.handler;
  transform.handler = async function (code, id, options) {
    const key = createHash("sha256")
      .update(
        [saltHex, this.environment?.name, options?.moduleType, id].join("\0"),
      )
      .update("\0")
      .update(code)
      .digest("hex");
    const entry = join(dir, `${key}.json`);
    let stored: string | undefined;
    try {
      stored = readFileSync(entry, "utf8");
    } catch {
      stored = undefined;
    }
    if (stored !== undefined) {
      const now = new Date();
      utimesSync(entry, now, now);
      return JSON.parse(stored);
    }
    const result = await compile.call(this, code, id, options);
    if (result !== undefined && result !== null && typeof result === "object") {
      const partial = `${entry}.${process.pid}`;
      writeFileSync(partial, JSON.stringify(result));
      renameSync(partial, entry);
    }
    return result;
  };
  return plugin;
}
