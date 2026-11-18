import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEpicResourcesLease } from "@/hooks/resources/use-epic-resources-lease";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

function installStubFactory(): void {
  __setResourcesStreamClientFactoryForTests(() => ({
    close: () => undefined,
    setDemand: () => undefined,
  }));
}

function Lease(props: {
  readonly epicId: string;
  readonly wanted: boolean;
}): null {
  useEpicResourcesLease(props.epicId, props.wanted);
  return null;
}

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
});

describe("useEpicResourcesLease", () => {
  it("acquires nothing while not wanted", () => {
    installStubFactory();

    render(<Lease epicId="epic-1" wanted={false} />);

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("acquires the registry entry while wanted", () => {
    installStubFactory();

    render(<Lease epicId="epic-1" wanted />);

    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
  });

  it("acquires and releases live as the demand flips, without remounting", () => {
    installStubFactory();

    const view = render(<Lease epicId="epic-1" wanted={false} />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    view.rerender(<Lease epicId="epic-1" wanted />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    view.rerender(<Lease epicId="epic-1" wanted={false} />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("releases the entry on unmount", () => {
    installStubFactory();

    const { unmount } = render(<Lease epicId="epic-1" wanted />);
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    unmount();

    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });
});
