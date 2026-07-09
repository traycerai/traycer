"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

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

function main() {
  const rendererPort = readRendererPort(process.env);
  const rendererUrl =
    process.env.TRAYCER_DESKTOP_DEV_URL ?? `http://localhost:${rendererPort}`;
  const childEnv = {
    ...process.env,
    PORT: String(rendererPort),
    TRAYCER_DESKTOP_DEV: "1",
    TRAYCER_DESKTOP_DEV_URL: rendererUrl,
  };
  // The renderer bundle has no `process.env`; expose the multi-run slot to it
  // through Vite so `renderer-shell/sign-in-url.ts` derives the same
  // slot-suffixed deep-link scheme the main process registers.
  if (typeof process.env.DEV_DESKTOP_SLOT === "string") {
    childEnv.VITE_DEV_DESKTOP_SLOT = process.env.DEV_DESKTOP_SLOT;
  }

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
};
