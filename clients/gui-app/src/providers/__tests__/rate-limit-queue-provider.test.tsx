import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ReactNode } from "react";

type MockState = {
  hostId: string | null;
  client: { request: () => Promise<unknown> } | null;
  configured: ReadonlyArray<{
    readonly providerId: string;
    readonly lane: string;
  }>;
};

const mocks = vi.hoisted<MockState>(() => ({
  hostId: "host-a",
  client: { request: () => Promise.resolve({}) },
  configured: [],
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.hostId,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
}));
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => mocks.configured,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  configureRateLimitQueue: vi.fn(),
  enqueueRateLimitFetch: vi.fn(() => Promise.resolve()),
}));

import {
  RateLimitQueueProvider,
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
} from "@/providers/rate-limit-queue-provider";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const configureSpy = vi.mocked(configureRateLimitQueue);
const enqueueSpy = vi.mocked(enqueueRateLimitFetch);

function defineVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function changeVisibility(state: "visible" | "hidden"): void {
  defineVisibility(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

function tree(): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RateLimitQueueProvider />
    </QueryClientProvider>
  );
}

describe("<RateLimitQueueProvider />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = { request: vi.fn(() => Promise.resolve({})) };
    mocks.configured = [];
    configureSpy.mockClear();
    enqueueSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls the ephemeralProcess lane every 5 minutes, matching the httpFetch lane's own refetchInterval", () => {
    expect(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("binds the serial queue to the default host on mount", () => {
    render(tree());
    const config = configureSpy.mock.calls.at(-1)?.[0] ?? null;
    expect(config).not.toBeNull();
    expect(config?.hostId).toBe("host-a");
    expect(typeof config?.request).toBe("function");
  });

  it("unbinds the queue when the host is lost", () => {
    const { rerender } = render(tree());
    configureSpy.mockClear();
    act(() => {
      mocks.hostId = null;
      rerender(tree());
    });
    expect(configureSpy).toHaveBeenLastCalledWith(null);
  });

  it("enqueues only ephemeralProcess providers immediately when they are configured", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    render(tree());

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  });

  it("polls only ephemeralProcess providers each interval after the immediate enqueue", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    render(tree());
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });

    // Only the ephemeralProcess provider is enqueued; the httpFetch one never
    // touches the queue.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  });

  it("pauses the interval while the document is hidden and resumes when visible again (guardrail 2)", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    enqueueSpy.mockClear();

    act(() => {
      changeVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 3);
    });
    // Minimized/backgrounded: no subprocess-spawning enqueues at all.
    expect(enqueueSpy).not.toHaveBeenCalled();

    act(() => {
      changeVisibility("visible");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    // Brought back: polling resumes.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the window loses focus but stays visible - never keys off blur (guardrail 4)", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    enqueueSpy.mockClear();

    // OS focus moves elsewhere (e.g. Traycer visible on a second monitor). The
    // document stays "visible", so nothing must pause.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("re-gates on the next tick when a credential is removed mid-session, without resetting the timer", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    const { rerender } = render(tree());
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    enqueueSpy.mockClear();

    // claude-code's credential is removed mid-session -> it drops out of the
    // configured set. The ref updates on re-render; the interval keeps running.
    act(() => {
      mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
      rerender(tree());
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  });

  it("does not run the interval while there is no host", () => {
    mocks.hostId = null;
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 2);
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
