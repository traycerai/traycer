import "../../../../__tests__/test-browser-apis";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalSessionRecovery } from "@/hooks/terminal/use-terminal-session-recovery";

function withQueryClient(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useTerminalSessionRecovery", () => {
  it("emits once when the three automatic recovery attempts are exhausted", () => {
    const onRecoveryExhausted = vi.fn();
    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient },
    );

    act(() => {
      result.current.onSessionLost();
      result.current.onSessionLost();
      result.current.onSessionLost();
    });
    expect(onRecoveryExhausted).not.toHaveBeenCalled();

    act(() => {
      result.current.onSessionLost();
      result.current.onSessionLost();
    });

    expect(result.current.recoveryExhausted).toBe(true);
    expect(onRecoveryExhausted).toHaveBeenCalledTimes(1);
  });

  it("does not emit when a lost stream heals within the automatic budget", () => {
    const onRecoveryExhausted = vi.fn();
    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient },
    );

    act(() => {
      result.current.onSessionLost();
      result.current.onSessionHealthy();
    });

    expect(result.current.recoveryExhausted).toBe(false);
    expect(onRecoveryExhausted).not.toHaveBeenCalled();
  });
});
