/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Shared rewriter for the per-module flat deploy config (`src/config.ts`).
 *
 * Owned by the clients tree so each client's `set-deploy-target.cjs` wrapper
 * resolves it within this workspace, with no dependency outside the clients
 * boundary.
 *
 * Each module keeps a flat config object whose source holds the committed
 * production endpoints (+ host trust root) and the `dev` environment/version.
 * A production build rewrites the `environment` field + the literal values that
 * genuinely vary per release in place, runs the build, then `--restore`s back
 * to the committed source. There is NO runtime env lookup; this build-time
 * rewrite is the only place such values are selected.
 *
 * Per-module scripts call `runConfigTargetCli({ sourcePath, stringFields,
 * nullableStringFields, arrayFields })`:
 *   - stringFields: { field: { dev, staging, production } } - string literals.
 *   - nullableStringFields: same shape, but values may be null and source
 *     fields must be declared as `value: null as string | null` or
 *     `value: "..." as string | null`.
 *   - arrayFields:  { field: { dev, production } } - string[] literals.
 *   - unreleasedFeaturesPaths: `unreleased-features.ts` files whose
 *     `UNRELEASED_FEATURES_ENABLED` literal the target selects: `true` for
 *     dev and staging, `false` for production (`set-unreleased-features.cjs`).
 *     `--unreleased-features=on|off` overrides staging or dev, never production.
 *
 * Usage (per-module wrapper):
 *   bun scripts/set-deploy-target.cjs --target=production
 *   bun scripts/set-deploy-target.cjs --restore        # → dev
 */

const fs = require("node:fs");

const VALID_TARGETS = ["dev", "staging", "production"];
const PREFIX = "[set-deploy-target]";
// The source default + the value `--restore` writes back. Must match the
// `version` literal committed in each module's `config.ts` so a build's
// restore leaves the working tree clean. Builds stamp a concrete per-build
// id over this via `--version` (see desktop-install-cloud.js#setDeployTarget);
// detecting `version !== this sentinel` is how a shipped build knows it is
// not the dev source tree.
const DEV_VERSION_SENTINEL = "0.0.0-dev";

function rewriteEnvironment(source, target, sourcePath) {
  const re = /(\benvironment:\s*")(?:dev|staging|production)(")/;
  if (!re.test(source)) {
    console.error(
      `${PREFIX} could not find 'environment' literal in ${sourcePath}`,
    );
    process.exit(3);
  }
  return source.replace(re, `$1${target}$2`);
}

function rewriteStringField(source, field, value, sourcePath) {
  const re = new RegExp(`(\\b${field}:\\s*")[^"]*(")`);
  if (!re.test(source)) {
    console.error(
      `${PREFIX} could not find '${field}' literal in ${sourcePath}`,
    );
    process.exit(3);
  }
  return source.replace(re, `$1${value}$2`);
}

function rewriteNullableStringField(source, field, value, sourcePath) {
  const re = new RegExp(
    `(\\b${field}:\\s*)(?:"[^"]*"|null)(\\s+as\\s+string\\s*\\|\\s*null)`,
  );
  if (!re.test(source)) {
    console.error(
      `${PREFIX} could not find nullable '${field}' literal in ${sourcePath}`,
    );
    process.exit(3);
  }
  const rendered = value === null ? "null" : JSON.stringify(value);
  return source.replace(re, `$1${rendered}$2`);
}

function rewriteArrayField(source, field, values, sourcePath) {
  const re = new RegExp(`(\\b${field}:\\s*)\\[[^\\]]*\\]`);
  if (!re.test(source)) {
    console.error(
      `${PREFIX} could not find '${field}' array literal in ${sourcePath}`,
    );
    process.exit(3);
  }
  const rendered = values.map((v) => JSON.stringify(v)).join(", ");
  return source.replace(re, `$1[${rendered}]`);
}

// Stamp the per-build `version` literal. Presence-conditional: a module whose
// config has no `version` field (e.g. mobile) is left untouched rather than
// erroring, so this generic field can be added incrementally. `version` is
// null when a target build is run without `--version` (the field keeps its
// committed value).
function rewriteVersionFieldIfPresent(source, version, sourcePath) {
  if (version === null) return source;
  const re = /(\bversion:\s*")[^"]*(")/;
  if (!re.test(source)) {
    console.log(
      `${PREFIX} no 'version' literal in ${sourcePath} - skipping version stamp`,
    );
    return source;
  }
  return source.replace(re, `$1${version}$2`);
}

/**
 * What a target writes into `unreleased-features.ts`: dev and staging builds
 * ship the features the next release does not (the committed literal), a
 * production build does not. An explicit `--unreleased-features=on|off`
 * overrides staging or dev (a venue that wants a production-configured client
 * against staging endpoints); production is never on, whatever the flag says.
 */
function unreleasedFeaturesFor(target, override) {
  if (target === "production") {
    if (override === true) {
      console.error(
        `${PREFIX} --target=production never ships the unreleased features; drop --unreleased-features=on`,
      );
      process.exit(5);
    }
    return false;
  }
  return override ?? true;
}

function applyTarget(spec, target, version, unreleasedFeatures) {
  const unreleasedFeaturesPaths = spec.unreleasedFeaturesPaths ?? [];
  if (unreleasedFeaturesPaths.length > 0) {
    // Loaded here, not at the top: this file is also exercised alone by its
    // tests.
    const {
      rewriteUnreleasedFeatures,
    } = require("./set-unreleased-features.cjs");
    const enabled = unreleasedFeaturesFor(target, unreleasedFeatures);
    for (const sourcePath of unreleasedFeaturesPaths) {
      try {
        rewriteUnreleasedFeatures(sourcePath, enabled);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(3);
      }
    }
  }
  let source = fs.readFileSync(spec.sourcePath, "utf8");
  source = rewriteEnvironment(source, target, spec.sourcePath);
  source = rewriteVersionFieldIfPresent(source, version, spec.sourcePath);
  for (const [field, byEnv] of Object.entries(spec.stringFields ?? {})) {
    source = rewriteStringField(source, field, byEnv[target], spec.sourcePath);
  }
  for (const [field, byEnv] of Object.entries(
    spec.nullableStringFields ?? {},
  )) {
    source = rewriteNullableStringField(
      source,
      field,
      byEnv[target],
      spec.sourcePath,
    );
  }
  for (const [field, byEnv] of Object.entries(spec.arrayFields ?? {})) {
    source = rewriteArrayField(source, field, byEnv[target], spec.sourcePath);
  }
  fs.writeFileSync(spec.sourcePath, source, "utf8");
  console.log(
    `${PREFIX} ${spec.sourcePath} -> '${target}'${version !== null ? ` (version=${version})` : ""}`,
  );
}

function parseArgs(argv) {
  let target = null;
  let restore = false;
  let version = null;
  let emptyVersion = false;
  let unreleasedFeatures = null;
  for (const arg of argv) {
    if (arg === "--restore") restore = true;
    else if (arg.startsWith("--target="))
      target = arg.slice("--target=".length);
    else if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      emptyVersion = version.length === 0;
    } else if (arg.startsWith("--unreleased-features=")) {
      const value = arg.slice("--unreleased-features=".length);
      if (value !== "on" && value !== "off") {
        console.error(
          `${PREFIX} --unreleased-features must be 'on' or 'off', got '${value}'`,
        );
        process.exit(2);
      }
      unreleasedFeatures = value === "on";
    }
  }
  return { target, restore, version, emptyVersion, unreleasedFeatures };
}

function runConfigTargetCli(spec) {
  const { target, restore, version, emptyVersion, unreleasedFeatures } =
    parseArgs(process.argv.slice(2));
  if (restore) {
    // Restore is just "set dev" (the source default) - deterministic and
    // git-state-independent. Reset the version stamp to the committed
    // sentinel so the working tree matches source after a build.
    applyTarget(spec, "dev", DEV_VERSION_SENTINEL, null);
    return;
  }
  if (target === null) {
    console.error(
      `${PREFIX} usage: --target=<${VALID_TARGETS.join("|")}> | --restore`,
    );
    process.exit(1);
  }
  if (!VALID_TARGETS.includes(target)) {
    console.error(
      `${PREFIX} invalid target '${target}'. Expected one of: ${VALID_TARGETS.join(", ")}`,
    );
    process.exit(2);
  }
  if (emptyVersion) {
    console.error(`${PREFIX} --version requires a non-empty value`);
    process.exit(2);
  }
  applyTarget(spec, target, version, unreleasedFeatures);
}

module.exports = { runConfigTargetCli };
