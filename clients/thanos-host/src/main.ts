#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startRpcServer } from "./rpc-server";

const HOST_ID = "thanos-local";
const HOST_VERSION = "0.0.0-thanos";

function readHostDataDir(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf("--host-data-dir");
  if (flagIndex === -1) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    return undefined;
  }
  return value;
}

const hostDataDir = readHostDataDir(process.argv);
if (hostDataDir === undefined) {
  process.stderr.write("missing --host-data-dir <dir>\n");
  process.exit(1);
}

await mkdir(hostDataDir, { recursive: true });

const listening = startRpcServer({
  hostname: "127.0.0.1",
  port: 0,
});

await writeFile(
  join(hostDataDir, "pid.json"),
  JSON.stringify({
    pid: process.pid,
    hostId: HOST_ID,
    version: HOST_VERSION,
    websocketUrl: listening.url,
    startedAt: new Date().toISOString(),
  }),
);

console.log(listening.url);

const shutdown = (): void => {
  listening.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
