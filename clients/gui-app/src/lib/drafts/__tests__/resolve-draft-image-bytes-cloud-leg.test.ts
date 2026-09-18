import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

import { getImageBytes, putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordCloudDraftImageSources,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";

const HOST = "host-cloud-leg";
/**
 * The account every fixture identity below belongs to. The signed-in fixture
 * and the recorded sources have to name the SAME owner: a cloud source carries
 * the identity it was minted under and is not spendable under another.
 */
const OWNER = "user-1";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_1",
  chatId: "draft-1",
  ownerUserId: OWNER,
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

// See the sibling recovery-module test file for why every image's content
// must be unique across the whole file: `landing-image-store`'s session
// cache survives `installFreshIndexedDb()`.
let uniqueByteSeed = 0;

function uniqueBytes(length: number): Uint8Array<ArrayBuffer> {
  uniqueByteSeed += 1;
  const seed = uniqueByteSeed;
  return new Uint8Array(
    Array.from({ length }, (_unused, index) => (seed * 31 + index * 7) % 256),
  );
}

async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes));
}

interface RecordedCall {
  readonly method: string;
}

function targetWithClient(handle: FakeRequest): {
  readonly target: DraftImageByteTarget;
  readonly client: { readonly request: FakeRequest };
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const request: FakeRequest = (method, params) => {
    calls.push({ method });
    return handle(method, params);
  };
  const client = { request };
  return { target: { hostId: HOST, client }, client, calls };
}

beforeEach(() => {
  installFreshIndexedDb();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER, username: OWNER },
  });
});

afterEach(() => {
  resetDraftBlobTransportForTests();
  resetCloudDraftImageRecoveryForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("resolveDraftImageBytes - leg order with a recorded cloud source", () => {
  it("returns a local hit and never reaches the host or the cloud", async () => {
    const bytes = uniqueBytes(6);
    const hash = await putImage(bytes);
    // Recorded as if a cloud ingest had described this same hash - the local
    // leg must still win.
    const { target, client, calls } = targetWithClient(((_method, _params) =>
      Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      })) as FakeRequest);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    const resolved = await resolveDraftImageBytes(hash, target);

    expect(resolved).toEqual(bytes);
    expect(calls).toHaveLength(0);
  });

  it("returns a target-host hit via drafts.readBlob and never reaches the cloud", async () => {
    const bytes = uniqueBytes(4);
    const hash = await sha256HexOf(bytes);
    const { target, client, calls } = targetWithClient(((method, _params) => {
      if (method === "drafts.readBlob") {
        return Promise.resolve({
          ok: true as const,
          bytesBase64: toBase64(bytes),
        });
      }
      throw new Error(`unexpected ${String(method)}`);
    }) as FakeRequest);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    const resolved = await resolveDraftImageBytes(hash, target);

    expect(resolved).toEqual(bytes);
    expect(calls.map((call) => call.method)).toEqual(["drafts.readBlob"]);
    expect(
      calls.some((call) => call.method === "epic.readCloudChatPayload"),
    ).toBe(false);
  });

  it("falls through to the cloud leg only when both local and host legs miss", async () => {
    const bytes = uniqueBytes(3);
    const hash = await sha256HexOf(bytes);
    const { target, client, calls } = targetWithClient(((method, _params) => {
      if (method === "drafts.readBlob") {
        return Promise.resolve({
          ok: false as const,
          reason: "missing" as const,
        });
      }
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(bytes),
            byteLength: bytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)}`);
    }) as FakeRequest);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    const resolved = await resolveDraftImageBytes(hash, target);

    expect(resolved).toEqual(bytes);
    expect(calls.map((call) => call.method)).toEqual([
      "drafts.readBlob",
      "epic.readCloudChatPayload",
    ]);
    expect(await getImageBytes(hash)).toEqual(bytes);
  });

  it("never throws through the resolver when the cloud leg's transport rejects", async () => {
    const bytes = uniqueBytes(3);
    const hash = await sha256HexOf(bytes);
    const { target, client } = targetWithClient(((method, _params) => {
      if (method === "drafts.readBlob") {
        return Promise.resolve({
          ok: false as const,
          reason: "missing" as const,
        });
      }
      return Promise.reject(new Error("cloud transport died"));
    }) as FakeRequest);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    await expect(resolveDraftImageBytes(hash, target)).resolves.toBeNull();
  });
});
