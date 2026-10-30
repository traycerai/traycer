// Runs tsrs with this script's arguments: `node scripts/tsrs.mjs -p ...`.
//
// tsrs ships no binary for some platforms (Windows ARM64 today). There the
// same arguments go to tsgo, which takes the same tsc flags, so type-checks
// keep working where they did before tsrs. A platform tsrs does list but whose
// binary failed to install is an error, not a fallback: a silent switch would
// hide a broken install behind tsgo's much larger memory footprint.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function resolveTsrs() {
  const root = path.dirname(require.resolve("tsrs/package.json"));
  const load = (file) =>
    import(pathToFileURL(path.join(root, "lib", file)).href);
  const { getPlatformPackageName } = await load("platform.js");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const supported = Object.keys(pkg.optionalDependencies ?? {});
  if (
    process.env.TSRS_BINARY === undefined &&
    !supported.includes(getPlatformPackageName())
  ) {
    return undefined;
  }
  const { default: getExePath } = await load("getExePath.js");
  return getExePath();
}

function tsgoCommand() {
  const root = path.dirname(
    require.resolve("@typescript/native-preview/package.json"),
  );
  return [process.execPath, [path.join(root, "bin", "tsgo")]];
}

const tsrs = await resolveTsrs();
const [command, prefix] = tsrs === undefined ? tsgoCommand() : [tsrs, []];
const result = spawnSync(command, [...prefix, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.error !== undefined) {
  console.error(`tsrs.mjs: cannot run ${command}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal !== null) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
