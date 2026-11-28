"use strict";

const { spawnSync } = require("node:child_process");
const {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");

if (process.argv[2] === "--t18-record-worker") {
  const fixture = JSON.parse(readFileSync(process.argv[3], "utf8"));
  process.stdin.once("data", (chunk) => {
    const mode = chunk.toString().trim();
    if (mode === "swap") {
      writeFileSync(fixture.swapping, "1", { flag: "wx" });
      if (fixture.hangManifest) {
        setInterval(() => undefined, 60_000);
        return;
      }
      process.stdout.write(
        JSON.stringify({
          data: { marker: { status: "swapped", errorMessage: null } },
        }) + "\n",
      );
    } else if (/^start [0-9]+$/u.test(mode)) {
      appendFileSync(fixture.started, "start\n");
      process.stdout.write(
        JSON.stringify({
          data: { serviceRestore: "restored" },
        }) + "\n",
      );
    } else {
      process.exitCode = 2;
    }
  });
  return;
}

const fixture = JSON.parse(
  readFileSync(join(dirname(process.execPath), "t18-fixture.json"), "utf8"),
);
const role = process.argv.includes("--t18-stale-runtime") ? "stale" : "fresh";
const marker = (name) => join(fixture.root, `${role}.${name}`);
const processTime = spawnSync(
  fixture.powerShellPath,
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`,
  ],
  { encoding: "utf8", timeout: 4000, windowsHide: true },
);
const started = processTime.stdout.trim();
if (processTime.status !== 0 || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(started)) {
  throw new Error("The disposable runtime creation time is unconfirmed");
}

let activityRequests = 0;
let connections = 0;
const server = createServer((request, response) => {
  if (request.url !== "/activity") {
    response.writeHead(404).end();
    return;
  }
  activityRequests++;
  writeFileSync(marker("activity"), String(activityRequests));
  const ready = role === "stale" || existsSync(marker("allow-ready"));
  if (ready) writeFileSync(marker("served"), "1");
  response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
  response.end('{"busy":false}');
});
server.on("connection", () => {
  connections++;
  writeFileSync(marker("probed"), String(connections));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing loopback address");
  const metadata = {
    pid: process.pid,
    hostId: "t18-disposable-host",
    version: fixture.hostVersion,
    websocketUrl: `ws://127.0.0.1:${address.port}/rpc`,
    startedAt: started,
    processStartIdentity: `win32:${started}`,
  };
  writeFileSync(marker("metadata.json"), JSON.stringify(metadata));
  const observeFixtureCommands = () => {
    if (existsSync(marker("stop"))) {
      server.closeAllConnections();
      server.close(() => process.exit(0));
      return;
    }
    if (
      role === "fresh" &&
      existsSync(marker("allow-metadata")) &&
      !existsSync(marker("published"))
    ) {
      const temporary = `${fixture.pidFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx" });
      renameSync(temporary, fixture.pidFile);
      writeFileSync(marker("published"), "1");
    }
    setTimeout(observeFixtureCommands, 100);
  };
  observeFixtureCommands();
});
