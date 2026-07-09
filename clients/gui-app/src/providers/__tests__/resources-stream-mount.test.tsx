import "../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useSettingsStore } from "@/stores/settings/settings-store";

function installStubFactory(): void {
  __setResourcesStreamClientFactoryForTests(() => ({
    close: () => undefined,
  }));
}

function setResourceUiSettings(
  showGlobalResourceMonitor: boolean,
  showNavigatorResourceStats: boolean,
): void {
  useSettingsStore.setState({
    showGlobalResourceMonitor,
    showNavigatorResourceStats,
  });
}

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
  setResourceUiSettings(true, false);
});

describe("<ResourcesStreamMount />", () => {
  it("acquires nothing when both resource-UI settings are off", () => {
    installStubFactory();
    setResourceUiSettings(false, false);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("acquires the registry entry when the global monitor setting is on", () => {
    installStubFactory();
    setResourceUiSettings(true, false);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires the registry entry when the navigator chips setting is on", () => {
    installStubFactory();
    setResourceUiSettings(false, true);

    render(<ResourcesStreamMount epicId="epic-1" />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires live when a setting flips on mid-session, without remounting", () => {
    installStubFactory();
    setResourceUiSettings(false, false);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    act(() => {
      setResourceUiSettings(true, false);
    });

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("releases live when the last-on setting flips off mid-session", () => {
    installStubFactory();
    setResourceUiSettings(true, false);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => {
      setResourceUiSettings(false, false);
    });

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("keeps the entry held while at least one setting stays on", () => {
    installStubFactory();
    setResourceUiSettings(true, true);

    render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => {
      setResourceUiSettings(false, true);
    });

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("releases the entry on unmount", () => {
    installStubFactory();
    setResourceUiSettings(true, false);

    const { unmount } = render(<ResourcesStreamMount epicId="epic-1" />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    unmount();

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });
});
