import { describe, expect, it } from "vitest";
import {
  classifyNotificationLifecycle,
  compareAttentionOrder,
  type NotificationLifecycleInput,
} from "@/lib/notifications/notification-lifecycle";

function input(
  overrides: Partial<NotificationLifecycleInput> &
    Pick<NotificationLifecycleInput, "source" | "severity">,
): NotificationLifecycleInput {
  return {
    readAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe("classifyNotificationLifecycle", () => {
  it("places unresolved host needs_action rows in attention as blocking", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "host", severity: "needs_action", resolvedAt: null }),
      ),
    ).toEqual({ section: "attention", tier: "blocking" });
  });

  it("moves resolved host prompts to recent", () => {
    expect(
      classifyNotificationLifecycle(
        input({
          source: "host",
          severity: "needs_action",
          resolvedAt: 1_000,
          readAt: null,
        }),
      ),
    ).toEqual({ section: "recent" });
  });

  it("places unread host failures in attention as failure tier", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "host", severity: "failure", readAt: null }),
      ),
    ).toEqual({ section: "attention", tier: "failure" });
  });

  it("moves read host failures to recent immediately", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "host", severity: "failure", readAt: 50 }),
      ),
    ).toEqual({ section: "recent" });
  });

  it("places unread app-local failures in attention as failure tier", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "app-local", severity: "failure", readAt: null }),
      ),
    ).toEqual({ section: "attention", tier: "failure" });
  });

  it("moves read app-local failures to recent", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "app-local", severity: "failure", readAt: 99 }),
      ),
    ).toEqual({ section: "recent" });
  });

  it("never places global rows in attention regardless of severity or read state", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "global", severity: "failure", readAt: null }),
      ),
    ).toEqual({ section: "recent" });
    expect(
      classifyNotificationLifecycle(
        input({ source: "global", severity: "needs_action", resolvedAt: null }),
      ),
    ).toEqual({ section: "recent" });
    expect(
      classifyNotificationLifecycle(
        input({ source: "global", severity: "info", readAt: null }),
      ),
    ).toEqual({ section: "recent" });
  });

  it("keeps host done/info rows in recent even when unread", () => {
    expect(
      classifyNotificationLifecycle(
        input({ source: "host", severity: "done", readAt: null }),
      ),
    ).toEqual({ section: "recent" });
    expect(
      classifyNotificationLifecycle(
        input({ source: "host", severity: "info", readAt: null }),
      ),
    ).toEqual({ section: "recent" });
  });

  it("ignores readAt for unresolved prompts (resolvedAt is the gate)", () => {
    expect(
      classifyNotificationLifecycle(
        input({
          source: "host",
          severity: "needs_action",
          resolvedAt: null,
          readAt: 10,
        }),
      ),
    ).toEqual({ section: "attention", tier: "blocking" });
  });

  it("ignores resolvedAt for failure rows (readAt is the gate)", () => {
    expect(
      classifyNotificationLifecycle(
        input({
          source: "host",
          severity: "failure",
          readAt: null,
          resolvedAt: 10,
        }),
      ),
    ).toEqual({ section: "attention", tier: "failure" });
  });
});

describe("compareAttentionOrder", () => {
  it("orders blocking before failure regardless of timestamps", () => {
    const olderBlocking = {
      tier: "blocking" as const,
      createdAt: 10,
      feedId: "host:old-prompt",
    };
    const newerFailure = {
      tier: "failure" as const,
      createdAt: 1_000,
      feedId: "host:new-failure",
    };
    expect(compareAttentionOrder(olderBlocking, newerFailure)).toBeLessThan(0);
    expect(compareAttentionOrder(newerFailure, olderBlocking)).toBeGreaterThan(
      0,
    );
  });

  it("orders newest createdAt first within the same tier", () => {
    const older = {
      tier: "failure" as const,
      createdAt: 10,
      feedId: "host:a",
    };
    const newer = {
      tier: "failure" as const,
      createdAt: 20,
      feedId: "host:b",
    };
    expect(compareAttentionOrder(newer, older)).toBeLessThan(0);
    expect(compareAttentionOrder(older, newer)).toBeGreaterThan(0);
  });

  it("breaks equal-timestamp ties by ascending feedId", () => {
    const a = {
      tier: "blocking" as const,
      createdAt: 50,
      feedId: "host:aaa",
    };
    const b = {
      tier: "blocking" as const,
      createdAt: 50,
      feedId: "host:zzz",
    };
    expect(compareAttentionOrder(a, b)).toBeLessThan(0);
    expect(compareAttentionOrder(b, a)).toBeGreaterThan(0);
    expect(compareAttentionOrder(a, a)).toBe(0);
  });
});
