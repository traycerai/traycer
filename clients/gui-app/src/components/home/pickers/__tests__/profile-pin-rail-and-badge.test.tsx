import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HarnessOption } from "@/components/home/data/landing-options";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { deriveHarnessModelPickerPresentation } from "@/components/home/pickers/harness-model-picker-presentation";
import { ProviderRail } from "@/components/home/pickers/harness-model-picker-group";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import type { RemovedProviderProfile } from "@/components/providers/provider-profile-model";
import {
  pinProfile,
  legacyProfile,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";

const QUIET: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

function codexHarness(): HarnessOption {
  return {
    id: "codex",
    label: "Codex",
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

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: input.aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

const side = managed({ profileId: "side-row", label: "Side", aliases: [] });
const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
});

function renderRail(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: readonly RemovedProviderProfile[];
  readonly activeProfileId: string | null;
}): HTMLElement {
  render(
    <LeaderHeldContext.Provider value={QUIET}>
      <ProviderRail
        harnesses={[codexHarness()]}
        fallbackHarnesses={[]}
        profilesByHarnessId={
          new Map<GuiHarnessId, ReadonlyArray<ProviderProfile>>([
            ["codex", input.profiles],
          ])
        }
        removedProfilesByHarnessId={
          new Map<GuiHarnessId, readonly RemovedProviderProfile[]>([
            ["codex", input.removed],
          ])
        }
        activeProviderId="codex"
        activeProfileIdByHarnessId={
          new Map<GuiHarnessId, string | null>([
            ["codex", input.activeProfileId],
          ])
        }
        lockedHarnessId={null}
        degradedHarnessIds={new Set()}
        preparingByHarnessId={new Map<GuiHarnessId, ProviderPackPreparing>()}
        pending={false}
        onEntryChange={vi.fn()}
        onRetryPack={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onRefresh={() => Promise.resolve()}
        refreshDisabledReason={undefined}
        offeredAgents={null}
      />
    </LeaderHeldContext.Provider>,
  );
  return screen.getByRole("tab", { name: "Codex" });
}

function dotInitial(tab: HTMLElement): string | null {
  return tab.querySelector("[style*='--swatch']")?.textContent ?? null;
}

function renderBadge(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: readonly RemovedProviderProfile[];
  readonly profileId: string | null;
}): HTMLElement {
  const presentation = deriveHarnessModelPickerPresentation({
    selection: {
      harnessId: "codex",
      modelSlug: "desk-model",
      profileId: input.profileId,
    },
    models: [],
    selectedModel: null,
    stagedModelName: "Desk model",
    reasoningFooter: null,
    serviceTierFooter: null,
    harnessesPending: false,
    modelsPending: false,
    selectedHarnessAvailable: true,
    selectedHarnessProfiles: input.profiles,
    selectedHarnessRemovedProfiles: input.removed,
  });
  render(
    <HarnessModelTrigger
      ultracode={null}
      selection={{
        harnessId: "codex",
        modelSlug: "desk-model",
        profileId: input.profileId,
      }}
      label={presentation.label}
      reasoningLabel={presentation.reasoningLabel}
      reasoningStep={presentation.reasoningStep}
      reasoningIndicator="text"
      serviceTierLabel={presentation.activeServiceTierLabel}
      serviceTierActive={presentation.serviceTierActive}
      maxModeRequired={presentation.maxModeRequired}
      profileLabel={presentation.profileLabel}
      profileAccentDot={presentation.profileAccentDot}
      isLoading={presentation.isLoading}
      disabled={false}
      labelDisplay="responsive"
    />,
  );
  return screen.getByRole("button");
}

describe("profile pin on the rail and the composer badge", () => {
  afterEach(() => cleanup());

  it("the rail dot is the canonical row for an alias", () => {
    const tab = renderRail({
      profiles: [side, work],
      removed: [],
      activeProfileId: "alias-work",
    });
    expect(dotInitial(tab)).toBe("W");
  });

  it("the rail dot is absent when the removed list names the pin", () => {
    const tab = renderRail({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      activeProfileId: "gone-row",
    });
    expect(dotInitial(tab)).toBeNull();
  });

  it("the rail dot is the first row for an unknown id", () => {
    const tab = renderRail({
      profiles: [side, work],
      removed: [],
      activeProfileId: "missing-id",
    });
    expect(dotInitial(tab)).toBe("S");
  });

  it("the composer badge names the canonical row and its dot", () => {
    const button = renderBadge({
      profiles: [side, work],
      removed: [],
      profileId: "alias-work",
    });
    expect(button.getAttribute("aria-label")).toBe("Desk model, Work");
    expect(dotInitial(button)).toBe("W");
  });

  it("the composer badge is omitted for a removed pin", () => {
    const button = renderBadge({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      profileId: "gone-row",
    });
    expect(button.getAttribute("aria-label")).toBe("Desk model");
    expect(dotInitial(button)).toBeNull();
  });

  it("the composer badge is omitted for an unknown id", () => {
    const button = renderBadge({
      profiles: [side, work],
      removed: [],
      profileId: "missing-id",
    });
    expect(button.getAttribute("aria-label")).toBe("Desk model");
    expect(dotInitial(button)).toBeNull();
  });

  it("a 10.10-shaped list badges the named row and omits the badge for an unknown id", () => {
    const olderSide = legacyProfile({
      profileId: "side-row",
      label: "Side",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const olderWork = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const known = renderBadge({
      profiles: [olderSide, olderWork],
      removed: [],
      profileId: "work-row",
    });
    expect(known.getAttribute("aria-label")).toBe("Desk model, Work");
    expect(dotInitial(known)).toBe("W");
    cleanup();
    const unknown = renderBadge({
      profiles: [olderSide, olderWork],
      removed: [],
      profileId: "missing-id",
    });
    expect(unknown.getAttribute("aria-label")).toBe("Desk model");
    expect(dotInitial(unknown)).toBeNull();
  });
});
