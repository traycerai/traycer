import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import { fetchRegisteredHostsViaHttp } from "../remote-fetcher";

// The build that ships without sandboxes asks the registry for the plain host
// list, as it did before sandbox rows and team grouping existed.
vi.mock("../../unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const AUTHN = "https://authn.example.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRegisteredHostsViaHttp without sandboxes", () => {
  it("GETs /api/v3/hosts with no include parameter", async () => {
    const body: HostListResponse = { hosts: [] };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRegisteredHostsViaHttp(AUTHN, "jwt-abc");

    expect(result.kind).toBe("ok");
    const [url] = fetchMock.mock.calls[0];
    const requested = new URL(String(url));
    expect(requested.origin + requested.pathname).toBe(
      "https://authn.example.test/api/v3/hosts",
    );
    expect(requested.searchParams.has("include")).toBe(false);
  });
});
