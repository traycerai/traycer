"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");

const fixture = JSON.parse(
  readFileSync(join(dirname(process.execPath), "t18-fixture.json"), "utf8"),
);
const processTime = spawnSync(
  fixture.powerShellPath,
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`,
  ],
  { encoding: "utf8", timeout: 10_000, windowsHide: true },
);
const started = processTime.stdout.trim();
if (processTime.status !== 0 || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(started)) {
  throw new Error("The disposable runtime creation time is unconfirmed");
}

const server = createServer((request, response) => {
  if (request.url !== "/activity") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end('{"busy":false}');
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const metadata = {
    pid: process.pid,
    hostId: "t18-disposable-host",
    version: fixture.hostVersion,
    websocketUrl: `ws://127.0.0.1:${port}/rpc`,
    startedAt: started,
    processStartIdentity: `win32:${started}`,
  };
  const body = JSON.stringify(metadata);
  const temporary = `${fixture.pidFile}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { flag: "wx" });
  writeFileSync(join(fixture.root, `runtime.${process.pid}.json`), body, {
    flag: "wx",
  });
  renameSync(temporary, fixture.pidFile);
});
