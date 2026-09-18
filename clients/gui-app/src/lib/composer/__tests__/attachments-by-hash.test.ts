import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
// Only the RESET: the create gate reads the unary manifest, never a stream's
// negotiated minor - the send half that did is gone with `chat.subscribe@1.12`.
// The reset stays so a stream version recorded by a neighbouring suite cannot
// leak into these cases.
import { resetNegotiatedStreamVersions } from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import type { HostRpcRegistry } from "@/lib/host";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import {
  confirmAttachmentsByHash,
  createAttachmentsByHashSupported,
  exceedsCreateAttachmentHashCap,
  MAX_CREATE_ATTACHMENT_HASHES,
  planAttachmentsByHash,
  type AttachmentsByHashPlan,
} from "@/lib/composer/attachments-by-hash";

/**
 * The account every confirmation in this file is recorded under. Passed
 * explicitly rather than seeded into the auth store: `confirmAttachmentsByHash`
 * takes the owner as an input precisely so this suite needs no store, and a
 * store-seeded owner would have to be written to `contextMetadata.userId` - not
 * `profile.userId` - to be read at all, which is a trap the explicit argument
 * removes.
 */
const OWNER = "owner-user-1";

function doc(children: readonly JsonContent[]): JsonContent {
  return { type: "doc", content: [...children] };
}

function imageNode(attrs: Record<string, unknown>): JsonContent {
  return { type: "imageAttachment", attrs };
}

function pngBytesA(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
}

function pngBytesB(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2]);
}

function neverCalledDraftBlobClient(): DraftBlobClient {
  return {
    request: () => Promise.reject(new Error("unexpected request call")),
    requestWithOptions: () =>
      Promise.reject(new Error("unexpected requestWithOptions call")),
  };
}

function putBlobAckingOnly(acked: ReadonlySet<string>): DraftBlobClient {
  return {
    request: neverCalledDraftBlobClient().request,
    requestWithOptions: ((method: string, params: unknown) => {
      if (method !== "drafts.putBlob") {
        return Promise.reject(new Error(`unexpected method ${method}`));
      }
      const sha256 = (params as { readonly sha256: string }).sha256;
      return Promise.resolve(
        acked.has(sha256)
          ? { ok: true as const }
          : { ok: false as const, reason: "digest-mismatch" as const },
      );
    }) as HostRequester<HostRpcRegistry>["requestWithOptions"],
  };
}

function hostUnsupportedDraftBlobClient(): DraftBlobClient {
  return {
    request: neverCalledDraftBlobClient().request,
    requestWithOptions: () =>
      Promise.reject(
        new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: "old host",
          requestId: "r1",
          method: "drafts.putBlob",
          fatalDetails: null,
        }),
      ),
  };
}

beforeEach(() => {
  installFreshIndexedDb();
});

afterEach(() => {
  resetDraftBlobTransportForTests();
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
});

describe("planAttachmentsByHash", () => {
  it("splits eligible vs ineligible hash-only nodes on byHashEligible, including the HTML-clipboard string form", () => {
    const content = doc([
      imageNode({ hash: "h1", byHashEligible: true }),
      imageNode({ hash: "h2" }), // attr absent
      imageNode({ hash: "h3", byHashEligible: false }),
      imageNode({ hash: "h4", byHashEligible: "not-a-bool" }),
      imageNode({ hash: "h5", byHashEligible: "true" }), // HTML clipboard round-trip
    ]);

    const plan = planAttachmentsByHash(content);

    expect([...plan.eligible].sort()).toEqual(["h1", "h5"]);
    expect([...plan.ineligible].sort()).toEqual(["h2", "h3", "h4"]);
    expect(plan.hasInlineHashedNode).toBe(false);
  });

  it("a non-raster / unmodelable node (no byHashEligible) never travels by hash", () => {
    const content = doc([
      imageNode({ hash: "svg1", mimeType: "image/svg+xml" }),
    ]);

    const plan = planAttachmentsByHash(content);

    expect(plan.eligible).toEqual([]);
    expect(plan.ineligible).toEqual(["svg1"]);
  });

  it("a node carrying both b64content and a hash sets hasInlineHashedNode and appears in neither list", () => {
    const content = doc([
      imageNode({ hash: "crop1", b64content: "AAAA", byHashEligible: true }),
    ]);

    const plan = planAttachmentsByHash(content);

    expect(plan.hasInlineHashedNode).toBe(true);
    expect(plan.eligible).toEqual([]);
    expect(plan.ineligible).toEqual([]);
  });

  it("the same hash on an eligible AND an ineligible node lands in ineligible only (fail closed)", () => {
    const content = doc([
      imageNode({ hash: "dup", byHashEligible: true }),
      imageNode({ hash: "dup", byHashEligible: false }),
    ]);

    const plan = planAttachmentsByHash(content);

    expect(plan.eligible).toEqual([]);
    expect(plan.ineligible).toEqual(["dup"]);
  });
});

describe("confirmAttachmentsByHash", () => {
  it("diffs requested against confirmed: a strict-subset ack leaves the rest to inline", async () => {
    const hostId = "host-confirm-subset";
    const hashA = await putImage(pngBytesA());
    const hashB = await putImage(pngBytesB());
    const client = putBlobAckingOnly(new Set([hashA]));
    const plan: AttachmentsByHashPlan = {
      eligible: [hashA, hashB],
      ineligible: [],
      hasInlineHashedNode: false,
    };

    const confirmed = await confirmAttachmentsByHash({
      hostId,
      client,
      plan,
      ownerUserId: OWNER,
    });

    expect(confirmed.byHash).toEqual(new Set([hashA]));
    expect(confirmed.inline).toEqual([hashB]);
  });

  it("a null owner confirms nothing, so every eligible hash falls to inline even after the host acks", async () => {
    // The positive control is the case above: the SAME client, acking the same
    // digest, puts that hash in `byHash`. The only difference here is the
    // owner, which is what makes this a statement about owner-keying rather
    // than about the ack. Without the control it would pass equally well if
    // `confirmAttachmentsByHash` had simply stopped confirming anything.
    const hostId = "host-confirm-null-owner";
    const hashA = await putImage(pngBytesA());
    const client = putBlobAckingOnly(new Set([hashA]));
    const plan: AttachmentsByHashPlan = {
      eligible: [hashA],
      ineligible: [],
      hasInlineHashedNode: false,
    };

    const confirmed = await confirmAttachmentsByHash({
      hostId,
      client,
      plan,
      ownerUserId: null,
    });

    expect(confirmed.byHash).toEqual(new Set<string>());
    expect(confirmed.inline).toEqual([hashA]);

    const withOwner = await confirmAttachmentsByHash({
      hostId,
      client,
      plan,
      ownerUserId: OWNER,
    });

    expect(withOwner.byHash).toEqual(new Set([hashA]));
    expect(withOwner.inline).toEqual([]);
  });

  it("an already-confirmed hash costs no drafts.putBlob at submit", async () => {
    const hostId = "host-confirm-cached";
    const hash = await putImage(pngBytesA());
    let putBlobCalls = 0;
    const countingClient: DraftBlobClient = {
      request: neverCalledDraftBlobClient().request,
      requestWithOptions: ((method: string, params: unknown) => {
        putBlobCalls += 1;
        return putBlobAckingOnly(new Set([hash])).requestWithOptions(
          method as "drafts.putBlob",
          params as never,
          {
            idempotencyKey: hash,
            responseTimeoutMs: null,
            requiredHostMethodVersion: null,
            signal: undefined,
          },
        );
      }) as HostRequester<HostRpcRegistry>["requestWithOptions"],
    };
    // Paste-time upload already confirmed the hash, for THIS owner.
    await putDraftBlobs(hostId, countingClient, [hash], OWNER);
    expect(putBlobCalls).toBe(1);

    const plan: AttachmentsByHashPlan = {
      eligible: [hash],
      ineligible: [],
      hasInlineHashedNode: false,
    };
    const confirmed = await confirmAttachmentsByHash({
      hostId,
      client: countingClient,
      plan,
      ownerUserId: OWNER,
    });

    expect(confirmed.byHash).toEqual(new Set([hash]));
    expect(putBlobCalls).toBe(1);
  });
});

describe("exceedsCreateAttachmentHashCap", () => {
  const atCap: ReadonlyArray<string> = Array.from(
    { length: MAX_CREATE_ATTACHMENT_HASHES },
    (_, index) => `h${String(index)}`,
  );

  it("is false at exactly the cap and true one over it", () => {
    expect(exceedsCreateAttachmentHashCap(atCap)).toBe(false);
    expect(exceedsCreateAttachmentHashCap([...atCap, "one-more"])).toBe(true);
  });

  it("counts a MIXED set - the eligible half alone clears a cap the wire does not", () => {
    // The shape the modal ships on its best-effort arm: one image this window
    // uploaded, plus hashes it could not produce bytes for and left hash-only.
    // The host counts every node still holding a hash, so the number that
    // decides is the union - which is why this function takes hashes and not a
    // plan whose two halves it would have to guess how to combine.
    const plan: AttachmentsByHashPlan = {
      eligible: ["uploaded-one"],
      ineligible: atCap,
      hasInlineHashedNode: false,
    };

    expect(exceedsCreateAttachmentHashCap(plan.eligible)).toBe(false);
    expect(
      exceedsCreateAttachmentHashCap([...plan.eligible, ...plan.ineligible]),
    ).toBe(true);
  });
});

describe("createAttachmentsByHashSupported", () => {
  const HOST = "host-create-gate";

  it("fails closed with no handshake at all", () => {
    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(false);
  });

  it("fails closed when the method is absent from the negotiated manifest", () => {
    recordNegotiatedHostManifest(HOST, {
      "drafts.putBlob": { major: 1, minor: 0 },
    });

    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(false);
  });

  it("fails closed when the host withholds drafts.putBlob", async () => {
    recordNegotiatedHostManifest(HOST, {
      "epic.create": { major: 1, minor: 2 },
    });
    const hash = await putImage(pngBytesA());
    await putDraftBlobs(HOST, hostUnsupportedDraftBlobClient(), [hash], OWNER);

    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(false);
  });

  it("fails closed at exactly one minor below the gate", () => {
    recordNegotiatedHostManifest(HOST, {
      "epic.create": { major: 1, minor: 1 },
    });

    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(false);
  });

  it("fails closed on a different major, even a higher one", () => {
    recordNegotiatedHostManifest(HOST, {
      "epic.create": { major: 2, minor: 5 },
    });

    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(false);
  });

  it("is true only at major 1, minor >= the gate", () => {
    recordNegotiatedHostManifest(HOST, {
      "epic.create": { major: 1, minor: 2 },
    });

    expect(createAttachmentsByHashSupported(HOST, "epic.create")).toBe(true);
  });
});
