import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useLayoutStore } from "@/stores/layout/layout-store";

function installStubFactory(): void {
  __setResourcesStreamClientFactoryForTests(() => ({
    close: () => undefined,
    setDemand: () => undefined,
  }));
}

/**
 * Two switches own the readings now (G7): the resource monitor's own `shown`
 * and the sidebar rows' independent `agentRows`. The stream connects while
 * EITHER wants it, so a test isolating one leaf's effect must pin the other.
 */
function setResourceMonitor(values: {
  readonly shown: boolean;
  readonly agentRows: boolean;
}): void {
  useLayoutStore.getState().setRegionValues("resourceMonitor", {
    shown: values.shown ? "shown" : "hidden",
    agentRows: values.agentRows,
  });
}

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
  setResourceMonitor({ shown: true, agentRows: true });
});

describe("<ResourcesStreamMount />", () => {
  it("acquires live when the monitor is shown mid-session, without remounting", () => {
    installStubFactory();
    setResourceMonitor({ shown: false, agentRows: false });

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    act(() => {
      setResourceMonitor({ shown: true, agentRows: false });
    });

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("releases live when the monitor is hidden mid-session", () => {
    installStubFactory();
    setResourceMonitor({ shown: true, agentRows: false });

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => {
      setResourceMonitor({ shown: false, agentRows: false });
    });

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("releases the entry on unmount", () => {
    installStubFactory();
    setResourceMonitor({ shown: true, agentRows: false });

    const { unmount } = render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    unmount();

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  // agentRows and shown independently want the stream (G7).
  it.each([
    { shown: true, agentRows: false, connected: true },
    { shown: false, agentRows: true, connected: true },
    { shown: false, agentRows: false, connected: false },
    { shown: true, agentRows: true, connected: true },
  ])(
    "connects=$connected when shown=$shown and agentRows=$agentRows",
    ({ shown, agentRows, connected }) => {
      installStubFactory();
      setResourceMonitor({ shown, agentRows });

      render(<ResourcesStreamMount epicId="epic-1" />);

      expect(resourcesRegistry.get("epic-1") !== null).toBe(connected);
    },
  );
});
