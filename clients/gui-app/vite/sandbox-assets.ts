/**
 * Ships the sandbox loader as `<outDir>/sandbox/{index.html,loader.js}`.
 *
 * Both apps that bundle gui-app add this plugin. The Capacitor app serves the
 * result itself at `/sandbox/index.html`; the Electron app serves it through
 * its `traycer-sandbox:` scheme, which reads these same files from the
 * packaged renderer directory (or from this dev server's middleware in dev).
 *
 * `loader.js` is `src/lib/sandbox/sandbox-loader.ts` transpiled on its own -
 * not bundled, not a chunk: the frame loads it as one classic script, since a
 * module script would need CORS from the frame's opaque origin. The Figtree
 * face pages are offered is inlined into it as a `data:` URL: the sandbox
 * origin serves nothing a page policy has to admit.
 */
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc, type Connect, type Plugin } from "vite";

export const SANDBOX_ASSET_DIR = "sandbox";

const gui = (path: string): string =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
const loaderSource = gui("src/lib/sandbox/sandbox-loader.ts");
const figtreeRoot = dirname(
  createRequire(import.meta.url).resolve(
    "@fontsource-variable/figtree/package.json",
  ),
);

/** Every file the sandbox origin serves, by name. Nothing else is servable. */
export const SANDBOX_ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["loader.js", "text/javascript; charset=utf-8"],
]);

const STATIC_SOURCES: ReadonlyMap<string, string> = new Map([
  ["index.html", gui("sandbox/index.html")],
]);

/** The token `sandbox-loader.ts` holds where the font's `data:` URL goes. */
const FIGTREE_TOKEN = "__TRAYCER_SANDBOX_FIGTREE_DATA_URL__";

// The latin subset of the variable face: about 20 KB, the weights the app uses.
const figtreeSource = join(
  figtreeRoot,
  "files",
  "figtree-latin-wght-normal.woff2",
);

async function buildLoader(): Promise<string> {
  const result = await transformWithOxc(
    readFileSync(loaderSource, "utf8"),
    loaderSource,
    { lang: "ts", target: "es2022" },
  );
  const parts = result.code.split(FIGTREE_TOKEN);
  if (parts.length !== 2) {
    throw new Error("sandbox-loader.ts must hold the Figtree token once");
  }
  const font = readFileSync(figtreeSource).toString("base64");
  // Base64 has no quote, backslash or `<`, so it sits in any string literal.
  return parts.join(`data:font/woff2;base64,${font}`);
}

export function sandboxAssets(): Plugin {
  let outDir = "";
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const name = (request.url ?? "/").split("?")[0].replace(/^\//, "");
    const contentType = SANDBOX_ASSET_TYPES.get(name);
    if (contentType === undefined) {
      next();
      return;
    }
    response.setHeader("Content-Type", contentType);
    const source = STATIC_SOURCES.get(name);
    if (source !== undefined) {
      createReadStream(source).pipe(response);
      return;
    }
    buildLoader().then(
      (code) => response.end(code),
      (error: unknown) => next(error),
    );
  };

  return {
    name: "traycer-sandbox-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(`/${SANDBOX_ASSET_DIR}`, serve);
    },
    async writeBundle() {
      const target = join(outDir, SANDBOX_ASSET_DIR);
      mkdirSync(target, { recursive: true });
      for (const [name, source] of STATIC_SOURCES) {
        writeFileSync(join(target, name), readFileSync(source));
      }
      writeFileSync(join(target, "loader.js"), await buildLoader());
    },
  };
}
