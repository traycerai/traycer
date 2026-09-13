import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

const PERSIST_KEY = persistKey(STORE_KEYS.layout);

function resetStore(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  window.localStorage.clear();
}

async function rehydrateFrom(state: unknown): Promise<void> {
  window.localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({ state, version: CURRENT_PERSIST_VERSION }),
  );
  await useLayoutStore.persist.rehydrate();
}

describe("useLayoutStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe("status bar slice", () => {
    it("starts with the usage controls in the footer, everything visible", () => {
      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "status-bar",
        mobileFooter: false,
        rateLimits: {
          enabled: true,
          hiddenProviders: [],
          providers: {},
          percentMode: "used",
          showTimer: true,
          showBar: true,
          showModeWord: true,
        },
        resources: {
          enabled: true,
          metrics: ["cpu", "memory", "processes"],
          scope: "host-tree",
        },
      });
    });

    // Moving AWAY from the default, since the default is now the footer and
    // the setter is a no-op for the value already held.
    it("persists a placement move under the slice", async () => {
      useLayoutStore.getState().setStatusBarPlacement("header");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          statusBar: {
            ...DEFAULT_STATUS_BAR_LAYOUT,
            placement: "header",
          },
          composer: DEFAULT_COMPOSER_LAYOUT,
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    // The header is a CHOICE once it is written down, so the new footer
    // default never reaches a slice that carries one - there is no migration,
    // and a store serialised under the old default keeps the header until its
    // owner says otherwise.
    it("keeps an explicitly persisted header placement", async () => {
      await rehydrateFrom({ statusBar: { placement: "header" } });

      expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    });

    // The phone's own answer to "is there a strip at all", and the one value
    // on this slice a fresh install must read `false` for: the footer is
    // opt-in there, so a default that drifted would ship the surface to every
    // phone that has never opened Settings.
    it("starts with the mobile footer off", () => {
      expect(DEFAULT_STATUS_BAR_LAYOUT.mobileFooter).toBe(false);
      expect(useLayoutStore.getState().statusBar.mobileFooter).toBe(false);
    });

    it("persists a mobile-footer flip under the slice", async () => {
      useLayoutStore.getState().setStatusBarMobileFooter(true);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, mobileFooter: true },
          composer: DEFAULT_COMPOSER_LAYOUT,
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("leaves state untouched when setStatusBarMobileFooter is handed the value already held", () => {
      const before = useLayoutStore.getState().statusBar;

      useLayoutStore.getState().setStatusBarMobileFooter(false);

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });

    it("rehydrates a fully valid slice verbatim", async () => {
      await rehydrateFrom({
        statusBar: {
          placement: "status-bar",
          mobileFooter: true,
          rateLimits: {
            enabled: false,
            hiddenProviders: ["codex"],
            providers: {
              "claude-code": {
                automatic: true,
                limitKeys: ["claude-code:model:Fable"],
              },
              codex: { automatic: false, limitKeys: ["codex:secondary"] },
            },
            percentMode: "remaining",
            showTimer: false,
            showBar: false,
            showModeWord: false,
          },
          resources: {
            enabled: false,
            metrics: ["ramShare"],
            scope: "desktop-app",
          },
        },
      });

      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "status-bar",
        mobileFooter: true,
        rateLimits: {
          enabled: false,
          hiddenProviders: ["codex"],
          providers: {
            "claude-code": {
              automatic: true,
              limitKeys: ["claude-code:model:Fable"],
            },
            codex: { automatic: false, limitKeys: ["codex:secondary"] },
          },
          percentMode: "remaining",
          showTimer: false,
          showBar: false,
          showModeWord: false,
        },
        resources: {
          enabled: false,
          metrics: ["ramShare"],
          scope: "desktop-app",
        },
      });
    });

    // Each field is re-derived independently, so one corrupt value must not
    // take its neighbours down with it.
    it("falls back per field when the slice is partially corrupt", async () => {
      await rehydrateFrom({
        statusBar: {
          placement: "footer",
          mobileFooter: "yes",
          rateLimits: {
            enabled: "yes",
            hiddenProviders: "codex",
            providers: ["codex"],
            percentMode: "leftover",
            showTimer: 1,
            showBar: false,
            showModeWord: "no",
          },
          resources: { enabled: null, metrics: "cpu", scope: "everything" },
        },
      });

      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "status-bar",
        mobileFooter: false,
        rateLimits: {
          enabled: true,
          hiddenProviders: [],
          providers: {},
          percentMode: "used",
          showTimer: true,
          showBar: false,
          showModeWord: true,
        },
        resources: {
          enabled: true,
          metrics: ["cpu", "memory", "processes"],
          scope: "host-tree",
        },
      });
    });

    it.each([
      ["the record is not an object", "layout"],
      ["the slice is missing", {}],
      ["the slice is not an object", { statusBar: 3 }],
    ])(
      "falls back to the whole default slice when %s",
      async (_label, state) => {
        await rehydrateFrom(state);

        expect(useLayoutStore.getState().statusBar).toEqual(
          DEFAULT_STATUS_BAR_LAYOUT,
        );
      },
    );

    it("keeps every setter reachable after rehydrating a corrupt record", async () => {
      await rehydrateFrom(42);

      // Off the default, so the assertion fails if the setter does nothing.
      useLayoutStore.getState().setStatusBarPlacement("header");

      expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    });

    it("drops a persisted provider id no build knows and dedupes the rest", async () => {
      await rehydrateFrom({
        statusBar: {
          rateLimits: {
            hiddenProviders: ["codex", "codex", "not-a-provider", "grok"],
          },
        },
      });

      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["codex", "grok"]);
    });

    describe("per-provider limit selections", () => {
      it("drops an entry keyed by a provider id no build knows and keeps the rest", async () => {
        await rehydrateFrom({
          statusBar: {
            rateLimits: {
              providers: {
                codex: { automatic: false, limitKeys: ["codex:primary"] },
                "not-a-provider": { automatic: false, limitKeys: ["x:y"] },
              },
            },
          },
        });

        expect(
          useLayoutStore.getState().statusBar.rateLimits.providers,
        ).toEqual({
          codex: { automatic: false, limitKeys: ["codex:primary"] },
        });
      });

      it("dedupes a selection's keys, drops non-strings, and defaults a missing automatic flag to on", async () => {
        await rehydrateFrom({
          statusBar: {
            rateLimits: {
              providers: {
                codex: {
                  limitKeys: ["codex:primary", "codex:primary", "", 7],
                },
              },
            },
          },
        });

        expect(
          useLayoutStore.getState().statusBar.rateLimits.providers,
        ).toEqual({
          codex: { automatic: true, limitKeys: ["codex:primary"] },
        });
      });

      // A selection that draws nothing is not a state the UI can produce, so
      // one that arrives persisted is a hand edit - and the default is the
      // only drawable answer.
      it("restores the automatic default for a persisted selection that would draw nothing", async () => {
        await rehydrateFrom({
          statusBar: {
            rateLimits: {
              providers: {
                codex: { automatic: false, limitKeys: [] },
                grok: { automatic: false, limitKeys: [3] },
                cursor: "all",
              },
            },
          },
        });

        expect(
          useLayoutStore.getState().statusBar.rateLimits.providers,
        ).toEqual({
          codex: { automatic: true, limitKeys: [] },
          grok: { automatic: true, limitKeys: [] },
          cursor: { automatic: true, limitKeys: [] },
        });
      });

      it("falls back to no selections when the persisted map isn't an object", async () => {
        await rehydrateFrom({
          statusBar: { rateLimits: { providers: "codex" } },
        });

        expect(
          useLayoutStore.getState().statusBar.rateLimits.providers,
        ).toEqual({});
      });

      describe("migration from expandedProviders + hiddenWindowKeys", () => {
        it("turns an expanded provider into explicit picks of its fixed limits, less the hidden ones, with automatic off", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                expandedProviders: ["claude-code", "codex"],
                hiddenWindowKeys: [
                  "claude-code:sevenDayOpus",
                  "claude-code:model:Fable",
                ],
              },
            },
          });

          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual({
            "claude-code": {
              automatic: false,
              limitKeys: [
                "claude-code:fiveHour",
                "claude-code:sevenDay",
                "claude-code:sevenDaySonnet",
              ],
            },
            codex: {
              automatic: false,
              limitKeys: ["codex:primary", "codex:secondary"],
            },
          });
        });

        // An unexpanded provider drew its tightest alone, which is the default
        // and needs no entry. Its hidden keys had nothing to be removed from.
        it("drops hidden keys for a provider that was not expanded, leaving it on the default", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                expandedProviders: [],
                hiddenWindowKeys: ["codex:primary", "grok:period"],
              },
            },
          });

          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual({});
        });

        it("leaves an expanded provider on the default when every fixed limit was hidden", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                expandedProviders: ["grok", "not-a-provider"],
                hiddenWindowKeys: ["grok:period"],
              },
            },
          });

          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual({});
        });

        // Once the new shape has been written it is the record; the old lists
        // cannot re-migrate over a selection the user has since changed.
        it("ignores the old lists once a providers map is present", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                providers: {},
                expandedProviders: ["codex"],
                hiddenWindowKeys: ["codex:primary"],
              },
            },
          });

          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual({});
        });

        // The migration is a pure function of two build-constant inputs, which
        // is what makes it safe for hydration to re-run it: nothing rewrites
        // storage until the first preference write (see the store's comment),
        // so every app start until then resolves the same legacy blob again.
        it("resolves the same selections on a second rehydrate of the same legacy blob", async () => {
          const legacy = {
            statusBar: {
              rateLimits: {
                expandedProviders: ["codex"],
                hiddenWindowKeys: ["codex:primary"],
              },
            },
          };
          await rehydrateFrom(legacy);
          const first =
            useLayoutStore.getState().statusBar.rateLimits.providers;

          await rehydrateFrom(legacy);

          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual(first);
          expect(first).toEqual({
            codex: { automatic: false, limitKeys: ["codex:secondary"] },
          });
        });

        // Any write serialises the whole re-derived slice, so the first one
        // retires the old keys - including a write that has nothing to do with
        // providers.
        it("drops the old lists from storage on the first unrelated preference write", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                expandedProviders: ["codex"],
                hiddenWindowKeys: ["codex:primary"],
              },
            },
          });
          useLayoutStore.getState().setStatusBarShowBar(false);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          const raw = window.localStorage.getItem(PERSIST_KEY) ?? "{}";
          expect(raw).not.toContain("expandedProviders");
          expect(raw).not.toContain("hiddenWindowKeys");
          expect(
            useLayoutStore.getState().statusBar.rateLimits.providers,
          ).toEqual({
            codex: { automatic: false, limitKeys: ["codex:secondary"] },
          });
        });

        it("writes the migrated shape back without the old lists", async () => {
          await rehydrateFrom({
            statusBar: {
              rateLimits: {
                expandedProviders: ["codex"],
                hiddenWindowKeys: [],
              },
            },
          });
          // Any write forces the persist; the placement move is the cheapest
          // one, so it moves off the default rather than onto it.
          useLayoutStore.getState().setStatusBarPlacement("header");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          const persisted: unknown = JSON.parse(
            window.localStorage.getItem(PERSIST_KEY) ?? "{}",
          );
          expect(persisted).toEqual({
            state: {
              statusBar: {
                ...DEFAULT_STATUS_BAR_LAYOUT,
                placement: "header",
                rateLimits: {
                  ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
                  providers: {
                    codex: {
                      automatic: false,
                      limitKeys: ["codex:primary", "codex:secondary"],
                    },
                  },
                },
              },
              composer: DEFAULT_COMPOSER_LAYOUT,
            },
            version: CURRENT_PERSIST_VERSION,
          });
        });
      });
    });

    it("falls back to the default showModeWord when the persisted value isn't a boolean", async () => {
      await rehydrateFrom({
        statusBar: { rateLimits: { showModeWord: "no" } },
      });

      expect(useLayoutStore.getState().statusBar.rateLimits.showModeWord).toBe(
        true,
      );
    });

    it("returns a hidden provider to visible on the second toggle", () => {
      const { toggleStatusBarProvider } = useLayoutStore.getState();

      toggleStatusBarProvider("claude-code");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["claude-code"]);

      toggleStatusBarProvider("claude-code");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual([]);
    });

    it("returns an explicit pick to unchecked on the second toggle, keeping automatic on", () => {
      const { toggleStatusBarProviderLimit } = useLayoutStore.getState();

      toggleStatusBarProviderLimit("claude-code", "claude-code:model:Fable");
      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
        "claude-code": {
          automatic: true,
          limitKeys: ["claude-code:model:Fable"],
        },
      });

      toggleStatusBarProviderLimit("claude-code", "claude-code:model:Fable");
      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
        "claude-code": { automatic: true, limitKeys: [] },
      });
    });

    it("turns automatic off only once an explicit pick is checked, and back on regardless", () => {
      const store = useLayoutStore.getState();

      store.setStatusBarProviderAutomatic("codex", false);
      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual(
        {},
      );

      store.toggleStatusBarProviderLimit("codex", "codex:primary");
      store.setStatusBarProviderAutomatic("codex", false);
      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
        codex: { automatic: false, limitKeys: ["codex:primary"] },
      });

      store.setStatusBarProviderAutomatic("codex", true);
      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
        codex: { automatic: true, limitKeys: ["codex:primary"] },
      });
    });

    // The floor: a selection never reaches "nothing drawn" through the
    // setters, whichever order the two are flipped in.
    it("refuses to uncheck the last explicit pick while automatic is off", () => {
      const store = useLayoutStore.getState();
      store.toggleStatusBarProviderLimit("codex", "codex:primary");
      store.setStatusBarProviderAutomatic("codex", false);
      const before = useLayoutStore.getState().statusBar;

      store.toggleStatusBarProviderLimit("codex", "codex:primary");

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });

    it("leaves state untouched when setStatusBarProviderAutomatic is handed the value already held", () => {
      const before = useLayoutStore.getState().statusBar;

      useLayoutStore.getState().setStatusBarProviderAutomatic("codex", true);

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });

    it("keeps one provider's selection apart from another's", () => {
      const store = useLayoutStore.getState();

      store.toggleStatusBarProviderLimit("codex", "codex:primary");
      store.toggleStatusBarProviderLimit("grok", "grok:period");
      store.setStatusBarProviderAutomatic("grok", false);

      expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
        codex: { automatic: true, limitKeys: ["codex:primary"] },
        grok: { automatic: false, limitKeys: ["grok:period"] },
      });
    });

    it("never lists a provider twice however often it is toggled", () => {
      const { toggleStatusBarProvider } = useLayoutStore.getState();

      toggleStatusBarProvider("codex");
      toggleStatusBarProvider("claude-code");
      toggleStatusBarProvider("codex");
      toggleStatusBarProvider("codex");

      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["claude-code", "codex"]);
    });

    // The segment's reading order is the metric order, not the order the user
    // happened to switch things on in.
    it("holds metrics in display order regardless of toggle order", () => {
      const { toggleStatusBarResourceMetric } = useLayoutStore.getState();

      toggleStatusBarResourceMetric("cpu");
      toggleStatusBarResourceMetric("memory");
      toggleStatusBarResourceMetric("processes");
      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([]);

      toggleStatusBarResourceMetric("ramShare");
      toggleStatusBarResourceMetric("cpu");
      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
        "cpu",
        "ramShare",
      ]);
    });

    it("re-orders and dedupes a persisted metric list, dropping unknown names", async () => {
      await rehydrateFrom({
        statusBar: {
          resources: {
            metrics: ["ramShare", "cpu", "cpu", "gpu", "processes"],
          },
        },
      });

      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
        "cpu",
        "processes",
        "ramShare",
      ]);
    });

    // An empty selection is a real state (the segment shows nothing), unlike a
    // value that was never a list at all.
    it("keeps a persisted empty metric list instead of restoring the defaults", async () => {
      await rehydrateFrom({ statusBar: { resources: { metrics: [] } } });

      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([]);
    });

    it("stores the display toggles a rendered window reads", () => {
      const store = useLayoutStore.getState();

      store.setStatusBarPercentMode("remaining");
      store.setStatusBarShowTimer(false);
      store.setStatusBarShowBar(false);
      store.setStatusBarShowModeWord(false);
      store.setStatusBarRateLimitsEnabled(false);
      store.setStatusBarResourcesEnabled(false);
      store.setStatusBarResourceScope("desktop-app");

      const statusBar = useLayoutStore.getState().statusBar;
      expect(statusBar.rateLimits.percentMode).toBe("remaining");
      expect(statusBar.rateLimits.showTimer).toBe(false);
      expect(statusBar.rateLimits.showBar).toBe(false);
      expect(statusBar.rateLimits.showModeWord).toBe(false);
      expect(statusBar.rateLimits.enabled).toBe(false);
      expect(statusBar.resources.enabled).toBe(false);
      expect(statusBar.resources.scope).toBe("desktop-app");
    });

    it("leaves state untouched when a setter is handed the value already held", () => {
      const before = useLayoutStore.getState().statusBar;

      useLayoutStore.getState().setStatusBarPercentMode("used");

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });

    it("leaves state untouched when setStatusBarShowModeWord is handed the value already held", () => {
      const before = useLayoutStore.getState().statusBar;

      useLayoutStore.getState().setStatusBarShowModeWord(true);

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });
  });

  describe("composer slice", () => {
    it("starts with every element visible", () => {
      expect(useLayoutStore.getState().composer).toEqual(
        DEFAULT_COMPOSER_LAYOUT,
      );
    });

    it("writes one field per setter and leaves its neighbours alone", () => {
      const store = useLayoutStore.getState();

      store.setComposerFilesChanged("compact");
      store.setComposerActiveAgents("compact");
      store.setComposerBackground("compact");
      store.setComposerAttachImage("hidden");
      store.setComposerAccess("compact");
      store.setComposerMic("hidden");
      store.setComposerCompactButton("hidden");
      store.setComposerReasoningIndicator("bars");
      store.setComposerReasoningFooterControl("list");

      expect(useLayoutStore.getState().composer).toEqual({
        filesChanged: "compact",
        activeAgents: "compact",
        background: "compact",
        attachImage: "hidden",
        access: "compact",
        mic: "hidden",
        compactButton: "hidden",
        reasoningIndicator: "bars",
        reasoningFooterControl: "list",
      });
    });

    it("leaves state untouched when a setter is handed the value already held", () => {
      const before = useLayoutStore.getState().composer;

      useLayoutStore.getState().setComposerFilesChanged("visible");
      useLayoutStore.getState().setComposerMic("visible");

      expect(useLayoutStore.getState().composer).toBe(before);
    });

    it("rehydrates a fully valid slice verbatim", async () => {
      await rehydrateFrom({
        composer: {
          filesChanged: "compact",
          activeAgents: "compact",
          background: "compact",
          attachImage: "hidden",
          access: "compact",
          mic: "hidden",
          compactButton: "hidden",
          reasoningIndicator: "bars-text",
          reasoningFooterControl: "list",
        },
      });

      expect(useLayoutStore.getState().composer).toEqual({
        filesChanged: "compact",
        activeAgents: "compact",
        background: "compact",
        attachImage: "hidden",
        access: "compact",
        mic: "hidden",
        compactButton: "hidden",
        reasoningIndicator: "bars-text",
        reasoningFooterControl: "list",
      });
    });

    it.each([
      ["the record is not an object", "layout"],
      ["the slice is missing", {}],
      ["the slice is not an object", { composer: 3 }],
    ])(
      "falls back to the whole default slice when %s",
      async (_label, state) => {
        await rehydrateFrom(state);

        expect(useLayoutStore.getState().composer).toEqual(
          DEFAULT_COMPOSER_LAYOUT,
        );
      },
    );

    it("falls back per field on a garbage value, without touching its neighbours", async () => {
      await rehydrateFrom({
        composer: {
          filesChanged: "sideways",
          activeAgents: "compact",
          background: 7,
          attachImage: "hidden",
          access: null,
          mic: "loud",
          compactButton: "hidden",
          reasoningIndicator: "dots",
          reasoningFooterControl: "knob",
        },
      });

      expect(useLayoutStore.getState().composer).toEqual({
        filesChanged: "visible",
        activeAgents: "compact",
        background: "visible",
        attachImage: "hidden",
        access: "visible",
        mic: "visible",
        compactButton: "hidden",
        reasoningIndicator: "text",
        reasoningFooterControl: "slider",
      });
    });

    it.each(["text", "bars", "bars-text"] as const)(
      "round-trips reasoningIndicator %s through the persisted slice",
      async (indicator) => {
        useLayoutStore.getState().setComposerReasoningIndicator(indicator);
        expect(useLayoutStore.getState().composer.reasoningIndicator).toBe(
          indicator,
        );

        await rehydrateFrom({ composer: { reasoningIndicator: indicator } });

        expect(useLayoutStore.getState().composer).toEqual({
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningIndicator: indicator,
        });
      },
    );

    // The picker footer's own control, which is the one composer field whose
    // default is NOT what the app rendered before it existed.
    it("starts the picker footer on the slider", () => {
      expect(useLayoutStore.getState().composer.reasoningFooterControl).toBe(
        "slider",
      );
      expect(DEFAULT_COMPOSER_LAYOUT.reasoningFooterControl).toBe("slider");
    });

    it.each(["slider", "list"] as const)(
      "round-trips reasoningFooterControl %s through the persisted slice",
      async (control) => {
        useLayoutStore.getState().setComposerReasoningFooterControl(control);
        expect(useLayoutStore.getState().composer.reasoningFooterControl).toBe(
          control,
        );

        await rehydrateFrom({ composer: { reasoningFooterControl: control } });

        expect(useLayoutStore.getState().composer).toEqual({
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: control,
        });
      },
    );

    it.each(["knob", "bars", "visible", 3, null])(
      "falls back to the slider for a persisted reasoningFooterControl of %s",
      async (control) => {
        await rehydrateFrom({ composer: { reasoningFooterControl: control } });

        expect(useLayoutStore.getState().composer.reasoningFooterControl).toBe(
          "slider",
        );
      },
    );

    // The names of the chip's other unions are not levels of this one: a
    // persisted `"visible"` or `"hidden"` here would reach a three-way switch
    // on the chip with no branch for it.
    it("rejects a mode from the visibility unions as a reasoning indicator", async () => {
      await rehydrateFrom({ composer: { reasoningIndicator: "hidden" } });

      expect(useLayoutStore.getState().composer.reasoningIndicator).toBe(
        "text",
      );
    });

    // The two unions are not interchangeable. `filesChanged` only ever
    // compacts (never `hidden` - its row carries verbs with no other home),
    // and `mic` only ever hides (never `compact` - it has no smaller shape).
    // A value that is valid for the OTHER union must not sneak through as if
    // it were valid for this field's own union.
    it("rejects a value from the other union instead of accepting it across fields", async () => {
      await rehydrateFrom({
        composer: {
          filesChanged: "hidden",
          mic: "compact",
        },
      });

      const composer = useLayoutStore.getState().composer;
      expect(composer.filesChanged).toBe("visible");
      expect(composer.mic).toBe("visible");
    });

    it("keeps a corrupt composer slice from disturbing a valid status bar slice", async () => {
      await rehydrateFrom({
        statusBar: { placement: "status-bar" },
        composer: "not an object",
      });

      expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
      expect(useLayoutStore.getState().composer).toEqual(
        DEFAULT_COMPOSER_LAYOUT,
      );
    });

    it("keeps a corrupt status bar slice from disturbing a valid composer slice", async () => {
      await rehydrateFrom({
        statusBar: "not an object",
        composer: { filesChanged: "compact" },
      });

      expect(useLayoutStore.getState().statusBar).toEqual(
        DEFAULT_STATUS_BAR_LAYOUT,
      );
      expect(useLayoutStore.getState().composer).toEqual({
        ...DEFAULT_COMPOSER_LAYOUT,
        filesChanged: "compact",
      });
    });
  });

  // The `home` slice carried one setting - Home's row density - and that
  // setting is gone (the two spacings were barely distinguishable, user ruling
  // 2026-09-12), so the slice went with it rather than staying behind as an
  // empty object nothing reads.
  describe("the removed home slice", () => {
    it("holds no home slice at all", () => {
      expect(useLayoutStore.getState()).not.toHaveProperty("home");
      expect(useLayoutStore.getState()).not.toHaveProperty("setHomeDensity");
    });

    // Read past rather than migrated: one spacing means there is nothing for
    // the old value to select, and a resolver naming the key to delete it
    // would keep a slice alive that nothing in the app can still mean.
    it("ignores a persisted home slice and drops it on the next write", async () => {
      await rehydrateFrom({
        home: { density: "compact", view: "tasks" },
        composer: { filesChanged: "compact" },
      });

      expect(useLayoutStore.getState()).not.toHaveProperty("home");
      // The rest of the blob still resolves - the dead key reaches no
      // resolver, so it cannot take a live slice down with it.
      expect(useLayoutStore.getState().composer.filesChanged).toBe("compact");

      useLayoutStore.getState().setComposerFilesChanged("visible");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const persisted: unknown = JSON.parse(
        window.localStorage.getItem(PERSIST_KEY) ?? "{}",
      );
      expect(persisted).toEqual({
        state: {
          statusBar: DEFAULT_STATUS_BAR_LAYOUT,
          composer: DEFAULT_COMPOSER_LAYOUT,
        },
        version: CURRENT_PERSIST_VERSION,
      });
      expect(JSON.stringify(persisted)).not.toContain("density");
    });
  });
});
