/**
 * How long the GUI holds a preview-features verdict: the user record lives in
 * the query cache under the app's own defaults, so a verdict authn changes is
 * read on the first window focus after the record goes stale, and not before.
 * The read goes through the real query client, `useAuthUser` and
 * `usePreviewFeature`; only the service that fetches the user is faked, and
 * only the wall clock, so staleness can be crossed.
 */
import {
  focusManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  PREVIEW_FEATURES_OFF,
  type PreviewFeatures,
} from "@traycer/protocol/auth/preview-features";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";

const auth = vi.hoisted(() => ({
  fetchAuthenticatedUser: vi.fn<() => Promise<AuthenticatedUser | null>>(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => auth,
}));

import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

const ALL_ON: PreviewFeatures = {
  environments: true,
  sandboxes: true,
  bots: true,
};
const START = new Date(2026, 9, 27, 12, 0, 0);

function userCarrying(previewFeatures: PreviewFeatures): AuthenticatedUser {
  return {
    ...userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    ),
    previewFeatures,
  };
}

function renderEnvironments() {
  const queryClient = createAppQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => usePreviewFeature("environments"), {
    wrapper,
  });
  return { result, queryClient };
}

/**
 * Blurs and refocuses the window, and returns once the query cache has
 * handled the focus: the client reaches `QueryCache.onFocus` only after it
 * resumes paused mutations, so the count of user reads is a verdict on the
 * focus only after this.
 */
async function refocus(queryClient: QueryClient): Promise<void> {
  const onFocus = vi.spyOn(queryClient.getQueryCache(), "onFocus");
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(onFocus).toHaveBeenCalledTimes(1));
  onFocus.mockRestore();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  auth.fetchAuthenticatedUser.mockReset();
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  useAuthStore.setState({ status: "signed-out" });
  vi.useRealTimers();
});

describe("usePreviewFeature after authn turns a feature off", () => {
  it("keeps the verdict through a focus while the record is fresh, and reads off on the first focus after it goes stale", async () => {
    auth.fetchAuthenticatedUser
      .mockResolvedValueOnce(userCarrying(ALL_ON))
      .mockResolvedValue(userCarrying(PREVIEW_FEATURES_OFF));

    const { result, queryClient } = renderEnvironments();
    await waitFor(() => expect(result.current).toBe("on"));

    vi.setSystemTime(START.getTime() + 59_000);
    await refocus(queryClient);
    expect(auth.fetchAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("on");

    vi.setSystemTime(START.getTime() + 61_000);
    await refocus(queryClient);
    await waitFor(() => expect(result.current).toBe("off"));
    expect(auth.fetchAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});
