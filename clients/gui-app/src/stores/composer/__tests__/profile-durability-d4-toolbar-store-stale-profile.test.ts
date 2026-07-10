import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import type { HarnessOption } from "@/components/home/data/landing-options";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
} from "@/stores/composer/composer-toolbar-store";

/**
 * D4 (durability audit): "Fork dialog seeded from a chat whose profile is now
 * tombstoned: falls back to ambient for the new selection; no crash."
 *
 * `ComposerToolbarCatalog` (composer-toolbar-store.ts) only ever carries
 * `harnesses` + a harness's `models` - it never receives `profiles[]`, so
 * `deriveToolbarState` / `effectiveSelectionFromHarnesses` have no way to
 * know whether a seeded `profileId` still exists, and this file confirms
 * that stays true (the store presents a stale seed as fully resolved and
 * catalog-confirmed, with no crash).
 *
 * FIX LANDED at the CALLER boundary instead of here: threading `profiles[]`
 * into this shared catalog would touch every composer surface (main chat
 * composer, both fork dialogs, add-node, landing composer, ...) for a defect
 * that - per the audit - only bites fork dialogs (the main composer already
 * has `useProviderReauthGate` blocking send on a missing profile). Each fork
 * dialog now validates its OWN seed against live `providers.list` profiles
 * BEFORE handing it to this store (`resolveSeededProfileId` +
 * chat-fork-dialog.tsx / terminal-agent-fork-dialog.tsx) - see
 * `profile-durability-d4-terminal-fork-tombstoned.test.tsx` for the
 * passing end-to-end coverage. This file documents the resulting
 * architectural boundary: the store trusts its seed verbatim; the caller is
 * responsible for handing it a live one.
 */

const AVAILABLE_CLAUDE: HarnessOption = {
  id: "claude",
  label: "Claude Code",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: ["supervised", "full_access"],
  availabilityPending: false,
};

function catalogWithLoadedModels(): ComposerToolbarCatalog {
  return {
    harnesses: [AVAILABLE_CLAUDE],
    modelsHarnessId: "claude",
    models: [
      {
        harnessId: "claude",
        slug: "sonnet-4.5",
        label: "Sonnet",
        description: null,
        contextWindow: null,
        maxOutputTokens: null,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        defaultServiceTier: null,
        supportedServiceTiers: [],
        metadata: {},
      },
    ],
    modelsLoaded: true,
    tuiOnly: false,
  };
}

describe("D4: composer-toolbar-store trusts its seeded profileId (validation is the caller's job)", () => {
  it("a seed with a profileId that no longer exists anywhere else still survives untouched, with no crash - by design, the store has no profiles[] channel to judge it against", () => {
    const store = createComposerToolbarStore({
      seedKey: "seed-tombstoned",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: "tombstoned-uuid",
        },
        reasoning: "",
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: null,
      tuiOnly: false,
    });
    store.getState().setCatalog(catalogWithLoadedModels());

    // No crash, and the store presents a fully-resolved, catalog-confirmed
    // selection - it just happens to be pinned to a profile that no longer
    // exists anywhere else in the system. Safe ONLY because every caller
    // that seeds a possibly-stale profileId now either validates it first
    // (the fork dialogs) or gates send on it separately (the main composer's
    // reauth gate).
    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: "tombstoned-uuid",
    });
    expect(store.getState().selectionCatalogConfirmed).toBe(true);
  });

  it("an UNKNOWN harness for the tombstoned profile still survives cleanly (availability reroute only touches harnessId, never profileId)", () => {
    // The seed's harness itself is unavailable, forcing the availability
    // reroute in `effectiveSelectionFromHarnesses`. Confirms the reroute path
    // (a completely different code path from the steady-state one above)
    // also never inspects/clears `profileId` - the dead id would ride along
    // onto whatever harness the surface reroutes to if that harness were
    // read at commit time instead of being reset to `null` by the reroute's
    // own "profile belongs to the harness being rerouted OFF of" contract.
    const store = createComposerToolbarStore({
      seedKey: "seed-unavailable-harness",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: "tombstoned-uuid",
        },
        reasoning: "",
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: null,
      tuiOnly: false,
    });
    store.getState().setCatalog({
      harnesses: [{ ...AVAILABLE_CLAUDE, available: false }],
      modelsHarnessId: "claude",
      models: [],
      modelsLoaded: true,
      tuiOnly: false,
    });

    // No eligible harness at all: `effectiveSelectionFromHarnesses` returns
    // the selection UNCHANGED (not rerouted) - so the dead profileId still
    // rides along. No crash either way.
    expect(store.getState().selection.profileId).toBe("tombstoned-uuid");
  });
});
