import { describe, expect, it } from "vitest";
import type { HostQueryTanstackOptions } from "@/hooks/host/use-host-query";

// Compile assertions for the closed builder surface. These assignments are
// only for TypeScript; runtime never reads them. `@ts-expect-error` sits on
// the exact excess-property line so the directive is precise — if the surface
// re-opens, compile fails because the directive becomes unused.

const conditionRefetchInterval: HostQueryTanstackOptions<
  "speech.getModelStatus",
  unknown
> = {
  // @ts-expect-error refetchInterval is rejected for condition methods
  refetchInterval: 1_500,
};

const fixedRefetchInterval: HostQueryTanstackOptions<
  "epic.listCollaborators",
  unknown
> = {
  // @ts-expect-error refetchInterval is rejected for fixed methods
  refetchInterval: 5 * 60 * 1000,
};

const neverPolledRefetchInterval: HostQueryTanstackOptions<
  "host.status",
  unknown
> = {
  // @ts-expect-error refetchInterval is rejected for never-polled methods
  refetchInterval: 1_000,
};

const conditionRetry: HostQueryTanstackOptions<
  "speech.getModelStatus",
  unknown
> = {
  // @ts-expect-error retry is rejected for condition methods
  retry: false,
};

// Non-condition methods still accept deliberate caller retry policy.
const nonconditionRetry: HostQueryTanstackOptions<"host.status", unknown> = {
  retry: (failureCount) => failureCount < 2,
  retryDelay: 0,
};

const fixedRetry: HostQueryTanstackOptions<"host.getRateLimitUsage", unknown> =
  {
    retry: false,
    poll: true,
  };

const conditionPoll: HostQueryTanstackOptions<
  "speech.getModelStatus",
  unknown
> = {
  poll: false,
};

describe("HostQueryTanstackOptions closed surface", () => {
  it("keeps the compile fixtures reachable so the file is not elided", () => {
    expect(conditionRefetchInterval).toBeDefined();
    expect(fixedRefetchInterval).toBeDefined();
    expect(neverPolledRefetchInterval).toBeDefined();
    expect(conditionRetry).toBeDefined();
    expect(nonconditionRetry).toBeDefined();
    expect(fixedRetry).toBeDefined();
    expect(conditionPoll).toBeDefined();
  });
});
