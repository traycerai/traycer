import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnSlotRowNoteText } from "@/components/settings/personal/own-slot-row-note";

afterEach(cleanup);

const PRESENT_ENTRIES = [
  {
    kind: "shell",
    key: "shell",
    os: "linux",
    state: "value",
    publishable: true,
  },
  {
    kind: "shell",
    key: "shell",
    os: "windows",
    state: "value",
    publishable: true,
  },
  {
    kind: "browser_agent_access",
    key: "browser",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "agent_selection_guide",
    key: "guide",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "agent_definition",
    key: "code-review",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "mcp_server",
    key: "Postgres_Analytics",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "fallback_policy",
    key: "fallback",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "pack_policy",
    key: "team-pack",
    os: "any",
    state: "value",
    publishable: true,
  },
  {
    kind: "managed_profile",
    key: "claude:4df981ac-8ea3-4a7d-a327-19b85b013dd5",
    os: "any",
    state: "value",
    publishable: true,
  },
] as const;

const ABSENT_ENTRIES = [
  {
    kind: "variable",
    key: "OPENAI_API_KEY",
    os: "linux",
    state: "absent",
    publishable: true,
  },
  {
    kind: "env_override",
    key: "claude:OPENAI_API_KEY",
    os: "any",
    state: "absent",
    publishable: true,
  },
] as const;

const DIVERGENT_MCP_ENTRY = {
  kind: "mcp_server",
  key: "Postgres_Analytics",
  os: "any",
  state: "value",
  publishable: false,
} as const;

describe("<OwnSlotRowNoteText />", () => {
  it("publishes each exact present address and renders only its approved value label", () => {
    const onChange = vi.fn();

    for (const entry of PRESENT_ENTRIES) {
      let valueDescription = "its own version";
      if (entry.kind === "shell") {
        valueDescription =
          entry.os === "linux"
            ? "/bin/zsh -l"
            : "C:\\Program Files\\PowerShell\\pwsh.exe -NoLogo";
      } else if (entry.kind === "browser_agent_access") {
        valueDescription = "On";
      }
      const rendered = render(
        <OwnSlotRowNoteText
          entry={entry}
          hostName="Old computer"
          valueDescription={valueDescription}
          disabled={false}
          onChange={onChange}
        />,
      );

      expect(screen.getByTestId("own-slot-row-note").textContent).toBe(
        `Old computer uses: ${valueDescription} · Use everywhere`,
      );
      fireEvent.click(screen.getByRole("button", { name: "Use everywhere" }));
      expect(onChange).toHaveBeenLastCalledWith(
        { kind: entry.kind, key: entry.key, os: entry.os },
        "publish",
      );
      rendered.unmount();
    }
  });

  it("restores Personal for absent variable slots without offering publish", () => {
    const onChange = vi.fn();

    for (const entry of ABSENT_ENTRIES) {
      const rendered = render(
        <OwnSlotRowNoteText
          entry={entry}
          hostName="Old computer"
          valueDescription={null}
          disabled={false}
          onChange={onChange}
        />,
      );

      expect(screen.getByTestId("own-slot-row-note").textContent).toBe(
        "Not set on Old computer · Use Personal's",
      );
      expect(
        screen.queryByRole("button", { name: "Use everywhere" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Use Personal's" }));
      expect(onChange).toHaveBeenLastCalledWith(
        { kind: entry.kind, key: entry.key, os: entry.os },
        "usePersonal",
      );
      rendered.unmount();
    }
  });

  it("keeps the same MCP note without an action when its source is divergent", () => {
    const onChange = vi.fn();
    render(
      <OwnSlotRowNoteText
        entry={DIVERGENT_MCP_ENTRY}
        hostName="Old computer"
        valueDescription="its own version"
        disabled={false}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId("own-slot-row-note").textContent).toBe(
      "Old computer uses: its own version",
    );
    expect(screen.queryByRole("button", { name: "Use everywhere" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
