import { afterEach, describe, expect, it } from "vitest";
import { CanvasFrameRegistry } from "../canvas-frame-registry";
import {
  BOARD_PATH,
  canvasElement,
  disposeBridges,
  realBridge,
} from "./canvas-edit-test-support";

afterEach(disposeBridges);

const SHA = "sha-served";

function registryWithRequest() {
  const bridge = realBridge();
  const registry = new CanvasFrameRegistry();
  registry.update(BOARD_PATH, { bridge, sha256: SHA });
  registry.update(BOARD_PATH, {
    retype: {
      id: "request-1",
      generation: 1,
      element: canvasElement({}),
      sha256: SHA,
      bridge,
    },
  });
  return { registry, bridge };
}

describe("CanvasFrameRegistry retype request", () => {
  it("is kept while the frame it came from is unchanged", () => {
    const { registry, bridge } = registryWithRequest();
    expect(registry.get(BOARD_PATH).retype).toMatchObject({
      id: "request-1",
      bridge,
    });
  });

  it("is kept through updates that say nothing new about the frame's identity", () => {
    const { registry } = registryWithRequest();
    registry.update(BOARD_PATH, {
      page: "page-1",
      size: { width: 10, height: 20 },
    });
    registry.update(BOARD_PATH, { sha256: SHA });
    expect(registry.get(BOARD_PATH).retype?.id).toBe("request-1");
  });

  it("is cleared when the bridge goes away", () => {
    const { registry } = registryWithRequest();
    registry.update(BOARD_PATH, { bridge: null });
    expect(registry.get(BOARD_PATH).retype).toBeNull();
  });

  it("is not brought back by the same bridge returning", () => {
    const { registry, bridge } = registryWithRequest();
    registry.update(BOARD_PATH, { bridge: null });
    registry.update(BOARD_PATH, { bridge });
    expect(registry.get(BOARD_PATH).retype).toBeNull();
  });

  it("is cleared when another bridge takes over", () => {
    const { registry } = registryWithRequest();
    registry.update(BOARD_PATH, { bridge: realBridge() });
    expect(registry.get(BOARD_PATH).retype).toBeNull();
  });

  it("is cleared when the frame element is replaced or removed", () => {
    const first = registryWithRequest();
    first.registry.update(BOARD_PATH, {
      frame: document.createElement("iframe"),
    });
    expect(first.registry.get(BOARD_PATH).retype).toBeNull();

    const second = registryWithRequest();
    second.registry.update(BOARD_PATH, { frame: null });
    // Already null, so nothing changed and the request stays.
    expect(second.registry.get(BOARD_PATH).retype?.id).toBe("request-1");
  });

  it("is cleared when the served revision changes", () => {
    const { registry } = registryWithRequest();
    registry.update(BOARD_PATH, { sha256: "sha-newer" });
    expect(registry.get(BOARD_PATH).retype).toBeNull();
  });

  it("is cleared when the board's source changes", () => {
    const { registry } = registryWithRequest();
    registry.update(BOARD_PATH, {
      source: { kind: "html", html: "<p>new</p>" },
    });
    expect(registry.get(BOARD_PATH).retype).toBeNull();
  });

  it("belongs to one board and leaves the others alone", () => {
    const { registry } = registryWithRequest();
    registry.update("boards/other.html", { bridge: realBridge() });
    expect(registry.get(BOARD_PATH).retype?.id).toBe("request-1");
  });

  it("tells subscribers when it is cleared", () => {
    const { registry } = registryWithRequest();
    let heard = 0;
    registry.subscribe(() => {
      heard += 1;
    });
    registry.update(BOARD_PATH, { bridge: null });
    expect(heard).toBe(1);
  });
});
