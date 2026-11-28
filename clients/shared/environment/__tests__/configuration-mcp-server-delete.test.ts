import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  deleteConfigurationMcpServer,
  putConfigurationMcpServer,
} from "../configuration-settings";
import {
  createEnvironmentCloud,
  MCP_SERVER_BODY,
} from "./environment-cloud-test-support";

const ENVIRONMENT_ID = "env-1";
const ENVIRONMENT_URL = `https://authn.example.test/api/v3/environments/${ENVIRONMENT_ID}`;
const SERVER_URL = `${ENVIRONMENT_URL}/mcp-servers/${MCP_SERVER_BODY.server.id}`;

/** An authn with no `mcp_server` item, which refuses every item write. */
function stubAuthn(): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "GET") return Response.json({ items: [] });
    if (init?.method === "POST") return Response.json(MCP_SERVER_BODY);
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    return Response.json(
      { code: "revision_conflict", current: null },
      { status: 409 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectServerRowDelete(fetchMock: Mock<typeof fetch>): void {
  const [url, init] = fetchMock.mock.lastCall ?? [];
  expect(url).toBe(SERVER_URL);
  expect(init?.method).toBe("DELETE");
  expect(new Headers(init?.headers).get("Content-Type")).toBe(
    "application/json",
  );
  expect(init?.body).toBe("{}");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an MCP server row's DELETE", () => {
  it("carries an empty JSON object when the server is deleted", async () => {
    const fetchMock = stubAuthn();

    await deleteConfigurationMcpServer(createEnvironmentCloud("bearer"), {
      environmentId: ENVIRONMENT_ID,
      serverId: MCP_SERVER_BODY.server.id,
    });

    expectServerRowDelete(fetchMock);
  });

  it("carries an empty JSON object when a new server's item write is refused", async () => {
    const fetchMock = stubAuthn();

    const result = await putConfigurationMcpServer(
      createEnvironmentCloud("bearer"),
      {
        environmentId: ENVIRONMENT_ID,
        serverId: null,
        name: MCP_SERVER_BODY.server.name,
        transport: "http",
        url: MCP_SERVER_BODY.server.url,
        command: null,
        args: [],
        env: [],
        toolToggles: {},
        offFor: [],
        credential: { kind: "none" },
      },
      null,
    );

    expect(result).toEqual({
      outcome: "refused",
      reason: "name_taken",
      serverId: null,
    });
    expectServerRowDelete(fetchMock);
  });
});
