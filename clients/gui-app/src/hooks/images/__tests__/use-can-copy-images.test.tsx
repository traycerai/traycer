/**
 * The image-clipboard capability read. Its DEFAULT is the load-bearing part:
 * the shell that cannot copy is the one that has to say so, because its
 * failure mode is a write that resolves having done nothing.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useCanCopyImages } from "@/hooks/images/use-can-copy-images";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

function withHost(host: IRunnerHost | null) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    if (host === null) return props.children;
    return (
      <RunnerHostProvider runnerHost={host}>
        {props.children}
      </RunnerHostProvider>
    );
  };
}

describe("useCanCopyImages", () => {
  it("reports the capability a mounted shell declares", () => {
    const { result } = renderHook(() => useCanCopyImages(), {
      wrapper: withHost(createFakeRunnerHost({ canCopyImages: false })),
    });

    expect(result.current).toBe(false);
  });

  it("passes a declaring shell's `true` straight through", () => {
    const { result } = renderHook(() => useCanCopyImages(), {
      wrapper: withHost(createFakeRunnerHost({})),
    });

    expect(result.current).toBe(true);
  });

  it("assumes the capability with no shell mounted", () => {
    // A host-less tree is a browser tab or a test harness, both of which
    // honour the write. Reading absence of a host as absence of the capability
    // would silently strip Copy from every leaf surface that mounts without
    // one.
    const { result } = renderHook(() => useCanCopyImages(), {
      wrapper: withHost(null),
    });

    expect(result.current).toBe(true);
  });
});
