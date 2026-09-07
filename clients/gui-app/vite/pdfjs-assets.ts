/** Copy pdf.js on-demand data files next to the renderer. Missing URLs default to `null` and the document renders wrong, not loudly. Copied rather than imported so they stay out of the JS graph. */
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";

/** Output dir relative to the page. pdf-asset-urls.ts resolves the same segment against document.baseURI. */
export const PDFJS_ASSET_DIR = "pdfjs";

/**
 * `cmaps` for CJK CID fonts; `standard_fonts` for Symbol/ZapfDingbats; `wasm` for JBIG2/JPEG2000/ICC; `iccs` for CMYK (sync worker fetch, http(s) only).
 */
const PDFJS_ASSET_DIRECTORIES = [
  "cmaps",
  "standard_fonts",
  "wasm",
  "iccs",
] as const;

/** Skip QuickJS wasm: pdf.js only runs it under enableScripting, which the viewer never sets. */
function isShippedAsset(sourcePath: string): boolean {
  return !/(^|[\\/])quickjs-eval\./.test(sourcePath);
}

export const pdfjsDistRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);

const CONTENT_TYPES = new Map<string, string>([
  [".js", "text/javascript"],
  [".wasm", "application/wasm"],
]);

function contentTypeFor(filePath: string): string {
  for (const [extension, contentType] of CONTENT_TYPES) {
    if (filePath.endsWith(extension)) return contentType;
  }
  return "application/octet-stream";
}

/** Map a dev-server path to a shipped file, else null. relative rejects traversal; directory check leaves the rest of the package unserved. */
function resolveServableFile(requestPath: string): string | null {
  const absolutePath = resolve(pdfjsDistRoot, `.${requestPath}`);
  const withinPackage = relative(pdfjsDistRoot, absolutePath);
  if (withinPackage.startsWith("..") || isAbsolute(withinPackage)) return null;
  const topLevelDirectory = withinPackage.split(sep)[0];
  const isShipped = PDFJS_ASSET_DIRECTORIES.some(
    (directory) => directory === topLevelDirectory,
  );
  if (!isShipped || !isShippedAsset(absolutePath)) return null;
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile())
    return null;
  return absolutePath;
}

export function pdfjsAssets(): Plugin {
  let outDir = "";
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const filePath = resolveServableFile(requestPath);
    if (filePath === null) {
      next();
      return;
    }
    response.setHeader("Content-Type", contentTypeFor(filePath));
    createReadStream(filePath).pipe(response);
  };

  return {
    name: "traycer-pdfjs-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_ASSET_DIR}`, serve);
    },
    writeBundle() {
      for (const directory of PDFJS_ASSET_DIRECTORIES) {
        cpSync(
          join(pdfjsDistRoot, directory),
          join(outDir, PDFJS_ASSET_DIR, directory),
          { recursive: true, filter: isShippedAsset },
        );
      }
    },
  };
}
