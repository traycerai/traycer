import type {
  ProviderMcpNotice,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import { describe, expect, it } from "vitest";
import {
  mapNativeMutateToMcpMutate,
  mapProvidersListToMcpServers,
  ProviderNativeRpcError,
} from "@/hooks/providers/native-response-map";

const ROW: ProviderMcpServer = {
  name: "docs",
  enabled: false,
  transport: { type: "http", url: "https://example.com/mcp", auth: null },
  status: "disconnected",
  statusSource: "none",
  statusDetail: null,
  tools: [],
  discoveryPending: false,
  instructions: null,
  configOnly: false,
  stdioDegraded: false,
};

const BLOCKING: ProviderMcpNotice = {
  id: "project-untrusted",
  tone: "warning",
  text: "This project is not trusted.",
  blocking: true,
  remedy: {
    id: "trust-workspace",
    label: "Trust this folder",
    confirmation: "Kimi will run this folder's servers on this machine.",
  },
};

describe("MCP list/mutate mappers keep host notices", () => {
  it("retains list notices, including a blocking notice with no rows", () => {
    expect(
      mapProvidersListToMcpServers({
        response: {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [], notices: [BLOCKING] },
        },
      }),
    ).toEqual({ servers: [], notices: [BLOCKING], refreshError: null });
  });

  it("defaults notices to none for an old host's list", () => {
    expect(
      mapProvidersListToMcpServers({
        response: {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [ROW] },
        },
      }),
    ).toEqual({ servers: [ROW], notices: [], refreshError: null });
  });

  it("yields no notices when the host answered another kind or null", () => {
    expect(
      mapProvidersListToMcpServers({
        response: { providers: [], native: null },
      }),
    ).toEqual({ servers: [], notices: [], refreshError: null });
  });

  it("retains mutation notices and defaults them for an old host", () => {
    expect(
      mapNativeMutateToMcpMutate({
        response: {
          result: {
            ok: true,
            kind: "mcp",
            servers: [ROW],
            notices: [BLOCKING],
          },
        },
      }),
    ).toEqual({ servers: [ROW], notices: [BLOCKING], refreshError: null });
    expect(
      mapNativeMutateToMcpMutate({
        response: { result: { ok: true, kind: "mcp", servers: [ROW] } },
      }),
    ).toEqual({ servers: [ROW], notices: [], refreshError: null });
  });

  it("still throws on a native error result", () => {
    expect(() =>
      mapNativeMutateToMcpMutate({
        response: {
          result: { ok: false, code: "external_drift", detail: "changed" },
        },
      }),
    ).toThrow(ProviderNativeRpcError);
  });
});
