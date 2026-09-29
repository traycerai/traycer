/**
 * `keepMounted` (Base's replacement for Radix's `forceMount` +
 * `data-[state=inactive]:hidden`, D11b): a panel a caller marks `keepMounted`
 * must stay in the DOM - so uncommitted input state is not lost - while
 * switching away from it, and it must not be exposed to the accessibility
 * tree (or the pointer) until its tab is active again. `markdown-edit-preview`
 * and the Settings Rules pane are the two real `keepMounted` consumers; this
 * covers the contract both rely on with a plain stateful child.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

afterEach(cleanup);

function StatefulField(): ReactNode {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Draft field"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

function KeepMountedTabs(): ReactNode {
  return (
    <Tabs defaultValue="editor">
      <TabsList>
        <TabsTrigger value="editor">Editor</TabsTrigger>
        <TabsTrigger value="other">Other</TabsTrigger>
      </TabsList>
      <TabsContent value="editor" keepMounted>
        <StatefulField />
      </TabsContent>
      <TabsContent value="other">Other panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs keepMounted", () => {
  it("keeps a switched-away panel's state alive and hides it from the a11y tree", async () => {
    const user = userEvent.setup();
    render(<KeepMountedTabs />);

    const field = screen.getByRole("textbox", { name: "Draft field" });
    await user.type(field, "uncommitted draft");
    expect(field).toHaveProperty("value", "uncommitted draft");

    await user.click(screen.getByRole("tab", { name: "Other" }));

    // Same DOM node, not a remount: an ordinary `getByRole` query (a11y-tree
    // visible only) cannot find it, `hidden: true` opts back into finding it.
    expect(screen.queryByRole("textbox", { name: "Draft field" })).toBeNull();
    const stillMounted = screen.getByRole("textbox", {
      name: "Draft field",
      hidden: true,
    });
    expect(stillMounted).toBe(field);
    expect(stillMounted).toHaveProperty("value", "uncommitted draft");

    await user.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("textbox", { name: "Draft field" })).toHaveProperty(
      "value",
      "uncommitted draft",
    );
  });

  it("unmounts a panel that never set keepMounted once it goes inactive", async () => {
    const user = userEvent.setup();
    render(<KeepMountedTabs />);

    await user.click(screen.getByRole("tab", { name: "Other" }));
    await user.click(screen.getByRole("tab", { name: "Editor" }));

    // The `other` panel has no `keepMounted`: switched away, it is gone
    // entirely rather than hidden - the two panels' contracts differ.
    expect(screen.queryByText("Other panel")).toBeNull();
  });
});
