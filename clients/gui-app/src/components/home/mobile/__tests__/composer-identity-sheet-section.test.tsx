/**
 * `<ComposerIdentitySheetSection />`: the phone mirror of
 * `<ComposerIdentityPicker />`, driven directly off a `ComposerIdentityModel`
 * prop rather than fetching one itself - so this suite builds the model by
 * hand and asserts the row/removed-banner/action wiring only.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import { ComposerIdentitySheetSection } from "@/components/home/mobile/composer-identity-sheet-section";
import type { ComposerIdentityModel } from "@/components/home/pickers/composer-identity-model";
import type { IdentitiesDialogMode } from "@/stores/dialogs/desktop-dialog-store";

afterEach(cleanup);

const IDENTITY_A: AgentIdentitySummary = {
  identityId: "id-a",
  title: "Assistant A",
  description: null,
  updatedAt: 1,
};

function baseModel(
  overrides: Partial<ComposerIdentityModel>,
): ComposerIdentityModel {
  return {
    hostId: "host-1",
    identities: [IDENTITY_A],
    listFailed: false,
    resolution: { kind: "none" },
    ...overrides,
  };
}

function renderSection(overrides: {
  readonly model: ComposerIdentityModel;
  readonly onSelect: (identityId: string | null) => void;
  readonly onOpenIdentities: (mode: IdentitiesDialogMode) => void;
}) {
  return render(
    <ComposerIdentitySheetSection
      model={overrides.model}
      disabled={false}
      onSelect={overrides.onSelect}
      onOpenIdentities={overrides.onOpenIdentities}
    />,
  );
}

describe("<ComposerIdentitySheetSection />", () => {
  it("renders the removed row with a Clear action, calling onSelect(null)", () => {
    const onSelect = vi.fn<(identityId: string | null) => void>();
    renderSection({
      model: baseModel({
        resolution: { kind: "removed", identityId: "id-gone" },
      }),
      onSelect,
      onOpenIdentities: vi.fn<(mode: IdentitiesDialogMode) => void>(),
    });

    expect(
      screen.getByTestId("composer-options-identity-removed"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("composer-options-identity-clear"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("selecting an identity row calls onSelect with that identity's id", () => {
    const onSelect = vi.fn<(identityId: string | null) => void>();
    renderSection({
      model: baseModel({ resolution: { kind: "none" } }),
      onSelect,
      onOpenIdentities: vi.fn<(mode: IdentitiesDialogMode) => void>(),
    });

    fireEvent.click(screen.getByTestId("composer-options-identity-id-a"));
    expect(onSelect).toHaveBeenCalledWith("id-a");
  });

  it("calls onOpenIdentities('create') from New identity", () => {
    const onOpenIdentities = vi.fn<(mode: IdentitiesDialogMode) => void>();
    renderSection({
      model: baseModel({}),
      onSelect: vi.fn<(identityId: string | null) => void>(),
      onOpenIdentities,
    });

    fireEvent.click(screen.getByTestId("composer-options-identity-new"));
    expect(onOpenIdentities).toHaveBeenCalledWith("create");
  });

  it("calls onOpenIdentities('list') from Manage identities", () => {
    const onOpenIdentities = vi.fn<(mode: IdentitiesDialogMode) => void>();
    renderSection({
      model: baseModel({}),
      onSelect: vi.fn<(identityId: string | null) => void>(),
      onOpenIdentities,
    });

    fireEvent.click(screen.getByTestId("composer-options-identity-manage"));
    expect(onOpenIdentities).toHaveBeenCalledWith("list");
  });
});
