/**
 * Pure-level coverage of T5's send gate,
 * `submitHostHeldImageHashes` - the union of T3's inherited host-held set
 * with the memo-confirmed digests, gated on the bridge flag and a non-null
 * target host, minus anything marked unbridgeable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { submitHostHeldImageHashes } from "@/lib/composer/submit-host-held-image-hashes";
import {
  __resetHostHeldImageHashesForTests,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import {
  markDraftBlobUnbridgeable,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { JsonContent } from "@traycer/protocol/common/registry";

const HOST = "host-gate";
const OWNER = "owner-gate";
const SURFACE = "surface-gate";

const request = ((_method, _params) =>
  Promise.resolve({
    ok: true as const,
  })) as HostRequester<HostRpcRegistry>["request"];
const OK_CLIENT: DraftBlobClient = { request, requestWithOptions: request };

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

function imageAttachmentNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
    },
  };
}

function docWithHashOnlyImage(hash: string): JsonContent {
  return { type: "doc", content: [imageAttachmentNode(hash)] };
}

function docWithHashOnlyImages(hashes: ReadonlyArray<string>): JsonContent {
  return { type: "doc", content: hashes.map(imageAttachmentNode) };
}

async function confirmedHash(): Promise<string> {
  const hash = await putImage(pngBytes());
  const confirmed = await putDraftBlobs(HOST, OK_CLIENT, [hash], OWNER);
  expect(confirmed).toEqual([hash]);
  return hash;
}

beforeEach(() => {
  installFreshIndexedDb();
  __resetHostHeldImageHashesForTests();
});

afterEach(() => {
  resetDraftBlobTransportForTests();
});

describe("submitHostHeldImageHashes", () => {
  it("flag true + confirmed -> the hash is in the set", async () => {
    const hash = await confirmedHash();
    const held = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation: null,
      content: docWithHashOnlyImage(hash),
      hostId: HOST,
      bridgeSupported: true,
      ownerUserId: OWNER,
    });
    expect(held.has(hash)).toBe(true);
  });

  it("flag false -> not held, even though confirmed", async () => {
    const hash = await confirmedHash();
    const held = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation: null,
      content: docWithHashOnlyImage(hash),
      hostId: HOST,
      bridgeSupported: false,
      ownerUserId: OWNER,
    });
    expect(held.has(hash)).toBe(false);
  });

  it("flag true + unconfirmed -> not held", () => {
    const hash = "unconfirmed".padEnd(64, "0");
    const held = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation: null,
      content: docWithHashOnlyImage(hash),
      hostId: HOST,
      bridgeSupported: true,
      ownerUserId: OWNER,
    });
    expect(held.has(hash)).toBe(false);
  });

  it("hostId: null -> not held, even though confirmed", async () => {
    const hash = await confirmedHash();
    const held = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation: null,
      content: docWithHashOnlyImage(hash),
      hostId: null,
      bridgeSupported: true,
      ownerUserId: OWNER,
    });
    expect(held.has(hash)).toBe(false);
  });

  it("confirmed but marked unbridgeable -> not held", async () => {
    const hash = await confirmedHash();
    markDraftBlobUnbridgeable(HOST, hash);
    const held = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation: null,
      content: docWithHashOnlyImage(hash),
      hostId: HOST,
      bridgeSupported: true,
      ownerUserId: OWNER,
    });
    expect(held.has(hash)).toBe(false);
  });

  it("inherited hashes pass through in every case, including when the gate is fully off", async () => {
    const inheritedHash = "inherited".padEnd(64, "1");
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, incarnation, [inheritedHash]);

    // Gate fully off: no bridge, no host.
    const offHeld = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation,
      content: docWithHashOnlyImage(inheritedHash),
      hostId: null,
      bridgeSupported: false,
      ownerUserId: null,
    });
    expect(offHeld.has(inheritedHash)).toBe(true);

    // Gate fully on, alongside a confirmed digest.
    const confirmed = await confirmedHash();
    const onHeld = submitHostHeldImageHashes({
      surfaceKey: SURFACE,
      incarnation,
      content: docWithHashOnlyImages([inheritedHash, confirmed]),
      hostId: HOST,
      bridgeSupported: true,
      ownerUserId: OWNER,
    });
    expect(onHeld.has(inheritedHash)).toBe(true);
    expect(onHeld.has(confirmed)).toBe(true);
  });
});
