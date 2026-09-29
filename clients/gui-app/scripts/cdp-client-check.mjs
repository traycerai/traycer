// Standalone check that a gate's CDP client rejects in-flight requests as soon
// as its socket errors or closes, instead of leaving them to the per-request
// timeout (an interrupted browser must fail a gate promptly).
//
//   bun scripts/cdp-client-check.mjs                      # shared client
//   bun scripts/cdp-client-check.mjs --client ./other.mjs # any module exporting connect(url, exceptions, requestTimeout)
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const clientIndex = args.indexOf("--client");
const clientPath =
  clientIndex < 0
    ? new URL("./gate-browser-support.mjs", import.meta.url).href
    : pathToFileURL(path.resolve(args[clientIndex + 1])).href;
const { connect } = await import(clientPath);

// The request timeout handed to the client. Long, so only a failure-driven
// rejection can beat REJECT_DEADLINE_MS.
const REQUEST_TIMEOUT_MS = 60_000;
const REJECT_DEADLINE_MS = 1_500;

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last = null;
  readyState = FakeSocket.CONNECTING;
  constructor() {
    super();
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }
  send() {}
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
globalThis.WebSocket = FakeSocket;

async function rejectsPromptly(name, failSocket) {
  const client = await connect("ws://fake", [], REQUEST_TIMEOUT_MS);
  const request = client.send("Runtime.evaluate", {});
  // Attach the handler now: a rejection that lands before the race starts
  // must not count as unhandled.
  const outcome = request.then(
    () => "resolved",
    (error) => `rejected: ${error.message}`,
  );
  failSocket(FakeSocket.last);
  const result = await Promise.race([
    outcome,
    new Promise((resolve) =>
      setTimeout(() => resolve("still pending"), REJECT_DEADLINE_MS),
    ),
  ]);
  assert(
    typeof result === "string" && result.startsWith("rejected"),
    `${name}: in-flight request was ${result}, expected a prompt rejection`,
  );
}

await rejectsPromptly("socket close", (socket) =>
  socket.dispatchEvent(new Event("close")),
);
await rejectsPromptly("socket error", (socket) =>
  socket.dispatchEvent(new Event("error")),
);
console.log("PASS pending CDP requests reject on socket close and error");
process.exit(0);
