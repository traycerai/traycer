import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import { readSignedFeed } from "../signed-feed";
import { loadTrustedKeys } from "../trusted-keys";
import {
  createFeedSigningKey,
  feedPayload,
  signFeedPayload,
  type FeedSigningKey,
} from "./signed-feed-test-helpers";

const paths = vi.hoisted(() => ({ cliHome: "" }));

vi.mock("../../store/paths", async (importActual) => {
  const actual = await importActual<typeof import("../../store/paths")>();
  return { ...actual, cliSharedHomeDir: () => paths.cliHome };
});

let testRoot: string;
let cliHome: string;
let signingKey: FeedSigningKey;
let previousEnvironment: string;
let previousCdnBaseUrl: string;
let previousReleaseRepo: string;
let previousHostFeedTag: string;
let previousHostFloor: string | null;
let previousCliFloor: string | null;
const servers: Server[] = [];

beforeEach(async () => {
  testRoot = join(tmpdir(), `traycer-signed-feed-${randomUUID()}`);
  cliHome = join(testRoot, "home", ".traycer", "cli");
  paths.cliHome = cliHome;
  mkdirSync(cliHome, { recursive: true });
  signingKey = createFeedSigningKey();
  writeFileSync(
    join(cliHome, "host-trusted-pubkeys"),
    `${signingKey.publicKeyText}\n`,
  );
  previousEnvironment = config.environment;
  previousCdnBaseUrl = config.releaseCdnBaseUrl;
  previousReleaseRepo = config.releaseRepo;
  previousHostFeedTag = config.hostDiscoveryTag;
  previousHostFloor = config.hostFeedFloor;
  previousCliFloor = config.cliFeedFloor;
  config.environment = "production";
  config.hostFeedFloor = null;
  config.cliFeedFloor = null;
});

afterEach(async () => {
  config.environment = previousEnvironment;
  config.releaseCdnBaseUrl = previousCdnBaseUrl;
  config.releaseRepo = previousReleaseRepo;
  config.hostDiscoveryTag = previousHostFeedTag;
  config.hostFeedFloor = previousHostFloor;
  config.cliFeedFloor = previousCliFloor;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  rmSync(testRoot, { recursive: true, force: true });
});

async function envelope(overrides: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify(feedPayload(overrides));
  return signFeedPayload(payload, signingKey);
}

async function envelopeWithByteLength(
  target: "production" | "staging",
  byteLength: number,
): Promise<string> {
  const basePayload = JSON.stringify(feedPayload({ target, padding: "" }));
  const baseEnvelope = await signFeedPayload(basePayload, signingKey);
  const paddingLength = byteLength - Buffer.byteLength(baseEnvelope);
  if (paddingLength < 0) throw new Error("target envelope size is too small");
  const payload = JSON.stringify(
    feedPayload({ target, padding: "x".repeat(paddingLength) }),
  );
  const result = await signFeedPayload(payload, signingKey);
  if (Buffer.byteLength(result) !== byteLength)
    throw new Error("signed envelope did not match its requested byte length");
  return result;
}

function startOrigin(
  bodyForRequest: (
    path: string,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      bodyForRequest(request.url ?? "/", response);
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("local feed origin did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readAt(url: string): Promise<Record<string, unknown>> {
  return readSignedFeed({
    feed: "host",
    trustedKeySet: await loadTrustedKeys(),
    urls: [url],
    fetchDocument: null,
    signal: null,
    onHeartbeat: null,
  });
}

function writeReaderScript(): string {
  const modulePath = new URL("../signed-feed.ts", import.meta.url).href;
  const trustedKeysModulePath = new URL("../trusted-keys.ts", import.meta.url)
    .href;
  const childScriptPath = join(testRoot, "read-signed-feed.mjs");
  writeFileSync(
    childScriptPath,
    [
      `const { readSignedFeed } = await import(${JSON.stringify(modulePath)});`,
      `const { loadTrustedKeys } = await import(${JSON.stringify(trustedKeysModulePath)});`,
      `try { const payload = await readSignedFeed({ feed: "host", trustedKeySet: await loadTrustedKeys(), urls: [process.argv[2]], fetchDocument: null, signal: null, onHeartbeat: null }); console.log(JSON.stringify({ accepted: payload.policyRevision })); }`,
      `catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }`,
    ].join("\n"),
  );
  return childScriptPath;
}

function runReaderProcess(
  scriptPath: string,
  home: string,
  url: string,
  onExit: (url: string) => void,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    "bun",
    [scriptPath, url],
    {
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      onExit(url);
      resolve({ code, stderr });
    });
  });
}

describe("readSignedFeed", () => {
  it.each(["production", "staging"] as const)(
    "accepts an 8 MiB signed envelope and rejects 8 MiB plus one byte for %s",
    async (target) => {
      const maxBytes = 8 * 1024 * 1024;
      config.environment = target;
      const exactEnvelope = await envelopeWithByteLength(target, maxBytes);
      const oversizedEnvelope = await envelopeWithByteLength(
        target,
        maxBytes + 1,
      );
      let exactRequests = 0;
      const exactOrigin = await startOrigin((_path, response) => {
        exactRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(exactEnvelope);
      });

      const accepted = await readAt(`${exactOrigin}/versions.signed.json`);

      expect(Buffer.byteLength(exactEnvelope)).toBe(maxBytes);
      expect(accepted.target).toBe(target);
      expect(exactRequests).toBe(1);

      let oversizedRequests = 0;
      const oversizedOrigin = await startOrigin((_path, response) => {
        oversizedRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(oversizedEnvelope);
      });

      await expect(
        readAt(`${oversizedOrigin}/versions.signed.json`),
      ).rejects.toThrow(`${maxBytes}-byte cap`);
      expect(Buffer.byteLength(oversizedEnvelope)).toBe(maxBytes + 1);
      expect(oversizedRequests).toBe(1);
    },
    30_000,
  );

  it("verifies the exact signed payload bytes from a local HTTP origin", async () => {
    const exactPayload = ` ${JSON.stringify(feedPayload({ latest: "1.5.8" }))}\n`;
    const signedEnvelope = await signFeedPayload(exactPayload, signingKey);
    let legacyRequests = 0;
    const origin = await startOrigin((path, response) => {
      if (path === "/versions.signed.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(signedEnvelope);
        return;
      }
      if (path === "/versions.json") legacyRequests += 1;
      response.writeHead(404);
      response.end("not found");
    });

    const result = await readAt(`${origin}/versions.signed.json`);

    expect(result.latest).toBe("1.5.8");
    expect(legacyRequests).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(cliHome, "feed-watermarks", "production-host.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      policyRevision: 1,
      policyDigest: "a".repeat(64),
    });
  });

  it("rejects a tampered payload without consulting an unsigned document", async () => {
    const signed = JSON.parse(await envelope({})) as {
      payload: string;
      signature: string;
      keyId: string;
    };
    const tampered = JSON.stringify({
      ...signed,
      payload: signed.payload.replace("1.5.0", "1.5.1"),
    });
    const requested: string[] = [];
    const origin = await startOrigin((path, response) => {
      requested.push(path);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(tampered);
    });

    await expect(readAt(`${origin}/versions.signed.json`)).rejects.toThrow(
      "FEED_SIGNATURE_INVALID",
    );
    expect(requested).toEqual(["/versions.signed.json"]);
  });

  it("moves to the next origin after an integrity failure", async () => {
    const signed = JSON.parse(await envelope({})) as {
      payload: string;
      signature: string;
      keyId: string;
    };
    const tamperedEnvelope = JSON.stringify({
      ...signed,
      payload: signed.payload.replace("1.5.0", "1.5.1"),
    });
    const healthyEnvelope = await envelope({ latest: "1.5.2" });
    let primaryRequests = 0;
    let fallbackRequests = 0;
    const primary = await startOrigin((_path, response) => {
      primaryRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(tamperedEnvelope);
    });
    const fallback = await startOrigin((_path, response) => {
      fallbackRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(healthyEnvelope);
    });

    const result = await readSignedFeed({
      feed: "host",
      trustedKeySet: await loadTrustedKeys(),
      urls: [
        `${primary}/versions.signed.json`,
        `${fallback}/versions.signed.json`,
      ],
      fetchDocument: null,
      signal: null,
      onHeartbeat: null,
    });

    expect(result.latest).toBe("1.5.2");
    expect(primaryRequests).toBe(1);
    expect(fallbackRequests).toBe(1);
  });

  it("moves to the next origin after a hard HTTP failure", async () => {
    const healthyEnvelope = await envelope({ latest: "1.5.3" });
    let primaryRequests = 0;
    let fallbackRequests = 0;
    const primary = await startOrigin((_path, response) => {
      primaryRequests += 1;
      response.writeHead(404);
      response.end("not found");
    });
    const fallback = await startOrigin((_path, response) => {
      fallbackRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(healthyEnvelope);
    });

    const result = await readSignedFeed({
      feed: "host",
      trustedKeySet: await loadTrustedKeys(),
      urls: [
        `${primary}/versions.signed.json`,
        `${fallback}/versions.signed.json`,
      ],
      fetchDocument: null,
      signal: null,
      onHeartbeat: null,
    });

    expect(result.latest).toBe("1.5.3");
    expect(primaryRequests).toBe(1);
    expect(fallbackRequests).toBe(1);
  });

  it("falls back to a healthy signed origin after two blackholed attempts", async () => {
    let primaryRequests = 0;
    let fallbackRequests = 0;
    let fallbackStartedAt = 0;
    const primary = await startOrigin(() => {
      primaryRequests += 1;
    });
    const healthyEnvelope = await envelope({ latest: "1.5.4" });
    const fallback = await startOrigin((_path, response) => {
      fallbackRequests += 1;
      fallbackStartedAt = Date.now();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(healthyEnvelope);
    });
    const heartbeats: Array<{ phase: string; attempt: number }> = [];
    const startedAt = Date.now();

    const result = await readSignedFeed({
      feed: "host",
      trustedKeySet: await loadTrustedKeys(),
      urls: [
        `${primary}/versions.signed.json`,
        `${fallback}/versions.signed.json`,
      ],
      fetchDocument: null,
      signal: null,
      onHeartbeat: (heartbeat) => {
        heartbeats.push({ phase: heartbeat.phase, attempt: heartbeat.attempt });
      },
    });

    expect(result.latest).toBe("1.5.4");
    expect(primaryRequests).toBe(2);
    expect(fallbackRequests).toBe(1);
    expect(fallbackStartedAt - startedAt).toBeLessThanOrEqual(21_500);
    expect(
      heartbeats.filter((heartbeat) => heartbeat.phase === "watchdog"),
    ).toHaveLength(2);
    expect(heartbeats).toContainEqual({ phase: "attempt", attempt: 3 });
  }, 30_000);

  it("rejects an envelope whose key id does not match its signature", async () => {
    const signed = JSON.parse(await envelope({})) as {
      payload: string;
      signature: string;
      keyId: string;
    };
    const mismatched = JSON.stringify({ ...signed, keyId: "0".repeat(16) });
    const origin = await startOrigin((_path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(mismatched);
    });

    await expect(readAt(`${origin}/versions.signed.json`)).rejects.toThrow(
      "FEED_KEY_ID_MISMATCH",
    );
  });

  it.each([
    [
      "expired",
      {
        generatedAt: new Date(
          Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      "FEED_EXPIRED",
    ],
    [
      "future dated",
      {
        generatedAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
      },
      "FEED_FUTURE_DATED",
    ],
    ["wrong feed", { feed: "cli" }, "FEED_WRONG_FEED"],
    ["wrong target", { target: "staging" }, "FEED_WRONG_TARGET"],
  ] as const)(
    "rejects a signed %s envelope",
    async (_label, overrides, expected) => {
      const signedEnvelope = await envelope(overrides);
      const origin = await startOrigin((_path, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(signedEnvelope);
      });
      await expect(readAt(`${origin}/versions.signed.json`)).rejects.toThrow(
        expected,
      );
    },
  );

  it("refuses a feed revision below the build stamped floor", async () => {
    config.hostFeedFloor = "2";
    const signedEnvelope = await envelope({});
    const origin = await startOrigin((_path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(signedEnvelope);
    });

    await expect(readAt(`${origin}/versions.signed.json`)).rejects.toThrow(
      "FEED_BELOW_BUILD_FLOOR",
    );
  });

  it("refuses replay and an equal revision with a conflicting policy digest", async () => {
    const firstEnvelope = await envelope({ policyRevision: 8 });
    const origin = await startOrigin((_path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(firstEnvelope);
    });
    const url = `${origin}/versions.signed.json`;
    await readAt(url);

    const replayEnvelope = await envelope({
      policyRevision: 7,
      policyDigest: "b".repeat(64),
    });
    const replayOrigin = await startOrigin((_path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(replayEnvelope);
    });
    await expect(
      readAt(`${replayOrigin}/versions.signed.json`),
    ).rejects.toThrow("FEED_REPLAYED");

    const conflictEnvelope = await envelope({
      policyRevision: 8,
      policyDigest: "b".repeat(64),
    });
    const conflictOrigin = await startOrigin((_path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(conflictEnvelope);
    });
    await expect(
      readAt(`${conflictOrigin}/versions.signed.json`),
    ).rejects.toThrow("FEED_POLICY_CONFLICT");
  });

  it("refuses an older real child reader after a newer process commits", async () => {
    const home = join(testRoot, "home");
    const watermarkDir = join(cliHome, "feed-watermarks");
    const watermarkPath = join(watermarkDir, "production-host.json");
    mkdirSync(watermarkDir, { recursive: true });
    const newerEnvelope = await envelope({
      policyRevision: 42,
      policyDigest: "a".repeat(64),
    });
    const olderEnvelope = await envelope({
      policyRevision: 41,
      policyDigest: "4".repeat(64),
    });
    const origin = await startOrigin((path, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(path === "/42" ? newerEnvelope : olderEnvelope);
    });
    const childScriptPath = writeReaderScript();
    const noOp = (_url: string): void => undefined;
    const newReader = await runReaderProcess(
      childScriptPath,
      home,
      `${origin}/42`,
      noOp,
    );
    expect(newReader.code).toBe(0);
    const oldResult = await runReaderProcess(
      childScriptPath,
      home,
      `${origin}/41`,
      noOp,
    );
    expect(oldResult.code).not.toBe(0);
    expect(oldResult.stderr).toContain("FEED_REPLAYED");
    expect(JSON.parse(readFileSync(watermarkPath, "utf8"))).toEqual({
      policyRevision: 42,
      policyDigest: "a".repeat(64),
    });
    await expect(readAt(`${origin}/41`)).rejects.toThrow("FEED_REPLAYED");
  }, 15_000);

  it("keeps revision 42 through simultaneous real processes", async () => {
    const home = join(testRoot, "home");
    const watermarkPath = join(
      cliHome,
      "feed-watermarks",
      "production-host.json",
    );
    mkdirSync(join(cliHome, "feed-watermarks"), { recursive: true });
    const newerEnvelope = await envelope({
      policyRevision: 42,
      policyDigest: "a".repeat(64),
    });
    const olderEnvelope = await envelope({
      policyRevision: 41,
      policyDigest: "4".repeat(64),
    });
    const responses = new Map<string, import("node:http").ServerResponse>();
    let releaseResponses: () => void = () => undefined;
    const bothRequested = new Promise<void>((resolve) => {
      releaseResponses = resolve;
    });
    const origin = await startOrigin((path, response) => {
      responses.set(path, response);
      if (responses.size === 2) releaseResponses();
      void bothRequested.then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(path === "/42" ? newerEnvelope : olderEnvelope);
      });
    });
    const childScriptPath = writeReaderScript();
    const completionOrder: number[] = [];
    const onReaderExit = (url: string): void => {
      completionOrder.push(Number(new URL(url).pathname.slice(1)));
    };
    const results = await Promise.all([
      runReaderProcess(childScriptPath, home, `${origin}/41`, onReaderExit),
      runReaderProcess(childScriptPath, home, `${origin}/42`, onReaderExit),
    ]);
    const olderResult = results[0];
    const newerResult = results[1];
    expect(newerResult?.code).toBe(0);
    if (olderResult === undefined)
      throw new Error("older process result missing");
    const olderFinishedSecond = completionOrder[1] === 41;
    if (olderFinishedSecond) {
      expect(olderResult.code).not.toBe(0);
      expect(olderResult.stderr).toContain("FEED_REPLAYED");
    }
    expect(JSON.parse(readFileSync(watermarkPath, "utf8"))).toEqual({
      policyRevision: 42,
      policyDigest: "a".repeat(64),
    });
  }, 15_000);

  it("reads the stamped staging CDN without GitHub credentials", async () => {
    config.environment = "staging";
    config.releaseCdnBaseUrl = "https://releases.dev.traycer.ai";
    config.releaseRepo = "acme/private-traycer";
    config.hostDiscoveryTag = "released-host-versions-staging";
    const stagingEnvelope = await envelope({ target: "staging" });
    let authorization: string | undefined;
    let localRequests = 0;
    const origin = await startOrigin((_path, response) => {
      localRequests += 1;
      authorization = response.req.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(stagingEnvelope);
    });

    const requestedOrigins: string[] = [];
    let cdnAuthorization: string | null = null;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const authorizationHeader = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get("authorization");
        requestedOrigins.push(url);
        if (
          url === "https://releases.dev.traycer.ai/host/versions.signed.json"
        ) {
          cdnAuthorization = authorizationHeader;
          return originalFetch(`${origin}/host/versions.signed.json`, init);
        }
        return originalFetch(input, init);
      });
    let result: Record<string, unknown>;
    try {
      result = await readSignedFeed({
        feed: "host",
        trustedKeySet: await loadTrustedKeys(),
        urls: null,
        fetchDocument: null,
        signal: null,
        onHeartbeat: null,
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(result.target).toBe("staging");
    expect(requestedOrigins).toEqual([
      "https://releases.dev.traycer.ai/host/versions.signed.json",
    ]);
    expect(localRequests).toBe(1);
    expect(cdnAuthorization).toBeNull();
    expect(authorization).toBeUndefined();
    expect(
      readFileSync(
        join(cliHome, "feed-watermarks", "staging-host.json"),
        "utf8",
      ),
    ).toContain('"policyRevision":1');
  });
});
