import { describe, expect, it } from "vitest";
import { z } from "zod";
import { setConfigurationMcpServerEnabled } from "../configuration-settings";
import type {
  EnvironmentTransport,
  EnvironmentTransportRequest,
} from "../environment-cloud";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

const ENVIRONMENT_ID = "env-1";
const SERVER_ID = "server-1";
const ITEM_KEY = "docs";
const ITEMS_PATH = `/api/v3/environments/${ENVIRONMENT_ID}/items`;
const SERVER_PATH = `/api/v3/environments/${ENVIRONMENT_ID}/mcp-servers/${SERVER_ID}`;

interface ItemRow {
  kind: string;
  key: string;
  os: null;
  value: {
    mcpServerId: string;
    toolToggles: Record<string, Record<string, boolean>>;
    offFor: string[];
  };
  revision: number;
  updatedAt: number;
  writtenBy: { source: string; hostId: null; hostName: null };
}

const deleteBodySchema = z.object({ key: z.string(), revision: z.number() });

function mcpServerRow(revision: number): ItemRow {
  return {
    kind: "mcp_server",
    key: ITEM_KEY,
    os: null,
    value: {
      mcpServerId: SERVER_ID,
      toolToggles: { claude: { search: true } },
      offFor: ["codex"],
    },
    revision,
    updatedAt: 1_000,
    writtenBy: { source: "test", hostId: null, hostName: null },
  };
}

const SERVER_BODY = {
  server: {
    id: SERVER_ID,
    name: ITEM_KEY,
    transport: "http",
    url: "https://docs.example.test/mcp",
    command: null,
    args: [],
    env: [],
    toolToggles: { claude: { search: true } },
    credentials: {
      pat: { present: false, secretId: null },
      customHeaders: { present: false, secretId: null },
      oauth: { present: false },
    },
  },
};

/**
 * A small in-memory authn: the `mcp_server` rows, a PATCH that applies
 * `onPatch` to them, and an item DELETE that checks the sent revision. With
 * `itemsReadFailsAfterPatch`, the item list answers 500 once the PATCH has landed.
 */
function authnHolding(
  initial: ItemRow,
  onPatch: (row: ItemRow) => void,
  itemsReadFailsAfterPatch: boolean,
): {
  readonly transport: EnvironmentTransport;
  readonly rows: Map<string, ItemRow>;
} {
  const rows = new Map<string, ItemRow>([[initial.key, initial]]);
  let patched = false;
  const answer = (status: number, body: unknown) => ({
    status,
    text: JSON.stringify(body),
  });
  const transport = async (request: EnvironmentTransportRequest) => {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === ITEMS_PATH &&
      url.searchParams.get("kind") === "mcp_server"
    ) {
      if (patched && itemsReadFailsAfterPatch) {
        return answer(500, { code: "internal_error" });
      }
      return answer(200, { items: [...rows.values()] });
    }
    if (request.method === "PATCH" && url.pathname === SERVER_PATH) {
      patched = true;
      for (const row of rows.values()) onPatch(row);
      return answer(200, SERVER_BODY);
    }
    if (
      request.method === "DELETE" &&
      url.pathname === `${ITEMS_PATH}/mcp_server`
    ) {
      const sent = deleteBodySchema.parse(request.body);
      const row = rows.get(sent.key);
      if (row === undefined) {
        return answer(409, { code: "revision_conflict", current: null });
      }
      if (row.revision !== sent.revision) {
        return answer(409, { code: "revision_conflict", current: row });
      }
      rows.delete(sent.key);
      return answer(200, {
        item: null,
        replayed: false,
        revision: row.revision + 1,
      });
    }
    return answer(404, { code: "not_found" });
  };
  return { transport, rows };
}

async function switchOff(transport: EnvironmentTransport) {
  return setConfigurationMcpServerEnabled(
    { ...createEnvironmentCloud("bearer"), transport },
    { environmentId: ENVIRONMENT_ID, serverId: SERVER_ID, enabled: false },
  );
}

describe("setConfigurationMcpServerEnabled switching off", () => {
  it("removes the item when the PATCH marked it at a later revision", async () => {
    const { transport, rows } = authnHolding(
      mcpServerRow(3),
      (row) => {
        row.revision += 1;
      },
      false,
    );

    expect(await switchOff(transport)).toEqual({
      outcome: "saved",
      reason: null,
    });
    expect(rows.size).toBe(0);
  });

  it("refuses and keeps the item when the PATCH also changed its value", async () => {
    const { transport, rows } = authnHolding(
      mcpServerRow(3),
      (row) => {
        row.value.toolToggles = { claude: { search: false } };
        row.revision += 1;
      },
      false,
    );

    expect(await switchOff(transport)).toEqual({
      outcome: "refused",
      reason: "revision_conflict",
    });
    expect(rows.get(ITEM_KEY)?.revision).toBe(4);
  });

  it("removes the item when the PATCH left it alone", async () => {
    const { transport, rows } = authnHolding(
      mcpServerRow(3),
      () => undefined,
      false,
    );

    expect(await switchOff(transport)).toEqual({
      outcome: "saved",
      reason: null,
    });
    expect(rows.size).toBe(0);
  });

  it("removes the item with the held revision when the re-read after the PATCH fails", async () => {
    const { transport, rows } = authnHolding(
      mcpServerRow(3),
      () => undefined,
      true,
    );

    expect(await switchOff(transport)).toEqual({
      outcome: "saved",
      reason: null,
    });
    expect(rows.size).toBe(0);
  });
});
