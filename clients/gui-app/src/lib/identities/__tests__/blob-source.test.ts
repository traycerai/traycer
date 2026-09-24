/**
 * `resolveIdentityBlobSource` against a REAL `HostClient` over an in-memory
 * `MockHostMessenger` (the repo's own pattern for host-request tests) rather
 * than a hand-typed stub - a plain object cannot satisfy `HostClient`'s full
 * surface without an `as` cast, which this repo's lint forbids in tests as
 * much as in production.
 */
import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  AgentIdentityFilesReadBlobRequest,
  AgentIdentityFilesReadBlobResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { resolveIdentityBlobSource } from "@/lib/identities/blob-source";

function buildClient(
  handler: (
    request: AgentIdentityFilesReadBlobRequest,
  ) => AgentIdentityFilesReadBlobResponse,
): { readonly client: HostClient<HostRpcRegistry> } {
  let requestCount = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String((requestCount += 1))}`,
      handlers: { "agentIdentity.files.readBlob": handler },
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return { client: client.createRequester(mockLocalHostEntry) };
}

const INPUT = {
  identityId: "identity_1",
  path: "logo.png",
  sha256: "a".repeat(64),
  mediaType: "application/octet-stream",
};

describe("resolveIdentityBlobSource", () => {
  it("returns unavailable when the client is null", async () => {
    const result = await resolveIdentityBlobSource(null, INPUT);
    expect(result.kind).toBe("unavailable");
  });

  it("concatenates two chunks in order, and the LAST chunk's mediaType wins", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const { client } = buildClient((request) => {
      if (request.offset === 0) {
        return {
          kind: "ok",
          bytesBase64: bytesToBase64(first),
          byteLength: first.byteLength + second.byteLength,
          mediaType: "application/octet-stream",
          final: false,
        };
      }
      return {
        kind: "ok",
        bytesBase64: bytesToBase64(second),
        byteLength: first.byteLength + second.byteLength,
        mediaType: "image/png",
        final: true,
      };
    });

    const result = await resolveIdentityBlobSource(client, INPUT);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") throw new Error("expected bytes");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(result.mediaType).toBe("image/png");
  });

  it("maps a pending response to kind: pending", async () => {
    const { client } = buildClient(() => ({ kind: "pending" }));
    const result = await resolveIdentityBlobSource(client, INPUT);
    expect(result.kind).toBe("pending");
  });

  it("maps a refused response to kind: unavailable", async () => {
    const { client } = buildClient(() => ({
      kind: "refused",
      reason: "pathNotFound",
      detail: "no such path",
    }));
    const result = await resolveIdentityBlobSource(client, INPUT);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("expected unavailable");
    expect(result.reason).toBe("This file is no longer at that path.");
  });

  it("yields zero-length bytes for an ok response with no bytes and final: true", async () => {
    const { client } = buildClient(() => ({
      kind: "ok",
      bytesBase64: bytesToBase64(new Uint8Array([])),
      byteLength: 0,
      mediaType: "application/octet-stream",
      final: true,
    }));
    const result = await resolveIdentityBlobSource(client, INPUT);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") throw new Error("expected bytes");
    expect(result.bytes.byteLength).toBe(0);
  });
});
