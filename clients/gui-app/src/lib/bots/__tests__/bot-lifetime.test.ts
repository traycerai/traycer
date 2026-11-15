/**
 * The window's bot lifetime: it moves on a change of the account the app
 * reads as, never on a re-projection of the same one, and what the previous
 * account's bot data lives in is retired at the move, before anyone reading
 * the lifetime is told. The module is shared by the whole file, so every case
 * reads a change of the count, never the count.
 */
import { act, renderHook } from "@testing-library/react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  currentBotLifetime,
  registerBotLifetimeClient,
  retireAtBotLifetimeEdge,
  useBotLifetime,
} from "@/lib/bots/bot-lifetime";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

function signInAs(userId: string | null): void {
  act(() => {
    useAuthStore.setState({
      contextMetadata:
        userId === null ? null : { userId, username: "synthetic" },
    });
  });
}

beforeEach(() => {
  signInAs("account-a");
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    useAuthStore.setState({ hostRefusedHeldBearer: false });
  });
});

describe("the bot lifetime", () => {
  it("moves once for each change of account: to another, to signed out, from signed out", () => {
    const start = currentBotLifetime();

    signInAs("account-b");
    expect(currentBotLifetime()).toBe(start + 1);

    signInAs(null);
    expect(currentBotLifetime()).toBe(start + 2);

    signInAs("account-a");
    expect(currentBotLifetime()).toBe(start + 3);
  });

  it("moves nothing for the same user re-projected or another field of the store changing", () => {
    const retired = vi.fn();
    retireAtBotLifetimeEdge(retired);
    const reads: number[] = [];
    renderHook(() => {
      const lifetime = useBotLifetime();
      reads.push(lifetime);
      return lifetime;
    });
    const start = currentBotLifetime();
    const rendered = reads.length;

    signInAs("account-a");
    act(() => {
      useAuthStore.setState({ hostRefusedHeldBearer: true });
    });

    expect(currentBotLifetime()).toBe(start);
    expect(retired).not.toHaveBeenCalled();
    expect(reads).toHaveLength(rendered);
  });

  it("is already the new value inside a retirer, which runs before a reader is told", () => {
    const start = currentBotLifetime();
    const inRetirer: number[] = [];
    const drawnInRetirer: boolean[] = [];
    const reads: number[] = [];
    renderHook(() => {
      const lifetime = useBotLifetime();
      reads.push(lifetime);
      return lifetime;
    });
    retireAtBotLifetimeEdge(() => {
      inRetirer.push(currentBotLifetime());
      const before = reads.length;
      // A reader already told would draw the new value as this flushes.
      flushSync(() => undefined);
      drawnInRetirer.push(reads.length !== before);
    });

    signInAs("account-b");

    expect(inRetirer).toEqual([start + 1]);
    expect(drawnInRetirer).toEqual([false]);
    expect(reads.at(-1)).toBe(start + 1);
  });

  it("hands a retirer the live clients, each once, though one is registered again", () => {
    const first = createAppQueryClient();
    const second = createAppQueryClient();
    registerBotLifetimeClient(first);
    const seen: QueryClient[][] = [];
    retireAtBotLifetimeEdge((clients) => seen.push([...clients]));

    signInAs("account-b");

    expect(seen).toHaveLength(1);
    expect(seen[0].filter((client) => client === first)).toHaveLength(1);
    expect(seen[0].filter((client) => client === second)).toHaveLength(1);
  });

  it("listens to the store once for the window, not once for each client created", () => {
    const subscribe = vi.spyOn(useAuthStore, "subscribe");

    createAppQueryClient();
    createAppQueryClient();
    createAppQueryClient();

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("re-renders a reader with the new lifetime after a move", () => {
    const { result } = renderHook(() => useBotLifetime());
    const start = result.current;

    signInAs("account-b");

    expect(result.current).toBe(start + 1);
    expect(result.current).toBe(currentBotLifetime());
  });
});
