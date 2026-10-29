import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_OBJECT_SPAN_BYTES,
  type SandboxArtifactCancel,
  type SandboxArtifactRequest,
} from "../../../ipc-contracts/sandbox-artifact-types";
import { SandboxArtifactServer } from "../../app/sandbox-artifact-server";
import {
  installSandboxProtocolHandler,
  isSandboxArtifactUrl,
  parseSandboxArtifactHost,
} from "../../app/sandbox-protocol";
import {
  isAllowedAppSubframeNavigation,
  isSandboxSubframePermissionGranted,
} from "../../app/security";
import { parseSandboxArtifactReply } from "../ipc-parsers";

type ProtocolHandler = (request: { readonly url: string }) => Promise<Response>;

const protocolState = vi.hoisted(() => ({
  handler: null as ProtocolHandler | null,
  loaderFetchCalls: 0,
}));

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  dialog: {},
  session: { defaultSession: {} },
  protocol: {
    handle: (_scheme: string, handler: ProtocolHandler): void => {
      protocolState.handler = handler;
    },
  },
  net: {
    fetch: (): Promise<Response> => {
      protocolState.loaderFetchCalls += 1;
      return Promise.resolve(new Response("loader body", { status: 200 }));
    },
  },
}));

vi.mock("../../../config", () => ({
  isDevBuild: true,
  config: { environment: "dev" },
}));

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * A real `Request`, with `.url` overwritten to the exact raw string given.
 * `new Request(dottedUrl)` itself would normalize away a literal `..`
 * segment at construction time - `fetch()` reads the raw string precisely to
 * defend against that, so only a double like this (a real `Request`, with
 * only the one property replaced) can exercise its own guard.
 */
function rawRequest(url: string): Request {
  const request = new Request(
    "traycer-sandbox://artifact-report--mount1/placeholder.html",
  );
  Object.defineProperty(request, "url", { value: url });
  return request;
}

interface RecordedSend {
  readonly windowId: string;
  readonly request: SandboxArtifactRequest;
}

/** `SandboxArtifactCancel` has no `mountId`; every real span request does. */
function isArtifactRequest(
  payload: SandboxArtifactRequest | SandboxArtifactCancel,
): payload is SandboxArtifactRequest {
  return "mountId" in payload;
}

/** A server that answers every span request with real bytes, deriving the span from what was asked. */
function buildAutoRespondingServer(
  totalBytes: number,
  mediaType: string,
): { readonly server: SandboxArtifactServer; readonly sent: RecordedSend[] } {
  const sent: RecordedSend[] = [];
  const server = new SandboxArtifactServer((windowId, _channel, payload) => {
    // A cancel notification needs no answer - the renderer just stops
    // reading. Only a real span request is tracked and auto-answered.
    if (!isArtifactRequest(payload)) return true;
    const request = payload;
    sent.push({ windowId, request });
    const length = Math.min(
      request.length,
      Math.max(totalBytes - request.offset, 0),
    );
    queueMicrotask(() => {
      server.respond(
        {
          requestId: request.requestId,
          kind: "bytes",
          bytes: new Uint8Array(length).fill(7),
          offset: request.offset,
          totalBytes,
          mediaType,
        },
        windowId,
      );
    });
    return true;
  });
  return { server, sent };
}

afterEach(() => {
  protocolState.handler = null;
  protocolState.loaderFetchCalls = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseSandboxArtifactHost", () => {
  it.each([
    ["artifact-report--mount1", { artifactId: "report", mountId: "mount1" }],
    [
      "artifact-my-report_v2--abc123",
      { artifactId: "my-report_v2", mountId: "abc123" },
    ],
  ])("parses %s", (host, expected) => {
    expect(parseSandboxArtifactHost(host)).toEqual(expected);
  });

  it("splits at the LAST '--' so an artifactId containing '--' still resolves", () => {
    expect(parseSandboxArtifactHost("artifact-x--y--mount1")).toEqual({
      artifactId: "x--y",
      mountId: "mount1",
    });
  });

  it.each([
    "artifact-report", // no "--" separator at all
    "page", // not an artifact host
    "artifact---mount1", // empty artifactId
    "artifact-report--", // empty mountId
    "artifact-REPORT--mount1", // uppercase artifactId
    "artifact-report--MOUNT1", // uppercase mountId
    "artifact-report--mount_1", // underscore not allowed in mountId
  ])("rejects %s", (host) => {
    expect(parseSandboxArtifactHost(host)).toBeNull();
  });
});

describe("isSandboxArtifactUrl", () => {
  it.each([
    "traycer-sandbox://artifact-report--mount1/index.html",
    "traycer-sandbox://artifact-report--mount1/docs/page.html?x=1",
  ])("accepts %s", (url) => {
    expect(isSandboxArtifactUrl(url)).toBe(true);
  });

  it.each([
    "traycer-sandbox://page/index.html", // the loader host, not an artifact
    "traycer-sandbox://artifact-REPORT--mount1/index.html", // invalid artifactId
    "https://artifact-report--mount1/index.html", // wrong scheme
    "traycer-sandbox://user:pass@artifact-report--mount1/index.html", // userinfo present
    "not a url",
  ])("rejects %s", (url) => {
    expect(isSandboxArtifactUrl(url)).toBe(false);
  });
});

describe("installSandboxProtocolHandler: artifact routing", () => {
  it("routes an artifact host to the server's own fetch, bypassing the loader fetch", async () => {
    const server = new SandboxArtifactServer(() => true);
    const fakeResponse = new Response("artifact body", { status: 200 });
    const fetchSpy = vi.spyOn(server, "fetch").mockResolvedValue(fakeResponse);
    installSandboxProtocolHandler(server);
    if (protocolState.handler === null)
      throw new Error("handler not installed");

    const url = "traycer-sandbox://artifact-report--mount1/index.html";
    const response = await protocolState.handler({ url });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ url }));
    expect(response).toBe(fakeResponse);
    expect(protocolState.loaderFetchCalls).toBe(0);
  });

  it("still serves the loader page for host `page`, unaffected by artifact routing", async () => {
    const server = new SandboxArtifactServer(() => true);
    const fetchSpy = vi.spyOn(server, "fetch");
    installSandboxProtocolHandler(server);
    if (protocolState.handler === null)
      throw new Error("handler not installed");

    const response = await protocolState.handler({
      url: "traycer-sandbox://page/index.html",
    });
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Unlike an artifact response, the loader declares no CORS origin - its
    // one consumer is the app's own opaque sandbox frame, not a page's own
    // fetch.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("404s a host that is neither the loader nor a valid artifact host, without reaching the server or the loader fetch", async () => {
    const server = new SandboxArtifactServer(() => true);
    const fetchSpy = vi.spyOn(server, "fetch");
    installSandboxProtocolHandler(server);
    if (protocolState.handler === null)
      throw new Error("handler not installed");

    const response = await protocolState.handler({
      url: "traycer-sandbox://other/index.html",
    });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(protocolState.loaderFetchCalls).toBe(0);
  });

  it("routes to the server even when that server answers the mount as unknown - routing is by host shape, availability is the server's call", async () => {
    const server = new SandboxArtifactServer(() => true);
    const fetchSpy = vi
      .spyOn(server, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));
    installSandboxProtocolHandler(server);
    if (protocolState.handler === null)
      throw new Error("handler not installed");

    const response = await protocolState.handler({
      url: "traycer-sandbox://artifact-report--unregistered/index.html",
    });
    expect(response.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("SandboxArtifactServer: mount registration", () => {
  it("registers and tracks ownership, rejects an invalid mount id", () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    expect(server.ownsMount("mount1", "window-a")).toBe(true);
    expect(server.ownsMount("mount1", "window-b")).toBe(false);
    expect(() => server.register("MOUNT1", "window-a")).toThrow(
      "Invalid artifact mount id",
    );
  });

  it("allows the same window to re-register, refuses a different window", () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    expect(() => server.register("mount1", "window-a")).not.toThrow();
    expect(() => server.register("mount1", "window-b")).toThrow(
      "Artifact mount belongs to another window",
    );
  });

  it("unregister drops ownership", () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    server.unregister("mount1");
    expect(server.ownsMount("mount1", "window-a")).toBe(false);
  });
});

describe("SandboxArtifactServer: fetch path handling", () => {
  it.each([
    "traycer-sandbox://artifact-report--mount1/../secret",
    "traycer-sandbox://artifact-report--mount1/a/../b",
  ])(
    "answers 400 for a literal '..' segment, read from the raw request url: %s",
    async (url) => {
      const server = new SandboxArtifactServer(() => true);
      server.register("mount1", "window-a");
      const response = await server.fetch(rawRequest(url));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid artifact path");
    },
  );

  it("answers 400 for a backslash in the (percent-encoded) path", async () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/a%5Cb"),
    );
    expect(response.status).toBe(400);
  });

  it("answers 400 for an empty path segment", async () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/a//b"),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ["", "index.html"],
    ["/", "index.html"],
    ["/docs/", "docs/index.html"],
  ])(
    "maps a bare or trailing-slash path (%s) to %s",
    async (suffix, expectedPath) => {
      const { server, sent } = buildAutoRespondingServer(10, "text/html");
      server.register("mount1", "window-a");
      await server.fetch(
        new Request(`traycer-sandbox://artifact-report--mount1${suffix}`),
      );
      expect(sent[0]?.request.path).toBe(expectedPath);
    },
  );
});

describe("SandboxArtifactServer: fetch range responses", () => {
  it("answers 206 for a range within a single span", async () => {
    const totalBytes = 1000;
    const { server, sent } = buildAutoRespondingServer(totalBytes, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=0-99" },
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(response.headers.get("Content-Length")).toBe("100");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(100);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.offset).toBe(0);
    expect(sent[0]?.request.length).toBe(100);
  });

  it("caps a requested span at ARTIFACT_OBJECT_SPAN_BYTES", async () => {
    const totalBytes = 10_000_000;
    const { server, sent } = buildAutoRespondingServer(totalBytes, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=0-9999999" },
      }),
    );
    expect(response.status).toBe(206);
    expect(sent[0]?.request.length).toBe(ARTIFACT_OBJECT_SPAN_BYTES);
    expect(response.headers.get("Content-Length")).toBe(
      String(ARTIFACT_OBJECT_SPAN_BYTES),
    );
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 0-${ARTIFACT_OBJECT_SPAN_BYTES - 1}/${totalBytes}`,
    );
  });

  it("answers 416 for a malformed Range header, with no Content-Range since the total is not known yet", async () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=abc" },
      }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBeNull();
  });

  it("answers 416 with Content-Range: bytes */total for a range starting past end of file", async () => {
    const totalBytes = 1000;
    const { server } = buildAutoRespondingServer(totalBytes, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=5000-5100" },
      }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("answers 206 for an open-ended range (bytes=N-), capped at one span", async () => {
    const totalBytes = 10_000_000;
    const { server, sent } = buildAutoRespondingServer(totalBytes, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=100-" },
      }),
    );
    expect(response.status).toBe(206);
    expect(sent[0]?.request.offset).toBe(100);
    expect(sent[0]?.request.length).toBe(ARTIFACT_OBJECT_SPAN_BYTES);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 100-${100 + ARTIFACT_OBJECT_SPAN_BYTES - 1}/${totalBytes}`,
    );
  });

  it.each([
    "bytes=-500", // suffix form ("last 500 bytes") - not the one supported shape
    "bytes=0-99,200-299", // multiple ranges - not the one supported shape
    "bytes=100-50", // reversed - end before start
    "bytes=99999999999999999999-99999999999999999999999999", // not a safe integer
  ])("answers 416 for an unsupported or invalid Range: %s", async (range) => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: range },
      }),
    );
    expect(response.status).toBe(416);
  });

  it("answers 416 with Content-Range bytes */0 for a ranged request against an empty file", async () => {
    const { server } = buildAutoRespondingServer(0, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=0-0" },
      }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */0");
  });

  it("an artifact response carries Access-Control-Allow-Origin: *", async () => {
    const { server } = buildAutoRespondingServer(10, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/index.html"),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("SandboxArtifactServer: fetch full (non-range) responses", () => {
  it("streams a file larger than one span as two spans, closing after the exact byte count", async () => {
    const totalBytes = ARTIFACT_OBJECT_SPAN_BYTES + 100;
    const { server, sent } = buildAutoRespondingServer(totalBytes, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(totalBytes));
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(totalBytes);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.request.offset).toBe(0);
    expect(sent[0]?.request.length).toBe(ARTIFACT_OBJECT_SPAN_BYTES);
    expect(sent[1]?.request.offset).toBe(ARTIFACT_OBJECT_SPAN_BYTES);
    expect(sent[1]?.request.length).toBe(ARTIFACT_OBJECT_SPAN_BYTES);
  });

  it("errors the stream, rather than truncating it, if a later span disagrees with the first on totalBytes", async () => {
    const totalBytes = ARTIFACT_OBJECT_SPAN_BYTES + 100;
    let callCount = 0;
    const server = new SandboxArtifactServer((windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) return true;
      const request = payload;
      callCount += 1;
      const thisCall = callCount;
      queueMicrotask(() => {
        server.respond(
          {
            requestId: request.requestId,
            kind: "bytes",
            bytes: new Uint8Array(
              Math.min(
                request.length,
                Math.max(totalBytes - request.offset, 0),
              ),
            ),
            offset: request.offset,
            // The second span disagrees with the first about the file's size.
            totalBytes: thisCall === 1 ? totalBytes : totalBytes + 1,
            mediaType: "text/html",
          },
          windowId,
        );
      });
      return true;
    });
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html"),
    );
    // Headers have already left with the first span's totalBytes; only the
    // body can fail from here.
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body reader");
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      })(),
    ).rejects.toThrow("Artifact stream unavailable");
  });

  it("errors the stream if a later span disagrees with the first on mediaType", async () => {
    const totalBytes = ARTIFACT_OBJECT_SPAN_BYTES + 100;
    let callCount = 0;
    const server = new SandboxArtifactServer((windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) return true;
      const request = payload;
      callCount += 1;
      const thisCall = callCount;
      queueMicrotask(() => {
        server.respond(
          {
            requestId: request.requestId,
            kind: "bytes",
            bytes: new Uint8Array(
              Math.min(
                request.length,
                Math.max(totalBytes - request.offset, 0),
              ),
            ),
            offset: request.offset,
            totalBytes,
            // The second span disagrees with the first about the media type.
            mediaType: thisCall === 1 ? "text/html" : "application/json",
          },
          windowId,
        );
      });
      return true;
    });
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html"),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body reader");
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      })(),
    ).rejects.toThrow("Artifact stream unavailable");
  });

  it.each([
    ["short", (length: number) => length - 1],
    ["long", (length: number) => length + 1],
  ])(
    "answers 503 when the renderer's span is %s (byte count does not match what was asked)",
    async (_label, adjustLength) => {
      const totalBytes = 1000;
      const server = new SandboxArtifactServer(
        (windowId, _channel, payload) => {
          if (!isArtifactRequest(payload)) return true;
          const request = payload;
          queueMicrotask(() => {
            const wrongLength = adjustLength(
              Math.min(request.length, totalBytes - request.offset),
            );
            server.respond(
              {
                requestId: request.requestId,
                kind: "bytes",
                bytes: new Uint8Array(Math.max(wrongLength, 0)),
                offset: request.offset,
                totalBytes,
                mediaType: "text/html",
              },
              windowId,
            );
          });
          return true;
        },
      );
      server.register("mount1", "window-a");
      const response = await server.fetch(
        new Request("traycer-sandbox://artifact-report--mount1/report.html", {
          headers: { Range: "bytes=0-99" },
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Invalid artifact span");
    },
  );

  it("answers 503 when the renderer's span answers at the wrong offset", async () => {
    const totalBytes = 1000;
    const server = new SandboxArtifactServer((windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) return true;
      const request = payload;
      queueMicrotask(() => {
        server.respond(
          {
            requestId: request.requestId,
            kind: "bytes",
            bytes: new Uint8Array(100),
            // Answers a span starting one byte later than what was asked.
            offset: request.offset + 1,
            totalBytes,
            mediaType: "text/html",
          },
          windowId,
        );
      });
      return true;
    });
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html", {
        headers: { Range: "bytes=0-99" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Invalid artifact span");
  });

  it("answers 200 with an empty body for a non-range fetch of an empty file", async () => {
    const { server } = buildAutoRespondingServer(0, "text/html");
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(0);
  });
});

describe("SandboxArtifactServer: fetch errors", () => {
  it("answers 404 for an unregistered mount without asking any renderer", async () => {
    const sent: SandboxArtifactRequest[] = [];
    const server = new SandboxArtifactServer((_windowId, _channel, payload) => {
      if (isArtifactRequest(payload)) sent.push(payload);
      return true;
    });
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--unknown1/index.html"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Artifact mount not found");
    expect(sent).toHaveLength(0);
  });

  it("answers 404 for a host that is not a valid artifact host", async () => {
    const server = new SandboxArtifactServer(() => true);
    const response = await server.fetch(
      new Request("traycer-sandbox://not-an-artifact/index.html"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Artifact not found");
  });

  it("answers 503 immediately when sending to the window fails", async () => {
    const server = new SandboxArtifactServer(() => false);
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/index.html"),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Artifact window unavailable");
  });
});

describe("SandboxArtifactServer: window cleanup", () => {
  it("dropWindow fails that window's pending requests and removes only its mounts", async () => {
    const server = new SandboxArtifactServer(() => true); // sends succeed, nothing ever answers
    server.register("mounta", "window-a");
    server.register("mountb", "window-b");
    const pendingA = server.fetch(
      new Request("traycer-sandbox://artifact-report--mounta/index.html"),
    );

    server.dropWindow("window-a");

    const response = await pendingA;
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Artifact window unavailable");
    expect(server.ownsMount("mounta", "window-a")).toBe(false);
    expect(server.ownsMount("mountb", "window-b")).toBe(true);

    const afterDrop = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mounta/index.html"),
    );
    expect(afterDrop.status).toBe(404);
  });

  it("retainWindows drops every mount not in the given set", () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mounta", "window-a");
    server.register("mountb", "window-b");
    server.retainWindows(new Set(["window-a"]));
    expect(server.ownsMount("mounta", "window-a")).toBe(true);
    expect(server.ownsMount("mountb", "window-b")).toBe(false);
  });

  it("dispose fails every pending request and clears every mount", async () => {
    const server = new SandboxArtifactServer(() => true);
    server.register("mount1", "window-a");
    const pending = server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/index.html"),
    );
    server.dispose();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(server.ownsMount("mount1", "window-a")).toBe(false);
  });
});

describe("SandboxArtifactServer: respond", () => {
  it("ignores a reply that arrives after the request has already settled", async () => {
    let requestId = "";
    const server = new SandboxArtifactServer((_windowId, _channel, payload) => {
      if (isArtifactRequest(payload)) requestId = payload.requestId;
      return false; // settles immediately as unavailable
    });
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/index.html"),
    );
    expect(response.status).toBe(503);
    expect(() =>
      server.respond(
        {
          requestId,
          kind: "bytes",
          bytes: new Uint8Array(1),
          offset: 0,
          totalBytes: 1,
          mediaType: "text/html",
        },
        "window-a",
      ),
    ).not.toThrow();
  });
});

describe("isAllowedAppSubframeNavigation: artifact documents at the sandbox root", () => {
  it.each([
    "traycer-sandbox://artifact-report--mount1/index.html",
    "traycer-sandbox://artifact-report--mount1/",
    "traycer-sandbox://artifact-report--mount1/docs/page.htm",
    // A trailing-slash directory normalizes to its index document, the same
    // as a real fetch of it would - the navigation guard and the server
    // share `normalizeSandboxArtifactPath`, so this has to agree with it.
    "traycer-sandbox://artifact-report--mount1/docs/",
  ])("allows a sandbox root to load an artifact document: %s", (url) => {
    expect(isAllowedAppSubframeNavigation(url, true)).toBe(true);
  });

  it.each([
    "traycer-sandbox://artifact-report--mount1/script.js",
    "traycer-sandbox://artifact-report--mount1/style.css",
    // A literal ".." segment fails `normalizeSandboxArtifactPath` outright
    // (null path), independent of it ending in "/" or ".html".
    "traycer-sandbox://artifact-report--mount1/docs/../x/",
  ])(
    "denies a sandbox root loading a non-document artifact path: %s",
    (url) => {
      expect(isAllowedAppSubframeNavigation(url, true)).toBe(false);
    },
  );

  it("still allows the loader URL at the sandbox root, unchanged", () => {
    expect(
      isAllowedAppSubframeNavigation("traycer-sandbox://page/index.html", true),
    ).toBe(true);
  });

  it("leaves a nested (non-root) frame's rules unchanged: no artifact exception below the root", () => {
    expect(
      isAllowedAppSubframeNavigation(
        "traycer-sandbox://artifact-report--mount1/index.html",
        false,
      ),
    ).toBe(false);
    expect(isAllowedAppSubframeNavigation("https://example.com/", false)).toBe(
      true,
    );
  });
});

describe("artifact URLs declare no permission grants, even with ?perm=", () => {
  it("grants nothing for an artifact URL carrying a perm query", () => {
    const url =
      "traycer-sandbox://artifact-report--mount1/index.html?perm=camera,microphone,geolocation";
    expect(isSandboxSubframePermissionGranted("media", url, ["video"])).toBe(
      false,
    );
    expect(isSandboxSubframePermissionGranted("geolocation", url, [])).toBe(
      false,
    );
    expect(
      isSandboxSubframePermissionGranted("clipboard-sanitized-write", url, []),
    ).toBe(false);
  });
});

describe("SandboxArtifactServer: cancellation", () => {
  it("aborting the fetch's own signal cancels the pending request, settles it unavailable, and sends sandboxArtifactCancel exactly once", async () => {
    const cancels: SandboxArtifactCancel[] = [];
    const requests: SandboxArtifactRequest[] = [];
    const server = new SandboxArtifactServer((_windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) {
        cancels.push(payload);
        return true;
      }
      requests.push(payload); // never answered - the test cancels instead
      return true;
    });
    server.register("mount1", "window-a");
    const controller = new AbortController();
    const pending = server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/index.html", {
        signal: controller.signal,
      }),
    );
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Artifact request cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.requestId).toBe(requests[0]?.requestId);
  });

  it("cancelling the stream reader sends sandboxArtifactCancel for the span still in flight", async () => {
    const totalBytes = ARTIFACT_OBJECT_SPAN_BYTES + 100;
    const cancels: SandboxArtifactCancel[] = [];
    let secondRequestId = "";
    let resolveSecondSpanStarted: () => void = () => undefined;
    const secondSpanStarted = new Promise<void>((resolve) => {
      resolveSecondSpanStarted = resolve;
    });
    const server = new SandboxArtifactServer((windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) {
        cancels.push(payload);
        return true;
      }
      if (payload.offset === 0) {
        // Answer the first span right away so the stream asks for a second.
        queueMicrotask(() => {
          server.respond(
            {
              requestId: payload.requestId,
              kind: "bytes",
              bytes: new Uint8Array(ARTIFACT_OBJECT_SPAN_BYTES).fill(1),
              offset: 0,
              totalBytes,
              mediaType: "text/html",
            },
            windowId,
          );
        });
        return true;
      }
      // The second span (offset > 0) is left pending on purpose - the test
      // cancels it instead of ever answering, which is the deterministic
      // signal that it is genuinely in flight when `reader.cancel()` runs.
      secondRequestId = payload.requestId;
      resolveSecondSpanStarted();
      return true;
    });
    server.register("mount1", "window-a");
    const response = await server.fetch(
      new Request("traycer-sandbox://artifact-report--mount1/report.html"),
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body reader");

    await reader.read(); // consumes the first (buffered) span
    // Triggers `pull()` for the second span; left unawaited on purpose - it
    // settles (or errors, once cancelled) on its own, and a rejection here
    // is expected and harmless, so it is caught rather than left dangling.
    reader.read().catch(() => undefined);
    await secondSpanStarted;

    await reader.cancel();

    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.requestId).toBe(secondRequestId);
  });

  it("sends sandboxArtifactCancel on timeout, exactly once, and a late reply for it is ignored without disturbing another still-pending request", async () => {
    vi.useFakeTimers();
    const cancels: SandboxArtifactCancel[] = [];
    const requests: SandboxArtifactRequest[] = [];
    const server = new SandboxArtifactServer((_windowId, _channel, payload) => {
      if (!isArtifactRequest(payload)) {
        cancels.push(payload);
        return true;
      }
      requests.push(payload); // neither request is answered by this double
      return true;
    });
    server.register("mounta", "window-a");
    server.register("mountb", "window-a");

    const timingOut = server.fetch(
      new Request("traycer-sandbox://artifact-report--mounta/index.html"),
    );
    // Started 4 minutes after the first, so it still has a minute of its own
    // budget left when the first one's 5 minutes run out.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    const stillPending = server.fetch(
      new Request("traycer-sandbox://artifact-report--mountb/index.html"),
    );
    await vi.advanceTimersByTimeAsync(60 * 1000);

    const timedOutResponse = await timingOut;
    expect(timedOutResponse.status).toBe(503);
    expect(await timedOutResponse.text()).toBe("Artifact request timed out");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.requestId).toBe(requests[0]?.requestId);

    const firstRequestId = requests[0]?.requestId;
    if (firstRequestId === undefined) throw new Error("no first request");
    // A reply for the already-timed-out request is dropped silently.
    server.respond(
      {
        requestId: firstRequestId,
        kind: "bytes",
        bytes: new Uint8Array(1),
        offset: 0,
        totalBytes: 1,
        mediaType: "text/html",
      },
      "window-a",
    );
    expect(cancels).toHaveLength(1); // no second cancel from the dropped reply

    // The second request is still comfortably inside its own budget and is
    // unaffected by the first one's timeout and dropped late reply.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    const secondRequestId = requests[1]?.requestId;
    if (secondRequestId === undefined) throw new Error("no second request");
    server.respond(
      {
        requestId: secondRequestId,
        kind: "bytes",
        bytes: new Uint8Array(10),
        offset: 0,
        totalBytes: 10,
        mediaType: "text/html",
      },
      "window-a",
    );
    const stillPendingResponse = await stillPending;
    expect(stillPendingResponse.status).toBe(200);
    expect(cancels).toHaveLength(1); // settled normally - still no second cancel
  });
});

describe("parseSandboxArtifactReply", () => {
  it("accepts a well-formed bytes reply", () => {
    expect(
      parseSandboxArtifactReply({
        requestId: "r1",
        kind: "bytes",
        bytes: new Uint8Array([1, 2, 3]),
        offset: 0,
        totalBytes: 3,
        mediaType: "text/html",
      }),
    ).toEqual({
      requestId: "r1",
      kind: "bytes",
      bytes: new Uint8Array([1, 2, 3]),
      offset: 0,
      totalBytes: 3,
      mediaType: "text/html",
    });
  });

  it("accepts a well-formed unavailable reply", () => {
    expect(
      parseSandboxArtifactReply({
        requestId: "r1",
        kind: "unavailable",
        status: 404,
        reason: "gone",
      }),
    ).toEqual({
      requestId: "r1",
      kind: "unavailable",
      status: 404,
      reason: "gone",
    });
  });

  it.each([
    "text/html\r\nX-Injected: 1",
    "text/html\nX-Injected: 1",
    "text/html; charset=é", // non-ASCII
  ])(
    "rejects a mediaType carrying CRLF or non-ASCII bytes: %s",
    (mediaType) => {
      expect(
        parseSandboxArtifactReply({
          requestId: "r1",
          kind: "bytes",
          bytes: new Uint8Array(1),
          offset: 0,
          totalBytes: 1,
          mediaType,
        }),
      ).toBeNull();
    },
  );

  it.each([200, 500, 0, "404"])(
    "rejects an unavailable reply with an invalid status: %s",
    (status) => {
      expect(
        parseSandboxArtifactReply({
          requestId: "r1",
          kind: "unavailable",
          status,
          reason: "x",
        }),
      ).toBeNull();
    },
  );
});
