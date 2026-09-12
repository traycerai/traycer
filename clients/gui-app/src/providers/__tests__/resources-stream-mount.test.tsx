import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import {
  useSettingsStore,
  type NavigatorResourceMetric,
} from "@/stores/settings/settings-store";

function installStubFactory(): void {
  __setResourcesStreamClientFactoryForTests(() => ({
    close: () => undefined,
    setDemand: () => undefined,
  }));
}

function setResourceUiSettings(
  showGlobalResourceMonitor: boolean,
  navigatorResourceMetrics: ReadonlyArray<NavigatorResourceMetric>,
): void {
  useSettingsStore.setState({
    showGlobalResourceMonitor,
    navigatorResourceMetrics,
  });
}

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
  setResourceUiSettings(true, []);
});

describe("<ResourcesStreamMount />", () => {
  it("acquires nothing when both resource-UI settings are off", () => {
    installStubFactory();
    setResourceUiSettings(false, []);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("acquires the registry entry when the global monitor setting is on", () => {
    installStubFactory();
    setResourceUiSettings(true, []);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires the registry entry when the navigator chips pick any metric", () => {
    installStubFactory();
    setResourceUiSettings(false, ["cpu"]);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires the registry entry for a pick that is not CPU", () => {
    installStubFactory();
    // The gate is the list's LENGTH, not any particular reading: a row showing
    // only the process count needs the same stream a CPU chip does.
    setResourceUiSettings(false, ["processes"]);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires live when a setting flips on mid-session, without remounting", () => {
    installStubFactory();
    setResourceUiSettings(false, []);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    act(() => {
      setResourceUiSettings(true, []);
    });

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("releases live when the last-on setting flips off mid-session", () => {
    installStubFactory();
    setResourceUiSettings(true, []);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => {
      setResourceUiSettings(false, []);
    });

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("keeps the entry held while at least one setting stays on", () => {
    installStubFactory();
    setResourceUiSettings(true, ["cpu"]);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => {
      setResourceUiSettings(false, ["cpu"]);
    });

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("releases the entry on unmount", () => {
    installStubFactory();
    setResourceUiSettings(true, []);

    const { unmount } = render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    unmount();

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });
});
