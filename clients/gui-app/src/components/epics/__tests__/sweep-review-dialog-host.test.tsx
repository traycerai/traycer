import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSweepSessionStore } from "@/stores/epics/sweep-session-store";

const captured = vi.hoisted(() => ({
  flows: [] as Array<{
    readonly epicIds: readonly string[] | null;
    readonly surfaceHostId: string | null;
    readonly surfaceHostClient: { readonly hostId: string } | null;
    readonly taskTitle: string | null;
    readonly onOpenChange: (open: boolean) => void;
  }>,
  clients: [] as string[],
}));

vi.mock("@/components/epics/sweep-worktrees-flow", () => ({
  SweepWorktreesFlow: (props: (typeof captured.flows)[number]) => {
    captured.flows.push(props);
    return null;
  },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    captured.clients.push(hostId);
    return { hostId };
  },
}));

import { SweepReviewDialogHost } from "@/components/epics/sweep-review-dialog-host";

describe("SweepReviewDialogHost", () => {
  beforeEach(() => {
    captured.flows.length = 0;
    captured.clients.length = 0;
    useSweepSessionStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useSweepSessionStore.getState().reset();
  });

  it("forwards the parked Task set and original host to the review flow, then closes", () => {
    const epicIds = ["epic-original", "epic-shared"] as const;
    useSweepSessionStore.getState().openReview({
      sessionKey: "host:host-original\nepic-original,epic-shared",
      hostId: "host-original",
      epicIds,
      taskTitle: "Original task",
    });

    render(<SweepReviewDialogHost />);

    expect(captured.clients).toEqual(["host-original"]);
    expect(captured.flows).toHaveLength(1);
    expect(captured.flows[0]).toMatchObject({
      epicIds,
      surfaceHostId: "host-original",
      surfaceHostClient: { hostId: "host-original" },
      taskTitle: "Original task",
    });

    captured.flows[0]?.onOpenChange(false);
    expect(useSweepSessionStore.getState().reviewTarget).toBeNull();
  });
});
