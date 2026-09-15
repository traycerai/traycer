import { describe, expect, it } from "vitest";
import {
  ACCESSIBILITY_SNAPSHOT_MAX_NAME,
  ACCESSIBILITY_SNAPSHOT_MAX_NODES,
  projectAccessibilityTree,
} from "../browser-accessibility-snapshot";

function node(
  nodeId: string,
  role: string,
  name: string | null,
  childIds: readonly string[],
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    nodeId,
    role: { type: "role", value: role },
    ...(name === null ? {} : { name: { type: "computedString", value: name } }),
    childIds,
    ...extra,
  };
}

describe("projectAccessibilityTree", () => {
  it("reports controls with their role and computed name", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", "Page", ["2", "3"], {}),
        node("2", "button", "Save", [], {}),
        node("3", "textbox", "Email", [], {}),
      ],
    });
    expect(nodes).toEqual([
      { role: "button", name: "Save", interactive: true, depth: 0 },
      { role: "textbox", name: "Email", interactive: true, depth: 0 },
    ]);
  });

  it("marks a heading as reported but not interactive", () => {
    const nodes = projectAccessibilityTree({
      nodes: [node("1", "RootWebArea", null, ["2"], {}), node("2", "heading", "Billing", [], {})],
    });
    expect(nodes[0]).toMatchObject({ role: "heading", interactive: false });
  });

  it("drops the generic containers a DOM walk would include", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "generic", null, ["3"], {}),
        node("3", "button", "Deep", [], {}),
      ],
    });
    expect(nodes).toEqual([
      { role: "button", name: "Deep", interactive: true, depth: 0 },
    ]);
  });

  it("keeps depth so a flat list still shows nesting", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "menu", "Actions", ["3"], {}),
        node("3", "menuitem", "Delete", [], {}),
      ],
    });
    expect(nodes.map((entry) => [entry.role, entry.depth])).toEqual([
      ["menu", 0],
      ["menuitem", 1],
    ]);
  });

  it("skips a node Chromium marked ignored", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "button", "Hidden", [], { ignored: true }),
      ],
    });
    expect(nodes).toEqual([]);
  });

  it("reports a nameless control rather than dropping it", () => {
    // An unlabelled button is a real finding for an agent and for a developer.
    const nodes = projectAccessibilityTree({
      nodes: [node("1", "RootWebArea", null, ["2"], {}), node("2", "button", null, [], {})],
    });
    expect(nodes).toEqual([
      { role: "button", name: "", interactive: true, depth: 0 },
    ]);
  });

  it("carries no value field, whatever the payload offered", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "textbox", "Password", [], {
          value: { type: "string", value: "hunter2" },
        }),
      ],
    });
    // A text input's value is what the user typed; this snapshot goes to a model.
    expect(JSON.stringify(nodes)).not.toContain("hunter2");
  });

  it("bounds a name a page made enormous", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "button", "x".repeat(5_000), [], {}),
      ],
    });
    expect(nodes[0]?.name.length).toBe(ACCESSIBILITY_SNAPSHOT_MAX_NAME);
  });

  it("stops at the node cap rather than holding a whole huge tree", () => {
    const children = Array.from({ length: 500 }, (_, index) =>
      node(`c${String(index)}`, "button", `Button ${String(index)}`, [], {}),
    );
    const nodes = projectAccessibilityTree({
      nodes: [
        node(
          "root",
          "RootWebArea",
          null,
          children.map((child) => String(child.nodeId)),
          {},
        ),
        ...children,
      ],
    });
    expect(nodes.length).toBe(ACCESSIBILITY_SNAPSHOT_MAX_NODES);
  });

  it("terminates on a cyclic child reference instead of hanging", () => {
    const nodes = projectAccessibilityTree({
      nodes: [
        node("1", "RootWebArea", null, ["2"], {}),
        node("2", "menu", "Loop", ["2"], {}),
      ],
    });
    expect(nodes).toEqual([
      { role: "menu", name: "Loop", interactive: false, depth: 0 },
    ]);
  });

  it("ignores a child id pointing at nothing", () => {
    const nodes = projectAccessibilityTree({
      nodes: [node("1", "RootWebArea", null, ["missing", "2"], {}), node("2", "link", "Docs", [], {})],
    });
    expect(nodes).toEqual([
      { role: "link", name: "Docs", interactive: true, depth: 0 },
    ]);
  });

  it("answers empty for every shape that is not a tree", () => {
    expect(projectAccessibilityTree(null)).toEqual([]);
    expect(projectAccessibilityTree({})).toEqual([]);
    expect(projectAccessibilityTree({ nodes: [] })).toEqual([]);
    expect(projectAccessibilityTree({ nodes: [{ nodeId: 7 }] })).toEqual([]);
  });

  it("finds the root by derivation, not by reported order", () => {
    const nodes = projectAccessibilityTree({
      nodes: [node("2", "button", "Child", [], {}), node("1", "RootWebArea", null, ["2"], {})],
    });
    expect(nodes).toEqual([
      { role: "button", name: "Child", interactive: true, depth: 0 },
    ]);
  });
});

describe("projectAccessibilityTree traversal bounds", () => {
  it("survives a deep chain of nodes it does not report", () => {
    // Every node here is ignored, so none is projected and the node cap never
    // trips. Only a bound on the WALK stops this, and without one the recursion
    // reaches the stack limit on a document a page can legitimately produce.
    const nodes: Array<Record<string, unknown>> = [];
    const total = 5000;
    for (let index = 0; index < total; index += 1) {
      nodes.push({
        nodeId: String(index),
        ignored: true,
        childIds: index + 1 < total ? [String(index + 1)] : [],
      });
    }

    expect(() => projectAccessibilityTree({ nodes })).not.toThrow();
    expect(projectAccessibilityTree({ nodes })).toEqual([]);
  });

  it("still reaches a reported node behind ignored scaffolding", () => {
    const nodes = [
      { nodeId: "0", ignored: true, childIds: ["1"] },
      { nodeId: "1", ignored: true, childIds: ["2"] },
      {
        nodeId: "2",
        role: { value: "button" },
        name: { value: "Send" },
        childIds: [],
      },
    ];

    expect(projectAccessibilityTree({ nodes })).toEqual([
      { role: "button", name: "Send", interactive: true, depth: 0 },
    ]);
  });
});

describe("projectAccessibilityTree interactivity", () => {
  function buttonWith(properties: unknown): unknown {
    return {
      nodes: [
        {
          nodeId: "0",
          role: { value: "button" },
          name: { value: "Submit" },
          properties,
          childIds: [],
        },
      ],
    };
  }

  it("reports a disabled control as not interactive", () => {
    const projected = projectAccessibilityTree(
      buttonWith([{ name: "disabled", value: { value: true } }]),
    );

    expect(projected).toEqual([
      { role: "button", name: "Submit", interactive: false, depth: 0 },
    ]);
  });

  it("accepts the string form of the disabled property", () => {
    const projected = projectAccessibilityTree(
      buttonWith([{ name: "disabled", value: { value: "true" } }]),
    );

    expect(projected[0]?.interactive).toBe(false);
  });

  it("still reports an enabled control as interactive", () => {
    const projected = projectAccessibilityTree(
      buttonWith([{ name: "disabled", value: { value: false } }]),
    );

    expect(projected[0]?.interactive).toBe(true);
  });

  it("treats a hostile properties shape as not disabled", () => {
    expect(projectAccessibilityTree(buttonWith("nonsense"))[0]?.interactive).toBe(
      true,
    );
    expect(projectAccessibilityTree(buttonWith([null]))[0]?.interactive).toBe(
      true,
    );
  });
});
