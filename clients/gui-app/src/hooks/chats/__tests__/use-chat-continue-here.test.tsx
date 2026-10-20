import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { ChatContinueHereResponse } from "@traycer/protocol/host/chat-serving/index";
import type { HostRpcRegistry } from "@/lib/host";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

/**
 * The continue press, end to end through the real mutation: the server's
 * answer decides whether a tab opens, and on which host. The host seams
 * (effective host, directory, client) are the only stubs.
 */

const TARGET_HOST_ID = "host-target";
const SOURCE_HOST_ID = "host-source";
const MOVED_TO_HOST_ID = "host-elsewhere";

const harness = vi.hoisted(() => ({
  client: vi.fn<() => HostClient<HostRpcRegistry> | null>(),
  openTile: vi.fn<(intent: TileOpenIntent) => null>(),
  toast: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: harness.toast }));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => TARGET_HOST_ID,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => harness.client(),
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: harness.openTile }),
}));

// The target is the person's team sandbox; the chat's own host is gone from
// the directory (a destroyed sandbox's host is revoked).
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId === TARGET_HOST_ID
      ? remoteEntry(TARGET_HOST_ID, sandboxFacts("team-1"))
      : null,
}));

import { useChatContinueHere } from "../use-chat-continue-here";

function clientAnswering(
  answer: ChatContinueHereResponse,
): HostClient<HostRpcRegistry> {
  return Object.assign({} as HostClient<HostRpcRegistry>, {
    request: () => Promise.resolve(answer),
  });
}

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function pressContinue(answer: ChatContinueHereResponse): Promise<void> {
  const client = clientAnswering(answer);
  harness.client.mockReturnValue(client);
  const { result } = renderHook(
    () =>
      useChatContinueHere({
        epicId: "epic-1",
        chatId: "chat-1",
        sourceHostId: SOURCE_HOST_ID,
        name: "Agent",
        fallback: harness.fallback,
      }),
    { wrapper },
  );
  expect(result.current.eligible).toBe(true);
  act(() => {
    result.current.continueHere();
  });
  await waitFor(() => {
    expect(result.current.continuing).toBe(false);
  });
}

beforeEach(() => {
  harness.openTile.mockReset();
  harness.toast.mockReset();
  harness.fallback.mockReset();
  harness.client.mockReset();
});

afterEach(cleanup);

describe("useChatContinueHere answers", () => {
  it("toasts and opens no tab when the removed sandbox never published the chat", async () => {
    await pressContinue({
      kind: "refused",
      reason: "never-published",
      ownerHostId: null,
    });

    expect(harness.toast).toHaveBeenCalledWith(
      "This agent has nothing saved to continue from.",
    );
    expect(harness.openTile).not.toHaveBeenCalled();
    expect(harness.fallback).not.toHaveBeenCalled();
  });

  it("opens a tab on the owner host the answer names when another press already moved the chat", async () => {
    await pressContinue({
      kind: "refused",
      reason: "already-moved",
      ownerHostId: MOVED_TO_HOST_ID,
    });

    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.openTile).toHaveBeenCalledTimes(1);
    const [intent] = harness.openTile.mock.calls[0];
    expect(intent.node).toMatchObject({
      id: "chat-1",
      type: "chat",
      hostId: MOVED_TO_HOST_ID,
    });
  });
});
