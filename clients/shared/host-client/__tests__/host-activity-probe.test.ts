import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeHostActivity,
  probeHostActivityBusy,
} from "../host-activity-probe";

const WEBSOCKET_URL = "ws://127.0.0.1:43210/rpc";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

// Typed args (not `vi.fn(async () => …)`) so `mock.calls[0]` is a real
// [url, init] tuple rather than `[]`.
function stubFetchAnswering(response: Response) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit | undefined) => response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetchRejecting(error: Error) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit | undefined): Promise<Response> => {
      throw error;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeHostActivity", () => {
  it("reads http://<host:port>/activity from the ws://…/rpc URL", async () => {
    const fetchMock = stubFetchAnswering(jsonResponse(200, { busy: false }));

    await probeHostActivity(WEBSOCKET_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:43210/activity");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers busy:false with the reported terminal count", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false, terminalsInUse: 2 }));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: false,
      terminalsInUse: 2,
    });
  });

  it("answers busy:true with the reported terminal count", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: true, terminalsInUse: 4 }));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: true,
      terminalsInUse: 4,
    });
  });

  it("keeps a reported zero as zero", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false, terminalsInUse: 0 }));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: false,
      terminalsInUse: 0,
    });
  });

  it("reads a host that does not report the count as null, never zero", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false }));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: false,
      terminalsInUse: null,
    });
  });

  it("tells a host that did not say apart from one that could not be asked", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false }));
    const notReported = await probeHostActivity(WEBSOCKET_URL);
    stubFetchRejecting(new TypeError("fetch failed"));
    const unreachable = await probeHostActivity(WEBSOCKET_URL);

    expect(notReported).toEqual({
      kind: "answered",
      busy: false,
      terminalsInUse: null,
    });
    expect(unreachable).toEqual({ kind: "unreachable" });
    expect(notReported).not.toEqual(unreachable);
  });

  it.each([
    ["a negative integer", -1],
    ["a fractional number", 1.5],
    ["a numeric string", "2"],
    ["null", null],
    ["a boolean", true],
    ["a number past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
  ])("reads %s as a count the host did not report", async (_label, value) => {
    stubFetchAnswering(
      jsonResponse(200, { busy: false, terminalsInUse: value }),
    );

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: false,
      terminalsInUse: null,
    });
  });

  it("reads busy as true unless the body says an explicit boolean", async () => {
    stubFetchAnswering(jsonResponse(200, { terminalsInUse: 3 }));
    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: true,
      terminalsInUse: 3,
    });

    stubFetchAnswering(jsonResponse(200, { busy: "false", terminalsInUse: 3 }));
    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: true,
      terminalsInUse: 3,
    });
  });

  it("answers a non-OK response as busy with no count", async () => {
    stubFetchAnswering(jsonResponse(404, { busy: false, terminalsInUse: 5 }));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: true,
      terminalsInUse: null,
    });
  });

  it("answers a body that is not JSON as busy with no count", async () => {
    stubFetchAnswering(textResponse(200, "<html>not json</html>"));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "answered",
      busy: true,
      terminalsInUse: null,
    });
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["a string", "idle"],
  ])(
    "answers a JSON body that is %s as busy with no count",
    async (_label, body) => {
      stubFetchAnswering(jsonResponse(200, body));

      await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
        kind: "answered",
        busy: true,
        terminalsInUse: null,
      });
    },
  );

  it("is unreachable when fetch rejects", async () => {
    stubFetchRejecting(new TypeError("fetch failed"));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("is unreachable when the probe times out", async () => {
    stubFetchRejecting(new DOMException("timed out", "TimeoutError"));

    await expect(probeHostActivity(WEBSOCKET_URL)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("is unreachable for a malformed URL, without asking fetch", async () => {
    const fetchMock = stubFetchAnswering(jsonResponse(200, { busy: false }));

    await expect(probeHostActivity("not a url")).resolves.toEqual({
      kind: "unreachable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeHostActivityBusy", () => {
  it("is false for an explicit busy:false", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false }));

    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(false);
  });

  it("is not changed by a terminalsInUse key beside busy:false", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: false, terminalsInUse: 5 }));

    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(false);
  });

  it("is true for busy:true, with or without a terminal count", async () => {
    stubFetchAnswering(jsonResponse(200, { busy: true }));
    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(true);

    stubFetchAnswering(jsonResponse(200, { busy: true, terminalsInUse: 0 }));
    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(true);
  });

  it("is true when the body has no boolean busy", async () => {
    stubFetchAnswering(jsonResponse(200, { terminalsInUse: 0 }));

    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(true);
  });

  it("is true for a non-OK response", async () => {
    stubFetchAnswering(jsonResponse(404, { busy: false }));

    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(true);
  });

  it("is true when fetch rejects", async () => {
    stubFetchRejecting(new TypeError("fetch failed"));

    await expect(probeHostActivityBusy(WEBSOCKET_URL)).resolves.toBe(true);
  });
});
