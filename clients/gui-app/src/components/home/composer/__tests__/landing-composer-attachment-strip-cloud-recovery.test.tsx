/**
 * F1 - the landing attachment strip must render a cloud-recovered image on
 * its OWN first fetch, not on some later remount.
 *
 * Before the fix, `LandingComposerAttachmentStrip` resolved hash-only chips
 * through `useLandingImageFetcher()` alone - this window's IndexedDB
 * partition, nothing else. `useImageBlobUrlState`'s blob cache retries a
 * failed fetch four times over ~1.75s before resting on `unavailable` until
 * remount, so bytes a cloud recovery landed at, say, three seconds had
 * nothing to make an already-mounted chip look again.
 *
 * The fix composes `useDraftFirstImageFetcher(useLandingImageFetcher(),
 * hostId)`, so the chip's own fetch performs the cloud read (leg 3 of
 * `resolveDraftImageBytes`) instead of racing that retry ladder.
 *
 * This mounts the REAL `LandingComposerAttachmentStrip`, which is exported for
 * exactly that reason: a test that rebuilt the composition itself would keep
 * passing after someone restored the local-only fetcher, so it would guard
 * nothing. Everything under it is real too - `AttachmentStrip`,
 * `ImageAttachmentChip`, `useImageBlobUrlState`, the blob cache, an empty
 * IndexedDB partition and the real recovery module. Only the host RPC is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

import { LandingComposerAttachmentStrip } from "@/components/home/composer/landing-composer";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordCloudDraftImageSources,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";

const OWNER = "user-1";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_1",
  chatId: "draft-1",
  ownerUserId: OWNER,
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

function okClient(bytesBase64: string, byteLength: number): DraftBlobClient {
  const request = ((_method: string, _params: unknown) =>
    Promise.resolve({
      outcome: { status: "ok" as const, bytesBase64, byteLength },
    })) as FakeRequest;
  return { request };
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

// Never reused across suites - the landing-image-store session cache
// survives `installFreshIndexedDb()`.
let uniqueByteSeed = 300_000;

function uniqueBytes(length: number): Uint8Array<ArrayBuffer> {
  uniqueByteSeed += 1;
  const seed = uniqueByteSeed;
  return new Uint8Array(
    Array.from({ length }, (_unused, index) => (seed * 19 + index * 11) % 256),
  );
}

function imageDoc(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `node-${hash.slice(0, 8)}`,
              fileName: "restored.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size: 4,
            },
          },
        ],
      },
    ],
  };
}

let originalCreateObjectURLDescriptor: PropertyDescriptor | undefined;
let urlCounter = 0;

beforeEach(() => {
  installFreshIndexedDb();
  useAuthStore.setState({
    status: "signed-in",
    // A cloud source carries the identity it was minted under and is not
    // spendable under another, so the signed-in fixture has to name the same
    // owner the recorded source does.
    contextMetadata: { userId: OWNER, username: OWNER },
  });
  originalCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => `blob:mock/${++urlCounter}`,
  });
});

afterEach(() => {
  cleanup();
  resetCloudDraftImageRecoveryForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  if (originalCreateObjectURLDescriptor !== undefined) {
    Object.defineProperty(
      URL,
      "createObjectURL",
      originalCreateObjectURLDescriptor,
    );
  }
});

describe("LandingComposerAttachmentStrip wiring - cloud draft image recovery", () => {
  it("renders a hash-only chip from the cloud on its own first fetch, with the partition empty", async () => {
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client: okClient(toBase64(bytes), bytes.byteLength),
      hashes: [hash],
    });

    render(
      <LandingComposerAttachmentStrip
        content={imageDoc(hash)}
        onRemoveImage={() => undefined}
        hostId="host-a"
      />,
    );

    const img = await screen.findByRole("img", { name: "restored.png" });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
  });

  it("positive control: an unrecorded hash with no local bytes never renders an image", async () => {
    const bytes = uniqueBytes(5);
    const unrecordedHash = await sha256HexOf(bytes); // never recorded or stored

    render(
      <LandingComposerAttachmentStrip
        content={imageDoc(unrecordedHash)}
        onRemoveImage={() => undefined}
        hostId="host-a"
      />,
    );

    // Give the fetch pipeline a chance to run and fail at least once - the
    // draft leg misses instantly (no recorded source), and the landing
    // fallback throws with nothing in the empty partition, so one macrotask
    // is well past its first attempt.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(screen.queryByRole("img")).toBeNull();
  });
});
