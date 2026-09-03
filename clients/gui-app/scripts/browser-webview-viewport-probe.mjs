import assert from "node:assert/strict";
import resolutionHelpers from "../../desktop/scripts/resolution/helpers.cjs";

const { connectCdp, waitForInspectablePage } = resolutionHelpers;

const args = parseArgs(process.argv.slice(2));
await verifyWorktree(args.port, args.worktreeTag);
const target = await waitForInspectablePage(args.port, 5_000);
assert.match(
  String(target.url),
  /^https?:\/\/(localhost|127\.0\.0\.1):\d+\//,
  "Traycer renderer target not found",
);
const client = await connectCdp(target.webSocketDebuggerUrl);
const result = await client.send("Runtime.evaluate", {
  expression: `(async () => {
    const wrappers = [...document.querySelectorAll('[data-browser-guest-state="presented"]')];
    return Promise.all(wrappers.map(async (wrapper) => {
      const webview = wrapper.querySelector("webview");
      if (!(webview instanceof HTMLElement) || typeof webview.executeJavaScript !== "function") {
        throw new Error("Presented browser guest has no Electron webview");
      }
      const rect = webview.getBoundingClientRect();
      const guest = await webview.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      return {
        registrationId: wrapper.getAttribute("data-browser-guest-registration"),
        outer: { width: rect.width, height: rect.height },
        guest,
      };
    }));
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
client.close();
assert.equal(
  result.exceptionDetails,
  undefined,
  result.exceptionDetails?.exception?.description ??
    result.exceptionDetails?.text,
);
const measurements = result.result.value;

assert.ok(
  measurements.length > 0,
  "Open at least one presented Electron browser tile before running the probe",
);
for (const measurement of measurements) {
  const widthDelta = Math.abs(
    measurement.outer.width - measurement.guest.width,
  );
  const heightDelta = Math.abs(
    measurement.outer.height - measurement.guest.height,
  );
  assert.ok(
    widthDelta <= 1 && heightDelta <= 1,
    `Browser guest ${measurement.registrationId ?? "<unknown>"} viewport does not fill its webview: ${JSON.stringify(measurement)}`,
  );
}

console.log(
  `browser webview viewport probe passed: ${JSON.stringify(measurements)}`,
);

function parseArgs(argv) {
  const flags = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (match === null || !["port", "worktree-tag"].includes(match[1])) {
      throw new Error(`Unrecognized argument: ${argument}`);
    }
    flags.set(match[1], match[2]);
  }
  const port = Number(flags.get("port"));
  assert.ok(Number.isInteger(port) && port > 0, "--port=<n> is required");
  const worktreeTag = flags.get("worktree-tag");
  assert.ok(worktreeTag, "--worktree-tag=<str> is required");
  return { port, worktreeTag };
}

async function verifyWorktree(port, worktreeTag) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.equal(
    response.ok,
    true,
    `Could not reach Electron CDP on port ${port}`,
  );
  const version = await response.json();
  const userAgent = String(version["User-Agent"] ?? "");
  assert.ok(
    userAgent.toLowerCase().includes(worktreeTag.toLowerCase()),
    `Port ${port} is not the ${worktreeTag} Live Dev Instance`,
  );
}
