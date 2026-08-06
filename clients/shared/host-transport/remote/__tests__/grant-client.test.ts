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

  it("maps 401/403 to unauthorized, with the status + body in the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "nope" }, 403)),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "unauthorized" });
    if (result.kind === "unauthorized") {
      expect(result.detail).toContain("HTTP 403");
      expect(result.detail).toContain("nope");
    }
  });

  it("maps a 5xx to network-error, carrying the status in the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({}, 503)),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      expect(result.detail).toContain("HTTP 503");
    }
  });

  it("fails closed on a body missing expires_in (old ISO shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ grant: "jws", expiresAt: "2026-01-01" }, 200),
      ),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toMatchObject({
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
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      // The thrown error's message survives into the detail - a DNS failure,
      // a refusal, and the 10s mint timeout must not read identically.
      expect(result.detail).toContain("boom");
    }
  });
});

describe("mintAttachGrantViaHttp plan-restricted discrimination", () => {
  it("403 + reason plan_restricted → plan-restricted (entitlement, not auth)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            statusCode: 403,
            error: "Remote host connectivity requires a paid plan",
            reason: "plan_restricted",
          },
          403,
        ),
      ),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "plan-restricted",
    });
  });

  it("403 with an unparsable body stays a credential rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("nope", { status: 403 })),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toMatchObject({
      kind: "unauthorized",
    });
  });
});

describe("createAttachGrantProvider", () => {
  it("returns unavailable when signed out (no bearer)", async () => {
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => null,
    });
    const provision = await provider();
    expect(provision).toMatchObject({ kind: "unavailable" });
    if (provision.kind === "unavailable") {
      // Points at sign-in state, not at authn's endpoint.
      expect(provision.detail).toContain("signed out");
    }
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
      kind: "ok",
      grant: { grant: "jws-xyz", expiresInSeconds: 300 },
    });
  });

  it("surfaces plan-restricted distinctly; collapses other failures to unavailable", async () => {
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { statusCode: 403, error: "x", reason: "plan_restricted" },
          403,
        ),
      ),
    );
    expect(await provider()).toEqual({ kind: "plan-restricted" });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ statusCode: 403, error: "revoked" }, 403),
      ),
    );
    expect(await provider()).toMatchObject({ kind: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({}, 503)),
    );
    expect(await provider()).toMatchObject({ kind: "unavailable" });
  });
});

describe("mint failure detail", () => {
  it("carries a 500 body through the provider - the body frequently names the outage", async () => {
    // The real staging outage body: authn had no attach-grant signing key.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            statusCode: 500,
            message: `JWE key with ID 'signing class "attach-grant"' not found`,
          },
          500,
        ),
      ),
    );
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });
    const provision = await provider();
    expect(provision).toMatchObject({ kind: "unavailable" });
    if (provision.kind === "unavailable") {
      expect(provision.detail).toContain("HTTP 500");
      expect(provision.detail).toContain("attach-grant");
    }
  });

  it("never echoes a 2xx body - it carries the grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response("secret-grant-bytes {", { status: 200 }),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      expect(result.detail).not.toContain("secret-grant-bytes");
    }
  });
});
