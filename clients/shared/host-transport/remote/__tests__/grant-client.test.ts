import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttachGrantProvider,
  mintAttachGrantViaHttp,
} from "../grant-client";

const AUTHN = "https://authn.test";
const HOST_ID = "host-1";
const BEARER = "user-bearer";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mintAttachGrantViaHttp", () => {
  it("parses T9's { grant, role, expires_in } shape and carries the TTL in seconds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ grant: "jws-abc", role: "client", expires_in: 120 }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toEqual({
      kind: "ok",
      grant: { grant: "jws-abc", expiresInSeconds: 120 },
    });

    // POST with the user bearer + a role:"client" body to the T9 endpoint.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://authn.test/api/v3/hosts/host-1/attach-grant",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(String(init?.body))).toEqual({ role: "client" });
  });

  it("maps 401/403 to unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "nope" }, 403)),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "unauthorized",
    });
  });

  it("maps a 5xx to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({}, 503)),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "network-error",
    });
  });

  it("fails closed on a body missing expires_in (old ISO shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ grant: "jws", expiresAt: "2026-01-01" }, 200),
      ),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "network-error",
    });
  });

  it("maps a thrown fetch (transport/timeout) to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("boom");
      }),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "network-error",
    });
  });
});

describe("createAttachGrantProvider", () => {
  it("returns null when signed out (no bearer)", async () => {
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => null,
    });
    expect(await provider()).toBeNull();
  });

  it("returns the minted grant on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { grant: "jws-xyz", role: "client", expires_in: 300 },
          200,
        ),
      ),
    );
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });
    expect(await provider()).toEqual({
      grant: "jws-xyz",
      expiresInSeconds: 300,
    });
  });
});
