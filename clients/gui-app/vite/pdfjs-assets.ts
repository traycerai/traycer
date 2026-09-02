/**
 * Ships pdf.js's on-demand data files alongside the renderer bundle.
 *
 * pdf.js keeps the bulky, rarely-needed parts of a PDF renderer out of its
 * worker and fetches them per document: the predefined Adobe CMaps, the
 * standard-14 font data, and the wasm image codecs. Every one of those URLs
 * defaults to `null`, and a missing one does not fail loudly - the document
 * renders WRONG. A CID font naming a predefined CMap (the CJK case) loses its
 * glyphs AND its text extraction, so selection and search go with them; a
 * scanned page loses its JBIG2 images with nothing but a console warning,
 * because the wasm fetch and its JS fallback both resolve against `null`.
 *
 * The files are copied rather than imported so they stay out of the JS graph:
 * nothing here enters a chunk, and each file is fetched only by a document
 * that actually needs it. Both apps that bundle gui-app (the Electron
 * renderer and the Capacitor web build) add this plugin, and both serve the
 * result same-origin - so `connect-src 'self'` already covers the fetches and
 * `script-src 'wasm-unsafe-eval'` already covers the codecs.
 */
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";

/**
 * Output directory the data files are copied into, relative to the page.
 *
 * `pdf-asset-urls.ts` resolves the same segment against `document.baseURI`;
 * `pdf-asset-urls.test.ts` holds the two together.
 */
export const PDFJS_ASSET_DIR = "pdfjs";

/**
 * The pdf.js data directories worth shipping, and why:
 *
 * - `cmaps` - predefined Adobe CMaps for CID fonts. Only `Identity-H`/`-V`
 *   are built into the worker, which is why Western documents render fine
 *   without these and CJK ones do not.
 * - `standard_fonts` - the standard-14 font data. Mostly redundant, since
 *   `useSystemFonts` defaults on in a browser and substitutes local fonts,
 *   but `Symbol` and `ZapfDingbats` are excluded from that substitution and
 *   have no source but these files.
 * - `wasm` - the JBIG2, JPEG 2000 and ICC decoders. JBIG2 is the codec
 *   scanners reach for, so this is the directory an ordinary user is most
 *   likely to need.
 *
 * `iccs` is deliberately absent: ICC handling uses a SYNCHRONOUS fetch that
 * exists only on pdf.js's worker-fetch path, and that path requires an
 * http(s) page - which neither `app://renderer` nor Capacitor is.
 */
const PDFJS_ASSET_DIRECTORIES = ["cmaps", "standard_fonts", "wasm"] as const;

/**
 * QuickJS is the wasm directory's odd one out: it evaluates the JavaScript
 * embedded in AcroForm documents, which pdf.js only runs under
 * `enableScripting` - an option the viewer never sets. Half a megabyte for a
 * code path that cannot execute.
 */
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

/**
 * Resolves a dev-server request path to a file inside one of the shipped
 * directories, or `null` if it names anything else. The `relative` check
 * rejects traversal; the directory check keeps the rest of the package -
 * sources, licences, the legacy builds - unserved.
 */
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
