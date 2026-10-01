import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  registerExtraImageRootSource,
  resetLandingImageBudgetReservationsForTesting,
  tryReserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  recordCloudDraftImageSources,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import {
  LandingVisibleDraftImagePrefetch,
  VisibleDraftImagePrefetch,
} from "@/components/home/visible-draft-image-prefetch";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  DESKTOP_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

const HOST = "host-visible-prefetch";
const OWNER = "user-1";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_1",
  chatId: "draft-1",
  ownerUserId: OWNER,
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

// Real root registration, exactly as the sibling recovery-module test file
// does: `plannedImages`, `recordCloudDraftImageSources` and the residency
// budget all consult this same registry, so faking it here exercises the
// production wiring rather than a stand-in for it.
const liveLandingImageRoots = new Set<string>();
registerExtraImageRootSource({
  hashes: () => [...liveLandingImageRoots],
});

function rootLandingImages(...hashes: string[]): void {
  for (const hash of hashes) liveLandingImageRoots.add(hash);
}

interface RecordedCall {
  readonly method: string;
}

function recordingClient(
  handle: (method: string, params: unknown) => unknown,
): { readonly client: DraftBlobClient; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const request = ((method: string, params: unknown) => {
    calls.push({ method });
    return handle(method, params);
  }) as FakeRequest;
  return { client: { request, requestWithOptions: request }, calls };
}

/** Answers every `epic.readCloudChatPayload` the same way. */
function okClient(
  bytesBase64: string,
  byteLength: number,
): { readonly client: DraftBlobClient; readonly calls: RecordedCall[] } {
  return recordingClient((_method, _params) =>
    Promise.resolve({
      outcome: { status: "ok" as const, bytesBase64, byteLength },
    }),
  );
}

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

/** A document holding hash-only image nodes: no inline bytes, declared sizes. */
function hashOnlyContent(
  entries: ReadonlyArray<{ readonly hash: string; readonly size: number }>,
): JsonContent {
  return {
    type: "doc",
    content: entries.map((entry): JsonContent => ({
      type: "imageAttachment",
      attrs: {
        id: entry.hash,
        fileName: "pasted.png",
        mimeType: "image/png",
        size: entry.size,
        b64content: null,
        hash: entry.hash,
      },
    })),
  };
}

function makeDraft(input: {
  readonly id: string;
  readonly content: JsonContent;
}): LandingDraftTab {
  return {
    id: input.id,
    content: input.content,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
  };
}

function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

async function flushOneFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Two animation frames, then the idle fallback: jsdom has no
 * `requestIdleCallback`, so the production code's `afterPaint` step falls
 * back to `setTimeout(start, 0)`, exactly as a WebKit build without it would.
 */
async function flushTwoFramesAndIdle(): Promise<void> {
  await flushOneFrame();
  await flushOneFrame();
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  installFreshIndexedDb();
  liveLandingImageRoots.clear();
  resetLandingImageBudgetReservationsForTesting();
  setDocumentVisibility("visible");
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER, username: OWNER },
  });
});

afterEach(() => {
  cleanup();
  resetCloudDraftImageRecoveryForTests();
  resetLandingImageBudgetReservationsForTesting();
  liveLandingImageRoots.clear();
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

describe("VisibleDraftImagePrefetch", () => {
  it("issues no fetch before the two frames plus idle have passed", async () => {
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active
      />,
    );

    // Nothing scheduled a microtask should have run by now, but nothing has
    // been given a real frame or idle turn either.
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    // Only after BOTH frames does the pass actually start.
    await flushOneFrame();
    expect(calls).toHaveLength(0);

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("never schedules a pass while inactive", async () => {
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active={false}
      />,
    );

    await flushTwoFramesAndIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
  });

  it("never schedules a pass while the document is hidden", async () => {
    setDocumentVisibility("hidden");
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
  });

  it("stops planning at the allowance: two images, allowance fits only the first", async () => {
    const firstBytes = uniqueBytes(4);
    const secondBytes = uniqueBytes(6);
    const firstHash = await sha256HexOf(firstBytes);
    const secondHash = await sha256HexOf(secondBytes);
    rootLandingImages(firstHash, secondHash);
    setRetentionProfile({
      ...DESKTOP_RETENTION_PROFILE,
      visibleDraftImagePrefetchBytes: firstBytes.byteLength,
    });

    const first = okClient(toBase64(firstBytes), firstBytes.byteLength);
    const second = okClient(toBase64(secondBytes), secondBytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client: first.client,
      hashes: [firstHash],
    });
    recordCloudDraftImageSources({
      identity: { ...IDENTITY, chatId: "draft-2" },
      hostId: HOST,
      client: second.client,
      hashes: [secondHash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([
          { hash: firstHash, size: firstBytes.byteLength },
          { hash: secondHash, size: secondBytes.byteLength },
        ])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(first.calls).toHaveLength(1));
    // The second image never fit the remaining allowance, so its client is
    // never dispatched at all.
    expect(second.calls).toHaveLength(0);
  });

  it("fetches only a hash that is both a recorded cloud source and a live root", async () => {
    const recordedRootedBytes = uniqueBytes(4);
    const recordedRootedHash = await sha256HexOf(recordedRootedBytes);
    const recordedOnlyBytes = uniqueBytes(4);
    const recordedOnlyHash = await sha256HexOf(recordedOnlyBytes);
    // Rooted (a live draft names it) but never recorded as a cloud source -
    // this plan entry has nothing to fetch it from.
    const rootedOnlyHash = "a".repeat(64);

    rootLandingImages(recordedRootedHash, rootedOnlyHash);

    const recordedRooted = okClient(
      toBase64(recordedRootedBytes),
      recordedRootedBytes.byteLength,
    );
    const recordedOnly = okClient(
      toBase64(recordedOnlyBytes),
      recordedOnlyBytes.byteLength,
    );
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client: recordedRooted.client,
      hashes: [recordedRootedHash],
    });
    // Recorded, but never rooted: not a live draft's image any more.
    recordCloudDraftImageSources({
      identity: { ...IDENTITY, chatId: "draft-2" },
      hostId: HOST,
      client: recordedOnly.client,
      hashes: [recordedOnlyHash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([
          { hash: recordedRootedHash, size: recordedRootedBytes.byteLength },
          { hash: recordedOnlyHash, size: recordedOnlyBytes.byteLength },
          { hash: rootedOnlyHash, size: 4 },
        ])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(recordedRooted.calls).toHaveLength(1));
    expect(recordedOnly.calls).toHaveLength(0);
  });

  it("skips the transfer entirely when the resident budget refuses the estimate", async () => {
    // Fill the resident budget with an unrelated, unreleased reservation so
    // there is no room left for this pass's estimate.
    const filler = tryReserveLandingImageBudget([
      { hash: null, bytes: 64 * 1024 * 1024 - 16 },
    ]);
    expect(filler).not.toBeNull();

    const bytes = uniqueBytes(64);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The preflight admission check runs BEFORE the transfer, so a refused
    // estimate must never even dispatch the request.
    expect(calls).toHaveLength(0);

    filler?.release();
  });

  it("starts one pass on foreground after mounting hidden", async () => {
    setDocumentVisibility("hidden");
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    expect(calls).toHaveLength(0);

    act(() => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("backgrounding before idle then foregrounding starts one fresh pass", async () => {
    const bytes = uniqueBytes(5);
    const hash = await sha256HexOf(bytes);
    rootLandingImages(hash);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client,
      hashes: [hash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([{ hash, size: bytes.byteLength }])}
        active
      />,
    );

    // First frame only - well before the idle-scheduled start().
    await flushOneFrame();

    act(() => {
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The backgrounded run must never have reached the transfer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);

    act(() => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("skips a hash this partition already holds locally, so it never spends the allowance", async () => {
    const localBytes = uniqueBytes(4);
    const localHash = await putImage(localBytes);
    const missingBytes = uniqueBytes(6);
    const missingHash = await sha256HexOf(missingBytes);
    rootLandingImages(localHash, missingHash);

    // The allowance fits only ONE image's worth of bytes. If the local image
    // were not skipped, it would spend the entire allowance and starve the
    // missing one.
    setRetentionProfile({
      ...DESKTOP_RETENTION_PROFILE,
      visibleDraftImagePrefetchBytes: missingBytes.byteLength,
    });

    const local = okClient(toBase64(localBytes), localBytes.byteLength);
    const missing = okClient(toBase64(missingBytes), missingBytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client: local.client,
      hashes: [localHash],
    });
    recordCloudDraftImageSources({
      identity: { ...IDENTITY, chatId: "draft-2" },
      hostId: HOST,
      client: missing.client,
      hashes: [missingHash],
    });

    render(
      <VisibleDraftImagePrefetch
        content={hashOnlyContent([
          { hash: localHash, size: localBytes.byteLength },
          { hash: missingHash, size: missingBytes.byteLength },
        ])}
        active
      />,
    );

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(missing.calls).toHaveLength(1));
    // The already-local image cost nothing and was never re-fetched.
    expect(local.calls).toHaveLength(0);
  });

  it("LandingVisibleDraftImagePrefetch plans only the named draft's images, not a sibling's", async () => {
    // `VisibleDraftImagePrefetch` above takes `content` directly, so its
    // suite cannot see whether the LANDING wrapper picked the right draft's
    // content out of several live ones. This exercises that selector: two
    // drafts sit in the store, both rooted and both recorded as cloud
    // sources, and only the one named by `draftId` may spend anything.
    const namedBytes = uniqueBytes(5);
    const namedHash = await sha256HexOf(namedBytes);
    const siblingBytes = uniqueBytes(7);
    const siblingHash = await sha256HexOf(siblingBytes);
    rootLandingImages(namedHash, siblingHash);

    const named = okClient(toBase64(namedBytes), namedBytes.byteLength);
    const sibling = okClient(toBase64(siblingBytes), siblingBytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: HOST,
      client: named.client,
      hashes: [namedHash],
    });
    recordCloudDraftImageSources({
      identity: { ...IDENTITY, chatId: "draft-sibling" },
      hostId: HOST,
      client: sibling.client,
      hashes: [siblingHash],
    });

    useLandingDraftStore.setState({
      // The sibling sits FIRST: a selector that fell back to "whichever draft
      // is first" rather than matching `draftId` would still pass if the
      // named draft happened to be at index 0, so this ordering is what
      // makes the assertion mean something.
      drafts: [
        makeDraft({
          id: "draft-sibling",
          content: hashOnlyContent([
            { hash: siblingHash, size: siblingBytes.byteLength },
          ]),
        }),
        makeDraft({
          id: "draft-named",
          content: hashOnlyContent([
            { hash: namedHash, size: namedBytes.byteLength },
          ]),
        }),
      ],
      activeDraftId: "draft-named",
    });

    render(<LandingVisibleDraftImagePrefetch draftId="draft-named" active />);

    await flushTwoFramesAndIdle();
    await waitFor(() => expect(named.calls).toHaveLength(1));
    // The sibling draft's image was never in this instance's plan at all.
    expect(sibling.calls).toHaveLength(0);
  });
});
