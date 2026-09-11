import { describe, expect, it } from "vitest";
import { movedTabLayout } from "../moved-tab-layout";

const customization = { color: "#8ab4f8", icon: "★", groupId: "group-a" };

describe("movedTabLayout", () => {
  it.each([
    ["epic", "epic-a"],
    ["draft", "draft-a"],
  ] as const)("carries %s customization into the moved layout", (kind, id) => {
    const result = movedTabLayout(
      {
        version: 2,
        customizations: { [`${kind}:${id}`]: customization },
        groups: {
          "group-a": { name: "Project", color: "#f28b82", collapsed: false },
          unused: { name: "Unused", color: "#81c995", collapsed: true },
        },
      },
      kind,
      id,
    );
    expect(result).toMatchObject({
      customizations: { [`${kind}:${id}`]: customization },
      groups: { "group-a": { name: "Project" } },
      items: [{ ref: { kind, id } }],
    });
  });

  it("drops missing or invalid customization metadata", () => {
    expect(movedTabLayout({ version: 2 }, "epic", "missing")).toBeNull();
    expect(
      movedTabLayout(
        { version: 2, customizations: { "epic:bad": "invalid" } },
        "epic",
        "bad",
      ),
    ).toBeNull();
  });
});
