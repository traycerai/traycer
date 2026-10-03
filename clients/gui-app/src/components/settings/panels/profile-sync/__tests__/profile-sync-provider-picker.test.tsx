import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { ProfileCopyWireProvider } from "@/lib/profile-copy/profile-copy-model";
import { ProfileSyncProviderPicker } from "../profile-sync-provider-picker";
import {
  claudeProviderState,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

function claudeOnly(): readonly ProviderCliState[] {
  return [
    claudeProviderState([
      managedProfile("11111111-1111-4111-8111-111111111111", "Work"),
    ]),
  ];
}

function claudeAndCodex(): readonly ProviderCliState[] {
  return [
    ...claudeOnly(),
    {
      ...claudeProviderState([
        managedProfile("55555555-5555-4555-8555-555555555555", "Personal"),
      ]),
      providerId: "codex",
    },
  ];
}

describe("ProfileSyncProviderPicker", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Select all unions a saved provider missing from the catalog with the catalog's providers", async () => {
    const onChange = vi.fn<(selected: ProfileCopyWireProvider[]) => void>();
    const saved: ProfileCopyWireProvider[] = ["codex"];
    render(
      <ProfileSyncProviderPicker
        providers={claudeOnly()}
        selected={saved}
        onChange={onChange}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose providers" }));
    // One selected and one eligible is the same LENGTH, but not the same set.
    fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect([...next].sort()).toEqual(["claude", "codex"]);
  });

  it("reads Clear only when every eligible provider is a member of the selection", async () => {
    const onChange = vi.fn<(selected: ProfileCopyWireProvider[]) => void>();
    const { rerender } = render(
      <ProfileSyncProviderPicker
        providers={claudeAndCodex()}
        selected={["claude", "codex"]}
        onChange={onChange}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose providers" }));
    expect(await screen.findByRole("button", { name: "Clear" })).toBeTruthy();
    rerender(
      <ProfileSyncProviderPicker
        providers={claudeAndCodex()}
        selected={["codex"]}
        onChange={onChange}
        disabled={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Select all" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("holds the trigger and ignores selection while disabled", () => {
    const onChange = vi.fn<(selected: ProfileCopyWireProvider[]) => void>();
    render(
      <ProfileSyncProviderPicker
        providers={claudeAndCodex()}
        selected={["claude"]}
        onChange={onChange}
        disabled
      />,
    );
    const trigger = screen.getByRole("button", { name: "Choose providers" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("goes inert when disabled while the popover is already open", async () => {
    const onChange = vi.fn<(selected: ProfileCopyWireProvider[]) => void>();
    const { rerender } = render(
      <ProfileSyncProviderPicker
        providers={claudeAndCodex()}
        selected={["claude"]}
        onChange={onChange}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose providers" }));
    expect(
      await screen.findByRole("button", { name: "Select all" }),
    ).toBeTruthy();
    rerender(
      <ProfileSyncProviderPicker
        providers={claudeAndCodex()}
        selected={["claude"]}
        onChange={onChange}
        disabled
      />,
    );
    const selectAll = screen.getByRole("button", { name: "Select all" });
    expect(selectAll.hasAttribute("disabled")).toBe(true);
    fireEvent.click(selectAll);
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
