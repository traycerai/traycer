/**
 * Ships the sandbox loader as `<outDir>/sandbox/index.html`, one document that
 * fetches nothing.
 *
 * Both apps that bundle gui-app add this plugin. The Capacitor app serves the
 * result itself at `/sandbox/index.html`; the Electron app serves it through
 * its `traycer-sandbox:` scheme, which reads this same file from the packaged
 * renderer directory (or from this dev server's middleware in dev).
 *
 * The loader is `src/lib/sandbox/sandbox-loader.ts` transpiled on its own -
 * not bundled, not a chunk - and inlined into `sandbox/index.html` as one
 * classic script. It is never a separate file: WebKit's `*` does not cover a
 * custom scheme such as iOS's `capacitor:` inside an opaque sandboxed frame,
 * so a `<script src>` on that origin is blocked by the frame's own policy. The
 * Figtree face pages are offered is inlined into it as a `data:` URL for the
 * same reason: the sandbox origin serves nothing a policy has to admit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc, type Connect, type Plugin } from "vite";

export const SANDBOX_ASSET_DIR = "sandbox";

// Not `new URL(path, import.meta.url)`: Vite rewrites that shape into an asset
// import when this module is loaded through Vite itself (the guard test).
const guiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gui = (path: string): string => join(guiRoot, path);
const loaderSource = gui("src/lib/sandbox/sandbox-loader.ts");
const templateSource = gui("sandbox/index.html");
const figtreeRoot = dirname(
  createRequire(import.meta.url).resolve(
    "@fontsource-variable/figtree/package.json",
  ),
);

/** Every file the sandbox origin serves, by name. Nothing else is servable. */
export const SANDBOX_ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ["index.html", "text/html; charset=utf-8"],
]);

/** The token `sandbox-loader.ts` holds where the font's `data:` URL goes. */
const FIGTREE_TOKEN = "__TRAYCER_SANDBOX_FIGTREE_DATA_URL__";

/** The comment `sandbox/index.html` holds where the loader's code goes. */
const LOADER_TOKEN = "/* __TRAYCER_SANDBOX_LOADER__ */";

// The latin subset of the variable face: about 20 KB, the weights the app uses.
const figtreeSource = join(
  figtreeRoot,
  "files",
  "figtree-latin-wght-normal.woff2",
);

function replaceOnce(text: string, token: string, value: string): string {
  const parts = text.split(token);
  if (parts.length !== 2) {
    throw new Error(`the sandbox template must hold ${token} once`);
  }
  return parts.join(value);
}

/**
 * Keeps code inside its `<script>` element: `</script` would end the element
 * early and `<!--` would change how the parser looks for the end. `\x3C` is a
 * `<` in every JS context these can occur in (string, template, regex - with
 * or without the `u` flag - and comment).
 */
export function escapeInlineScript(code: string): string {
  return code.replace(/<(?=\/script|!--)/gi, "\\x3C");
}

async function buildLoader(): Promise<string> {
  const result = await transformWithOxc(
    readFileSync(loaderSource, "utf8"),
    loaderSource,
    { lang: "ts", target: "es2022" },
  );
  const font = readFileSync(figtreeSource).toString("base64");
  // Base64 has no quote, backslash or `<`, so it sits in any string literal.
  return replaceOnce(
    result.code,
    FIGTREE_TOKEN,
    `data:font/woff2;base64,${font}`,
  );
}

/** The one sandbox document: the template with the loader inlined. */
export async function buildSandboxIndex(): Promise<string> {
  return replaceOnce(
    readFileSync(templateSource, "utf8"),
    LOADER_TOKEN,
    escapeInlineScript(await buildLoader()),
  );
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
    buildSandboxIndex().then(
      (html) => {
        response.setHeader("Content-Type", contentType);
        response.end(html);
      },
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
      writeFileSync(join(target, "index.html"), await buildSandboxIndex());
    },
  };
}
