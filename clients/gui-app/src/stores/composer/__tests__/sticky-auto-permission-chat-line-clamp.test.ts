import { beforeEach, describe, expect, it } from "vitest";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HarnessOption } from "@/components/home/data/landing-options";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";

const HOST_ID = "host-sticky-auto";

// A harness row that honours every mode, `auto` included - so the clamp
// exercised here is the HOST proof (`chatLineCarriesAutoMode`), not a row
// constraint that would otherwise mask it.
const AUTO_HONORING_CLAUDE: HarnessOption = {
  id: "claude",
  label: "Claude Code",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [
    "supervised",
    "auto_accept_edits",
    "auto",
    "full_access",
  ],
  nativeAutoJudge: false,
  availabilityPending: false,
};

function createStickyAutoStore(
  chatLineCarriesAutoMode: boolean | null,
): ComposerToolbarStore {
  const store = createComposerToolbarStore({
    purpose: "run",
    seedKey: "seed-sticky-auto",
    values: {
      permission: "auto",
      selection: {
        harnessId: "claude",
        modelSlug: "sonnet-4.5",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode,
    hostId: HOST_ID,
  });
  store.getState().setCatalog({
    hostId: HOST_ID,
    chatLineCarriesAutoMode,
    harnesses: [AUTO_HONORING_CLAUDE],
    modelsHarnessId: "claude",
    models: [],
    modelsLoaded: true,
    tuiOnly: false,
  });
  return store;
}

describe("composer-toolbar-store: the sticky clamp consults BOTH the catalog line and the chat line", () => {
  beforeEach(() => {
    // Module-level state - a leftover handshake from another test file would
    // make `catalogLineKnowsAutoMode` answer true independent of what this
    // suite records.
    resetNegotiatedManifests();
    // Pin the host's `agent.gui.listHarnesses` line at 9.1, the catalog proof
    // `autoModeOfferableHere` needs before the chat-line proof is ever
    // consulted.
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": agentGuiListHarnessesV91.schemaVersion,
    });
  });

  // THE FIX: gating the sticky clamp on the catalog line alone previously let
  // a sticky `auto` survive here, even though this chat's own negotiated
  // `chat.subscribe` line cannot carry the enum - the composer would then
  // throw at the projection cliff on send.
  it("demotes a sticky auto permission when the chat line cannot carry auto", () => {
    const store = createStickyAutoStore(false);

    expect(store.getState().permission).toBe("auto_accept_edits");
    // The raw sticky value is untouched either way - only the derived,
    // displayed/emitted permission is clamped.
    expect(store.getState().values.permission).toBe("auto");
  });

  it("keeps a sticky auto permission when the chat line carries auto", () => {
    const store = createStickyAutoStore(true);

    expect(store.getState().permission).toBe("auto");
  });

  it("keeps a sticky auto permission when no chat is in scope (chat line null)", () => {
    const store = createStickyAutoStore(null);

    expect(store.getState().permission).toBe("auto");
  });

  // The clamp above only runs when `setCatalog` decides the catalog CHANGED,
  // and `sameCatalog` used to compare six fields without this one. A chat whose
  // line proof flips `true` -> `false` - the host answering later, or the tab
  // rebinding - therefore hit the early return with `permission` still `auto`,
  // and the ordinary composer's submit path copies that into `ChatRunSettings`
  // with no further clamp, so the send died at the projection cliff.
  //
  // The second catalog must be a SPREAD of the first: `sameCatalog` compares
  // `harnesses` and `models` by reference, so rebuilding either array makes the
  // catalogs differ, re-derives for the wrong reason, and passes with the bug
  // still present.
  it("re-derives the clamp when the chat line is the ONLY field that changed", () => {
    const catalog: ComposerToolbarCatalog = {
      hostId: HOST_ID,
      chatLineCarriesAutoMode: true,
      harnesses: [AUTO_HONORING_CLAUDE],
      modelsHarnessId: "claude",
      models: [],
      modelsLoaded: true,
      tuiOnly: false,
    };
    const store = createComposerToolbarStore({
      purpose: "run",
      seedKey: "seed-sticky-auto-same-catalog",
      values: {
        permission: "auto",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: null,
        },
        reasoning: "",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: true,
      hostId: HOST_ID,
    });
    store.getState().setCatalog(catalog);
    expect(store.getState().permission).toBe("auto");

    store.getState().setCatalog({
      ...catalog,
      chatLineCarriesAutoMode: false,
    });

    expect(store.getState().permission).toBe("auto_accept_edits");
    expect(store.getState().values.permission).toBe("auto");
  });
});
