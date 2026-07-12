"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { resolveDevDesktopIdentity } = require("./dev-desktop-display-name.cjs");

const workspaceRoot = path.resolve(__dirname, "..", "..");
const DEFAULT_RENDERER_PORT = 5173;

function readRendererPort(env) {
  const raw = env.PORT ?? String(DEFAULT_RENDERER_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${raw}`);
  }
  return port;
}

// Build the env handed to the renderer + main dev processes.
//
// The renderer bundle has no `process.env`; the multi-run slot reaches it
// through Vite (`VITE_DEV_DESKTOP_SLOT`) so `renderer-shell/sign-in-url.ts`
// derives the same slot-suffixed deep-link scheme the main process registers.
// The local Cloud UI endpoint follows the same Vite-only path: config.ts reads
// `process.env` correctly in main/preload, but renderer-side sign-in URL
// composition must receive an explicitly exposed value.
//
// The result is spread from `env`, so an inherited `VITE_DEV_DESKTOP_SLOT` -
// exported by hand, or left over from a prior slotted run - would survive into
// a NO-slot run: the renderer would derive a slot-suffixed scheme while the
// main process, which reads `DEV_DESKTOP_SLOT` directly, registers the bare
// one, silently breaking the callback isolation this threading provides. Clear
// it so both sides always derive from the same source.
function buildChildEnv(env) {
  const rendererPort = readRendererPort(env);
  const devDesktopIdentity = resolveDevDesktopIdentity(env);
  const rendererUrl =
    env.TRAYCER_DESKTOP_DEV_URL ?? `http://localhost:${rendererPort}`;
  const childEnv = {
    ...env,
    NODE_ENV: "development",
    PORT: String(rendererPort),
    TRAYCER_DESKTOP_DEV: "1",
    TRAYCER_DESKTOP_DEV_URL: rendererUrl,
  };
  if (typeof env.DEV_DESKTOP_SLOT === "string") {
    childEnv.VITE_DEV_DESKTOP_SLOT = env.DEV_DESKTOP_SLOT;
  } else {
    delete childEnv.VITE_DEV_DESKTOP_SLOT;
  }
  delete childEnv.VITE_DEV_DESKTOP_DISPLAY_NAME;
  if (devDesktopIdentity === null) {
    delete childEnv.VITE_DEV_DESKTOP_WORKTREE_LABEL;
  } else {
    childEnv.VITE_DEV_DESKTOP_WORKTREE_LABEL = devDesktopIdentity.worktreeLabel;
  }
  if (typeof env.TRAYCER_DEV_CLOUD_UI_BASE_URL === "string") {
    childEnv.VITE_DEV_CLOUD_UI_BASE_URL = env.TRAYCER_DEV_CLOUD_UI_BASE_URL;
  } else {
    delete childEnv.VITE_DEV_CLOUD_UI_BASE_URL;
  }
  return childEnv;
}

function main() {
  const rendererPort = readRendererPort(process.env);
  const childEnv = buildChildEnv(process.env);

  const child = spawn(
    "bun",
    [
      "x",
      "concurrently",
      "-k",
      "-n",
      "renderer,main",
      "-c",
      "blue,magenta",
      "bun run dev:renderer",
      `bun x wait-on tcp:${rendererPort} && bun run dev:main`,
    ],
    {
      cwd: workspaceRoot,
      env: childEnv,
      stdio: "inherit",
    },
  );

  child.on("error", (err) => {
    console.error(`[dev-stack] failed to start dev stack: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  readRendererPort,
  buildChildEnv,
};
