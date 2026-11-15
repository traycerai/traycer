import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBotReadReadability } from "@/lib/bots/bot-read-readability";
import { useAuthStore } from "@/stores/auth/auth-store";

describe("installBotReadReadability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds no auth-store listener for the clients it is installed on, so no listener holds a client", () => {
    const subscribe = vi.spyOn(useAuthStore, "subscribe");

    for (let client = 0; client < 3; client += 1) {
      installBotReadReadability(new QueryClient());
    }

    expect(subscribe).not.toHaveBeenCalled();
  });
});
