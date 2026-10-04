import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PicturedOptions } from "@/components/layout-editor/inspector/pictured-options";
import { StripAgentRow } from "@/components/layout/tabs/side-strip/strip-agent-row";
import type { StripAgent } from "@/components/layout/tabs/side-strip/strip-task-agents";

afterEach(cleanup);

const AGENT: StripAgent = {
  id: "a1",
  title: "Runs",
  status: "turn",
  kind: "running",
  since: 0,
};

function renderOptions(onChange: (id: string) => void): void {
  render(
    <PicturedOptions
      label="Side tab view"
      value="tabs"
      disabled={false}
      labelPlacement="above"
      onChange={onChange}
      options={[
        {
          id: "tabs",
          label: "Tabs only",
          picture: <span>tabs</span>,
        },
        {
          // A real leaf: the strip's agent row is a `<button>`.
          id: "activity",
          label: "Tabs and agents",
          picture: (
            <StripAgentRow
              agent={AGENT}
              onScreen={false}
              onClick={undefined}
              onHoverChange={undefined}
            />
          ),
        },
      ]}
    />,
  );
}

describe("PicturedOptions", () => {
  it("never nests a picture's button inside a radio", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renderOptions(() => {});
    expect(document.querySelector("button button")).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("picks the option its radio names", () => {
    const onChange = vi.fn();
    renderOptions(onChange);
    fireEvent.click(screen.getByRole("radio", { name: "Tabs and agents" }));
    expect(onChange).toHaveBeenCalledWith("activity");
  });
});
