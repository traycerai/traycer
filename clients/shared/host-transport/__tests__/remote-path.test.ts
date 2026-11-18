import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { createIdentityRelay } from "../remote-path";

/**
 * Non-MVP-gating harness for the future remote/relay path.
 *
 * These tests do not exercise a real relay server. They pin the invariant
 * that the committed versioned RPC envelope survives a hop through an
 * identity relay without shape change - the only contract guarantee the
 * future remote path needs to preserve.
 */

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const testRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

describe("remote-path identity relay", () => {
  it("preserves the committed RPC envelope shape across a relay hop", async () => {
    const seen: { request: unknown; response: unknown }[] = [];

    // Simulated downstream host: round-trip the `host.echo` envelope,
    // mirroring `{ requestId, method, schemaVersion, params | result }`
    // without rewriting the payload.
    const downstream = async (envelope: unknown): Promise<unknown> => {
      const request = envelope as {
        requestId: string;
        method: string;
        schemaVersion: { major: number; minor: number };
        params: { message: string };
      };
      const response = {
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: request.params.message },
      };
      seen.push({ request, response });
      return response;
    };

    const relay = createIdentityRelay({ downstream });

    // Construct the envelope directly from the registry's committed shape.
    // Using the registry (rather than a hard-coded literal) proves the relay
    // forwards whatever the client produces today without interpreting it.
    const methodLine = testRegistry["host.echo"][1];
    const latestVersion =
      methodLine.versions[methodLine.latestMinor].contract.schemaVersion;
    const clientEnvelope = {
      requestId: "req-remote-1",
      method: "host.echo",
      schemaVersion: latestVersion,
      params: { message: "hi" },
    };

    // Serialize + parse to model on-wire bytes: the relay MUST observe the
    // exact object the client serialized, and return it verbatim.
    const relayed = await relay(JSON.parse(JSON.stringify(clientEnvelope)));

    expect(relayed).toEqual({
      requestId: "req-remote-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "hi" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].request).toEqual({
      requestId: "req-remote-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      params: { message: "hi" },
    });
    expect(seen[0].response).toEqual({
      requestId: "req-remote-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "hi" },
    });
  });
});
