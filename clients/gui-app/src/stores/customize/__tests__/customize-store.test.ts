import { beforeEach, describe, expect, it } from "vitest";
import {
  useCustomizeStore,
  type HotspotInstance,
} from "@/stores/customize/customize-store";

function instance(overrides: Partial<HotspotInstance>): HotspotInstance {
  return {
    key: "statusBar.provider@shell:openai",
    settingId: "statusBar.provider",
    sceneId: "shell",
    tileId: "openai",
    node: document.createElement("div"),
    ghost: false,
    condition: null,
    ...overrides,
  };
}

function resetStore(): void {
  useCustomizeStore.setState({
    instances: new Map(),
    session: null,
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
  });
}

beforeEach(resetStore);

describe("customize-store instance registry", () => {
  it("registers a new key", () => {
    const a = instance({});

    useCustomizeStore.getState().register(a);

    expect(useCustomizeStore.getState().instances.get(a.key)).toBe(a);
    expect(useCustomizeStore.getState().instances.size).toBe(1);
  });

  it("re-registering the exact same instance is a no-op (identity check)", () => {
    const a = instance({});
    useCustomizeStore.getState().register(a);
    const before = useCustomizeStore.getState().instances;

    useCustomizeStore.getState().register(a);

    // Same object registered again -> the Map reference must not change, or
    // every selector reading `instances` would re-render for nothing.
    expect(useCustomizeStore.getState().instances).toBe(before);
  });

  it("registering a new instance under an existing key replaces it without duplicating", () => {
    const a = instance({});
    const b = instance({ node: document.createElement("div") });
    useCustomizeStore.getState().register(a);

    useCustomizeStore.getState().register(b);

    const { instances } = useCustomizeStore.getState();
    expect(instances.size).toBe(1);
    expect(instances.get(a.key)).toBe(b);
    expect(instances.get(a.key)).not.toBe(a);
  });

  it("unregister guards on the node: a stale unregister for a since-replaced node is ignored", () => {
    const a = instance({});
    const b = instance({ node: document.createElement("div") });
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);
    const before = useCustomizeStore.getState().instances;

    // A late-firing cleanup from the OLD node must not evict the new one.
    useCustomizeStore.getState().unregister(a.key, a.node);

    expect(useCustomizeStore.getState().instances).toBe(before);
    expect(useCustomizeStore.getState().instances.get(a.key)).toBe(b);
  });

  it("unregister removes the instance when the node matches", () => {
    const a = instance({});
    useCustomizeStore.getState().register(a);

    useCustomizeStore.getState().unregister(a.key, a.node);

    expect(useCustomizeStore.getState().instances.has(a.key)).toBe(false);
    expect(useCustomizeStore.getState().instances.size).toBe(0);
  });

  it("unregister of an unknown key is a no-op", () => {
    const before = useCustomizeStore.getState().instances;

    useCustomizeStore
      .getState()
      .unregister("nothing@shell:-", document.createElement("div"));

    expect(useCustomizeStore.getState().instances).toBe(before);
  });
});
