const { existsSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, extname, join, resolve } = require("node:path");

const DIST_DIR = resolve(__dirname, "..", "dist");
const EXPLICIT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".node"]);

function listJavaScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJavaScriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

function resolveRelativeSpecifier(file, specifier) {
  if (!specifier.startsWith(".") || EXPLICIT_EXTENSIONS.has(extname(specifier))) {
    return specifier;
  }

  const absoluteTarget = resolve(dirname(file), specifier);
  if (existsSync(`${absoluteTarget}.js`)) {
    return `${specifier}.js`;
  }
  if (existsSync(join(absoluteTarget, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

function rewriteSpecifiers(file, source) {
  const rewrite = (match, prefix, specifier, suffix) => {
    return `${prefix}${resolveRelativeSpecifier(file, specifier)}${suffix}`;
  };

  return source
    .replace(/(\bfrom\s*["'])(\.[^"']+)(["'])/g, rewrite)
    .replace(/(\bimport\s+["'])(\.[^"']+)(["'])/g, rewrite)
    .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)(["']\s*\))/g, rewrite);
}

for (const file of listJavaScriptFiles(DIST_DIR)) {
  const source = readFileSync(file, "utf8");
  const next = rewriteSpecifiers(file, source);
  if (next !== source) {
    writeFileSync(file, next);
  }
}
