/**
 * Tunnel-friendly GUI development server.
 *
 * Vite's normal dev server preserves each source module, which gives excellent
 * HMR on a local machine but turns a cold page load into hundreds of serial
 * requests over an SSH tunnel. This lane watches a non-minified build, serves
 * it through Vite preview, and lets the injected build poller reload the page
 * after a successful rebuild.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const mobileRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configFile = resolve(mobileRoot, "vite.config.ts");

process.env.TRAYCER_GUI_MODE = "bundled";

const buildResult = await build({
  configFile,
  build: { watch: {} },
});
if (Array.isArray(buildResult) || !("on" in buildResult)) {
  throw new Error("Vite did not start the bundled build watcher");
}

const watcher = buildResult;
console.log("[gui-app] waiting for the initial bundled build");
await new Promise<void>((resolveInitialBuild) => {
  let buildFailed = false;
  watcher.on("event", (event) => {
    if (event.code === "START") buildFailed = false;
    if (event.code === "ERROR") buildFailed = true;
    if (event.code === "END" && !buildFailed) resolveInitialBuild();
  });
});

const server = await preview({ configFile });
console.log("[gui-app] bundled build ready; watching for changes");
server.printUrls();

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.all([watcher.close(), server.close()]);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });
}
