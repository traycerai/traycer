/**
 * Covers T3's reader acceptance for the chat composer strip: a hash present
 * ONLY in this window's local image store still renders, through
 * `useChatImageFetcher`'s EXISTING local-store leg (`use-chat-image-fetcher.ts`,
 * the `getImageBytes` fallback after the chat-plane and epic-doc legs miss).
 * T3 deliberately did not add a second, draft-specific leg to this fetcher -
 * see the ticket's "known deviations" - so this is a test of behaviour that
 * predates this ticket, written because nothing else exercised it.
 *
 * A separate, minimal harness from `use-chat-image-fetcher.test.tsx`'s (which
 * this file does not import from) so it is not entangled with that suite's
 * chat-plane/epic-doc mocking.
 */
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatAttachmentScopeContext } from "@/components/chat/chat-attachment-scope-context";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => null,
}));

const landingStoreMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return { ...actual, getImageBytes: landingStoreMocks.getImageBytes };
});

const HASH = "a".repeat(64);
const LOCAL_BYTES = new Uint8Array([4, 5, 6]);

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  // No chat-plane scope and no epic handle: only the local-store leg can
  // answer for this hash.
  return (
    <ChatAttachmentScopeContext.Provider value={null}>
      {children}
    </ChatAttachmentScopeContext.Provider>
  );
}

beforeEach(() => {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
      [],
    );
  landingStoreMocks.getImageBytes.mockReset();
  landingStoreMocks.getImageBytes.mockResolvedValue(undefined);
});

afterEach(() => {
  useAuthStore.getState().setSignedOut();
});

describe("useChatImageFetcher local-store leg", () => {
  it("renders a hash present only in the local image store", async () => {
    landingStoreMocks.getImageBytes.mockImplementation((hash) =>
      hash === HASH ? Promise.resolve(LOCAL_BYTES) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useChatImageFetcher(), {
      wrapper: Wrapper,
    });

    const resolved = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    expect(resolved.bytes).toEqual(LOCAL_BYTES);
    expect(landingStoreMocks.getImageBytes).toHaveBeenCalledWith(HASH);
  });

  it("rejects when neither the chat plane, the epic doc, nor the local store has the hash - the host's guard is the only authority left, not this fetcher", async () => {
    const { result } = renderHook(() => useChatImageFetcher(), {
      wrapper: Wrapper,
    });

    await expect(
      result.current.fetch(HASH, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
  });
});
