import { describe, expect, it } from "vitest";
import { readComponentHint } from "../browser-element-component-hint";

/**
 * The detector reads private framework state off DOM nodes, so the suite builds
 * those shapes directly rather than mounting a framework: what is being tested
 * is the reading, including every way it can go wrong on a page that is not
 * cooperating.
 */
function element(): HTMLElement {
  return document.createElement("div");
}

function withKey(node: object, key: string, value: unknown): void {
  Object.defineProperty(node, key, {
    value,
    configurable: true,
    enumerable: true,
  });
}

describe("readComponentHint on React", () => {
  it("names a function component from its fiber", () => {
    const node = element();
    function SubmitButton(): null {
      return null;
    }
    withKey(node, "__reactFiber$abc", { elementType: SubmitButton });

    expect(readComponentHint(node).componentName).toBe("SubmitButton");
  });

  it("prefers an explicit displayName over the function name", () => {
    const node = element();
    const Inner = (): null => null;
    Object.defineProperty(Inner, "displayName", { value: "PrimaryAction" });
    withKey(node, "__reactFiber$x", { elementType: Inner });

    expect(readComponentHint(node).componentName).toBe("PrimaryAction");
  });

  it("reads the legacy internal-instance key too", () => {
    const node = element();
    function Card(): null {
      return null;
    }
    withKey(node, "__reactInternalInstance$1", { type: Card });

    expect(readComponentHint(node).componentName).toBe("Card");
  });

  it("unwraps a memo or forwardRef object to the component inside", () => {
    const node = element();
    function Tooltip(): null {
      return null;
    }
    withKey(node, "__reactFiber$y", { elementType: { render: Tooltip } });

    expect(readComponentHint(node).componentName).toBe("Tooltip");
  });

  it("walks the owner chain past host elements", () => {
    const node = element();
    function Panel(): null {
      return null;
    }
    withKey(node, "__reactFiber$z", {
      elementType: "div",
      _debugOwner: { elementType: Panel },
    });

    expect(readComponentHint(node).componentName).toBe("Panel");
  });

  it("reports the source location when a debug build recorded one", () => {
    const node = element();
    function Header(): null {
      return null;
    }
    withKey(node, "__reactFiber$s", {
      elementType: Header,
      _debugSource: { fileName: "/repo/src/Header.tsx", lineNumber: 42 },
    });

    const hint = readComponentHint(node);
    expect(hint.sourceFile).toBe("/repo/src/Header.tsx");
    expect(hint.sourceLine).toBe(42);
  });

  it("ignores a host element's own lowercase tag as a component name", () => {
    const node = element();
    withKey(node, "__reactFiber$h", { elementType: "div" });

    expect(readComponentHint(node).componentName).toBeNull();
  });

  it("skips wrapper names that name no editable component", () => {
    const node = element();
    const Wrapped = (): null => null;
    Object.defineProperty(Wrapped, "displayName", { value: "ForwardRef" });
    withKey(node, "__reactFiber$w", { elementType: Wrapped });

    expect(readComponentHint(node).componentName).toBeNull();
  });
});

describe("readComponentHint on Svelte and Vue", () => {
  it("takes Svelte's compiler-recorded file and line", () => {
    const node = element();
    withKey(node, "__svelte_meta", {
      loc: { file: "src/lib/Toolbar.svelte", line: 17 },
    });

    const hint = readComponentHint(node);
    expect(hint.componentName).toBe("Toolbar");
    expect(hint.sourceFile).toBe("src/lib/Toolbar.svelte");
    expect(hint.sourceLine).toBe(17);
  });

  it("prefers a Vue component's declared name over its inferred one", () => {
    const node = element();
    withKey(node, "__vueParentComponent", {
      type: { name: "AppShell", __name: "app-shell", __file: "src/AppShell.vue" },
    });

    expect(readComponentHint(node).componentName).toBe("AppShell");
  });

  it("falls back to the Vue filename when no name is declared", () => {
    const node = element();
    withKey(node, "__vueParentComponent", {
      type: { __file: "src/components/SideNav.vue" },
    });

    expect(readComponentHint(node).componentName).toBe("SideNav");
  });
});

describe("readComponentHint on an uncooperative page", () => {
  it("answers with nothing on a plain element", () => {
    expect(readComponentHint(element())).toEqual({
      componentName: null,
      sourceFile: null,
      sourceLine: null,
    });
  });

  it("survives a throwing getter on the very key it reads", () => {
    const node = element();
    Object.defineProperty(node, "__svelte_meta", {
      get() {
        throw new Error("no");
      },
      configurable: true,
      enumerable: true,
    });

    expect(() => readComponentHint(node)).not.toThrow();
    expect(readComponentHint(node).componentName).toBeNull();
  });

  it("ignores a source line that is not a positive integer", () => {
    const node = element();
    withKey(node, "__svelte_meta", {
      loc: { file: "src/A.svelte", line: -3 },
    });

    expect(readComponentHint(node).sourceLine).toBeNull();
  });

  it("bounds a component name a page made enormous", () => {
    const node = element();
    const Huge = (): null => null;
    Object.defineProperty(Huge, "displayName", { value: "A".repeat(5_000) });
    withKey(node, "__reactFiber$big", { elementType: Huge });

    const name = readComponentHint(node).componentName;
    expect(name).not.toBeNull();
    expect((name ?? "").length).toBeLessThanOrEqual(120);
  });

  it("bounds a source path a page made enormous", () => {
    const node = element();
    withKey(node, "__svelte_meta", {
      loc: { file: `/${"x".repeat(5_000)}/Deep.svelte`, line: 1 },
    });

    expect((readComponentHint(node).sourceFile ?? "").length).toBeLessThanOrEqual(
      400,
    );
  });

  it("stops walking rather than following a cyclic owner chain forever", () => {
    const node = element();
    const fiber: Record<string, unknown> = { elementType: "div" };
    fiber._debugOwner = fiber;
    withKey(node, "__reactFiber$loop", fiber);

    expect(readComponentHint(node).componentName).toBeNull();
  });

  it("finds a component on an ancestor of the marked leaf", () => {
    const parent = element();
    const child = element();
    parent.appendChild(child);
    function Row(): null {
      return null;
    }
    withKey(parent, "__reactFiber$p", { elementType: Row });

    expect(readComponentHint(child).componentName).toBe("Row");
  });
});

/**
 * Every one of these objects belongs to the PAGE, so every property read on the
 * way down is a call into page code that can throw. The detector runs inside the
 * annotation overlay's guest script, where an escaping throw takes the overlay
 * with it.
 */
describe("readComponentHint against hostile getters", () => {
  function throwingGetter(node: object, key: string): void {
    Object.defineProperty(node, key, {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
      enumerable: true,
    });
  }

  it("survives a throwing __svelte_meta.loc", () => {
    const node = element();
    const meta = {};
    throwingGetter(meta, "loc");
    withKey(node, "__svelte_meta", meta);

    expect(() => readComponentHint(node)).not.toThrow();
    expect(readComponentHint(node).componentName).toBeNull();
  });

  it("survives a throwing loc.file", () => {
    const node = element();
    const loc = {};
    throwingGetter(loc, "file");
    withKey(node, "__svelte_meta", { loc });

    expect(() => readComponentHint(node)).not.toThrow();
  });

  it("survives a throwing __vueParentComponent.type", () => {
    const node = element();
    const instance = {};
    throwingGetter(instance, "type");
    withKey(node, "__vueParentComponent", instance);

    expect(() => readComponentHint(node)).not.toThrow();
  });

  it("survives a throwing type.name on a Vue component", () => {
    const node = element();
    const type = {};
    throwingGetter(type, "name");
    withKey(node, "__vueParentComponent", { type });

    expect(() => readComponentHint(node)).not.toThrow();
  });

  it("survives a throwing fiber.elementType", () => {
    const node = element();
    const fiber = {};
    throwingGetter(fiber, "elementType");
    withKey(node, "__reactFiber$abc", fiber);

    expect(() => readComponentHint(node)).not.toThrow();
  });

  it("survives a throwing _debugOwner in the owner walk", () => {
    const node = element();
    const fiber = {};
    throwingGetter(fiber, "_debugOwner");
    withKey(node, "__reactFiber$abc", fiber);

    expect(() => readComponentHint(node)).not.toThrow();
  });

  it("survives a throwing _debugSource", () => {
    const node = element();
    function Card(): null {
      return null;
    }
    const fiber = { elementType: Card };
    throwingGetter(fiber, "_debugSource");
    withKey(node, "__reactFiber$abc", fiber);

    expect(() => readComponentHint(node)).not.toThrow();
    // The name still resolves: one unreadable field is not the whole hint.
    expect(readComponentHint(node).componentName).toBe("Card");
  });

  it("survives a throwing displayName on a memo wrapper", () => {
    const node = element();
    const type = {};
    throwingGetter(type, "displayName");
    withKey(node, "__reactFiber$abc", { elementType: type });

    expect(() => readComponentHint(node)).not.toThrow();
  });
});
