import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  EnvironmentCloudError,
  fetchEnvironmentTransport,
  type EnvironmentCloud,
  type EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  readMcpPromoteIntent,
  recordMcpPromoteIntent,
} from "@traycer-clients/shared/environment/mcp-promote-intent";

const AUTHN = "https://authn.example.test/";
const TOKEN = "synthetic-test-bearer";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const SERVER_ID = "00000000-0000-4000-8000-000000000002";

function cloud(transport: EnvironmentCloud["transport"]): EnvironmentCloud {
  const bearer: CloudBearerSource = {
    kind: "cloud",
    getBearerToken: () => TOKEN,
  };
  return {
    authnBaseUrl: AUTHN,
    bearer,
    transport,
    onOriginSignIn: () => true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP promote intent authn calls", () => {
  it("records the binding and reads the intent state through the person's bearer", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const transport: EnvironmentCloud["transport"] = async (request) => {
      requests.push(request);
      if (request.method === "POST") {
        return {
          status: 200,
          text: JSON.stringify({
            operationId: OPERATION_ID,
            endsAt: 2_000_000_000,
          }),
        };
      }
      return {
        status: 200,
        text: JSON.stringify({ state: "consumed", mcpServerId: SERVER_ID }),
      };
    };
    const source = cloud(transport);

    await recordMcpPromoteIntent(source, "env-a", {
      operationId: OPERATION_ID,
      sourceHostId: "host-a",
      sourceSharingGeneration: 7,
      serverName: "github",
    });
    const state = await readMcpPromoteIntent(source, "env-a", OPERATION_ID);

    expect(state).toEqual({ state: "consumed", mcpServerId: SERVER_ID });
    expect(
      requests.map(({ method, url, body }) => ({ method, url, body })),
    ).toEqual([
      {
        method: "POST",
        url: `${AUTHN}api/v3/environments/env-a/mcp-servers/promote-intents`,
        body: {
          operationId: OPERATION_ID,
          kind: "mcp_promote",
          sourceHostId: "host-a",
          sourceSharingGeneration: 7,
          serverName: "github",
        },
      },
      {
        method: "GET",
        url: `${AUTHN}api/v3/environments/env-a/mcp-servers/promote-intents/${OPERATION_ID}`,
        body: null,
      },
    ]);
    expect(requests.map(({ headers }) => headers.Authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
  });

  it("sends an intent credential request manually and treats a 3xx as refusal", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.example.test/collect" },
      }),
    );

    await expect(
      recordMcpPromoteIntent(cloud(fetchEnvironmentTransport), "env-a", {
        operationId: OPERATION_ID,
        sourceHostId: "host-a",
        sourceSharingGeneration: 7,
        serverName: "github",
      }),
    ).rejects.toMatchObject({
      name: "EnvironmentCloudError",
      kind: "unavailable",
    } satisfies Partial<EnvironmentCloudError>);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0] ?? [];
    expect(input).toBe(
      `${AUTHN}api/v3/environments/env-a/mcp-servers/promote-intents`,
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.body).toBe(
      JSON.stringify({
        operationId: OPERATION_ID,
        kind: "mcp_promote",
        sourceHostId: "host-a",
        sourceSharingGeneration: 7,
        serverName: "github",
      }),
    );
  });
});
