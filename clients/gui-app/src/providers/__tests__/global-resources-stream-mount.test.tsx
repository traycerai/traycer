import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { ResourcesStreamCallbacks } from "@traycer-clients/shared/host-transport/resources-stream-client";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

// A remote host, as the transport actually reports one: `"unknown"` support and
// no client-wide schema version for any method. This is what makes the
// pre-check unable to convict, which is the state this mount has to survive.
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/stream-runtime-context")>();
  return {
    ...actual,
    useWsStreamClient: () => null,
    useStreamHostId: () => "host-a",
    useStreamMethodSupport: () => "unknown",
    useStreamMethodSchemaVersion: () => null,
  };
});

describe("GlobalResourcesStreamMount", () => {
  afterEach(() => {
    __setResourcesStreamClientFactoryForTests(null);
    resourcesRegistry.disposeAll();
  });

  /**
   * The mount gates on the PRE-STREAM verdict, never the full one the panel
   * reads — and this is what that buys.
   *
   * Gating on the full verdict is a loop with no exit: acquire → the stream
   * negotiates `@1.0` and reports `unsupported` → the effect re-runs and
   * releases → the store holding the verdict is disposed with it → the verdict
   * reverts to `unknown` → acquire again. It would re-dial a host forever, on
   * the strength of having successfully learned something about it.
   *
   * Asserted as "built once and still held", because a single rebuild is the
   * first lap of that loop, not a lesser symptom of it.
   */
  it("keeps the stream it opened after that stream convicts its own host", () => {
    let captured: ResourcesStreamCallbacks | null = null;
    let builds = 0;
    const emit = (): ResourcesStreamCallbacks => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    };
    __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
      builds += 1;
      captured = callbacks;
      return { close: () => undefined };
    });

    render(<GlobalResourcesStreamMount />);
    expect(builds).toBe(1);

    act(() => {
      emit().onScopeSupport("unsupported");
    });

    expect(builds).toBe(1);
    expect(resourcesRegistry.getGlobal()).not.toBeNull();
    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe(
      "unsupported",
    );
  });
});
