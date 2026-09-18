import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import { ProviderRail } from "@/components/home/pickers/harness-model-picker-group";

// The rail's `mod` leader hint lives on the SAME parent-accessible-name seam
// as the reasoning footer's `alt` hint - see
// harness-model-picker-footer-leader-badges.test.tsx and
// harness-model-picker-shortcut-hint.test.ts (`pickerLeaderControlLabel`,
// which builds the exact string). This is the one integration point that
// proves the rail wires `railButtonAriaLabel` + `pickerLeaderControlLabel` +
// the `selectable` gate together correctly on the real `<ProviderRail />`.
const MOD_HELD_BY_PICKER: LeaderState = {
  modHeld: true,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: LEADER_SCOPE_MODEL_PICKER,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

const MOD_NOT_HELD: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

function harness(id: "codex" | "claude"): HarnessOption {
  return {
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    availabilityPending: false,
    nativeAutoJudge: false,
  };
}

function renderRail(args: {
  readonly leaderState: LeaderState;
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly lockedHarnessId: GuiHarnessId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
}): void {
  render(
    <LeaderHeldContext.Provider value={args.leaderState}>
      <ProviderRail
        harnesses={args.harnesses}
        fallbackHarnesses={[]}
        profilesByHarnessId={
          new Map<GuiHarnessId, ReadonlyArray<ProviderProfile>>()
        }
        activeProviderId={args.harnesses[0].id}
        activeProfileIdByHarnessId={new Map<GuiHarnessId, string | null>()}
        lockedHarnessId={args.lockedHarnessId}
        degradedHarnessIds={args.degradedHarnessIds}
        preparingByHarnessId={new Map<GuiHarnessId, ProviderPackPreparing>()}
        pending={false}
        onEntryChange={vi.fn()}
        onRetryPack={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onRefresh={() => Promise.resolve()}
        refreshDisabledReason={undefined}
      />
    </LeaderHeldContext.Provider>,
  );
}

describe("<ProviderRail /> leader-hint accessible name", () => {
  afterEach(() => cleanup());

  it("names the spoken mod hint on the tab's own accessible name while ⌘/Ctrl is held", () => {
    renderRail({
      leaderState: MOD_HELD_BY_PICKER,
      harnesses: [harness("codex")],
      lockedHarnessId: null,
      degradedHarnessIds: new Set(),
    });

    const tab = screen.getByRole("tab", {
      name: "Codex. Press Control+1 to switch Codex",
    });
    expect(
      screen.getByTestId("model-provider-digit-1").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(tab.contains(screen.getByTestId("model-provider-digit-1"))).toBe(
      true,
    );
  });

  it("leaves the tab's accessible name unhinted once the leader is released", () => {
    renderRail({
      leaderState: MOD_NOT_HELD,
      harnesses: [harness("codex")],
      lockedHarnessId: null,
      degradedHarnessIds: new Set(),
    });

    expect(screen.getByRole("tab", { name: "Codex" })).not.toBeNull();
    expect(
      screen.queryByRole("tab", {
        name: "Codex. Press Control+1 to switch Codex",
      }),
    ).toBeNull();
  });

  it("says 'to browse', not 'to switch', for a degraded provider - it stays selectable, just not committable", () => {
    renderRail({
      leaderState: MOD_HELD_BY_PICKER,
      harnesses: [harness("codex")],
      lockedHarnessId: null,
      degradedHarnessIds: new Set(["codex"]),
    });

    expect(
      screen.getByRole("tab", {
        name: "Codex. Press Control+1 to browse Codex",
      }),
    ).not.toBeNull();
  });

  it("gates a harness locked out by an in-progress fork - no badge, no leader hint on its name", () => {
    renderRail({
      leaderState: MOD_HELD_BY_PICKER,
      harnesses: [harness("codex"), harness("claude")],
      lockedHarnessId: "claude",
      degradedHarnessIds: new Set(),
    });

    // Codex is locked out (a different harness is locked), so its badge is
    // suppressed and its accessible name carries no leader hint at all.
    expect(screen.getByRole("tab", { name: "Codex" })).not.toBeNull();
    expect(screen.queryByTestId("model-provider-digit-1")).toBeNull();

    // The locked-TO harness itself stays selectable and keeps its hint.
    expect(
      screen.getByRole("tab", {
        name: "Claude Code. Press Control+2 to switch Claude Code",
      }),
    ).not.toBeNull();
  });
});
