import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_ICON_CONFIG } from "@/components/home/data/harness-icon-map";
import { CommandCodeIcon } from "@/components/home/pickers/harness-icons";

describe("PROVIDER_ICON_CONFIG", () => {
  it("has an entry for every provider id the protocol declares", () => {
    const configured = Object.keys(PROVIDER_ICON_CONFIG).sort();
    // `claude-code` rides under its harness id `claude` in this map.
    const expected = providerIdSchema.options
      .map((id) => (id === "claude-code" ? "claude" : id))
      .sort();
    expect(configured).toEqual(expected);
  });

  it("maps commandcode to its own icon, shared with no other provider", () => {
    expect(PROVIDER_ICON_CONFIG.commandcode.Icon).toBe(CommandCodeIcon);
    const sharing = Object.entries(PROVIDER_ICON_CONFIG).filter(
      ([, config]) => config.Icon === CommandCodeIcon,
    );
    expect(sharing.map(([providerId]) => providerId)).toEqual(["commandcode"]);
    // Positive control: another provider keeps its own, different icon.
    expect(PROVIDER_ICON_CONFIG.reasonix.Icon).not.toBe(CommandCodeIcon);
  });

  it("renders the Command Code icon as an svg", () => {
    const { container } = render(<CommandCodeIcon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
