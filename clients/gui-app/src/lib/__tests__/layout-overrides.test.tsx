import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useComposerLayout,
  useComposerLayoutValue,
  useLayoutSetting,
  useStatusBarLayout,
  useStatusBarRateLimitValue,
  useStatusBarResourceValue,
  type LayoutOverride,
} from "@/lib/layout-overrides";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_MINIMAP_SIDE,
  useSettingsStore,
} from "@/stores/settings/settings-store";

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({ chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

/** Renders `read()` in a probe and hands back whatever it returned. */
function readUnder<Value>(
  read: () => Value,
  wrap: (children: ReactNode) => ReactNode,
): Value {
  // A list rather than a `let … | null`: assigning inside the probe is
  // invisible to control-flow narrowing, so the null check afterwards reads as
  // a comparison against a literal `null` type.
  const seen: Value[] = [];
  function Probe(): null {
    seen.push(read());
    return null;
  }
  render(<>{wrap(<Probe />)}</>);
  const value = seen.at(-1);
  if (value === undefined) throw new Error("the probe did not render");
  return value;
}

const bare = (children: ReactNode): ReactNode => children;

function under(value: LayoutOverride) {
  return (children: ReactNode): ReactNode => (
    <LayoutOverrideProvider value={value}>{children}</LayoutOverrideProvider>
  );
}

describe("layout override seam", () => {
  describe("with no provider mounted", () => {
    it("returns the store's own slice object, not a copy", () => {
      // Referential identity is the point: a copy per render would make every
      // consumer of these hooks re-render on every parent render, and the app
      // renders them in the composer and the strip.
      expect(readUnder(useComposerLayout, bare)).toBe(
        useLayoutStore.getState().composer,
      );
      expect(readUnder(useStatusBarLayout, bare)).toBe(
        useLayoutStore.getState().statusBar,
      );
    });

    it("returns the stored value for a settings key", () => {
      useSettingsStore.setState({ chatTurnMinimapSide: "left" });

      expect(
        readUnder(() => useLayoutSetting("chatTurnMinimapSide"), bare),
      ).toBe("left");
    });
  });

  it("draws the override while the store says otherwise", () => {
    expect(useLayoutStore.getState().composer.mic).toBe("visible");

    expect(
      readUnder(useComposerLayout, under({ composer: { mic: "hidden" } })).mic,
    ).toBe("hidden");
    // The store is untouched: an override is a drawing, never a write.
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
  });

  it("leaves every unstated leaf on the stored value", () => {
    useLayoutStore.getState().setComposerAccess("compact");

    const composer = readUnder(
      useComposerLayout,
      under({ composer: { mic: "hidden" } }),
    );

    expect(composer.mic).toBe("hidden");
    expect(composer.access).toBe("compact");
  });

  it("keeps the outer override when an inner one names a different leaf", () => {
    const composer = readUnder(useComposerLayout, (children) => (
      <LayoutOverrideProvider value={{ composer: { mic: "hidden" } }}>
        <LayoutOverrideProvider value={{ composer: { attachImage: "hidden" } }}>
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    expect(composer.mic).toBe("hidden");
    expect(composer.attachImage).toBe("hidden");
  });

  it("lets the inner override win on the leaf both name", () => {
    const composer = readUnder(useComposerLayout, (children) => (
      <LayoutOverrideProvider value={{ composer: { mic: "hidden" } }}>
        <LayoutOverrideProvider value={{ composer: { mic: "visible" } }}>
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    expect(composer.mic).toBe("visible");
  });

  it("merges the status bar's nested groups leaf by leaf", () => {
    const statusBar = readUnder(useStatusBarLayout, (children) => (
      <LayoutOverrideProvider
        value={{ statusBar: { rateLimits: { showBar: false } } }}
      >
        <LayoutOverrideProvider
          value={{ statusBar: { rateLimits: { showTimer: false } } }}
        >
          {children}
        </LayoutOverrideProvider>
      </LayoutOverrideProvider>
    ));

    // Both overrides survive, and the group's other leaves stay stored.
    expect(statusBar.rateLimits.showBar).toBe(false);
    expect(statusBar.rateLimits.showTimer).toBe(false);
    expect(statusBar.rateLimits.percentMode).toBe(
      DEFAULT_STATUS_BAR_LAYOUT.rateLimits.percentMode,
    );
    expect(statusBar.resources).toBe(DEFAULT_STATUS_BAR_LAYOUT.resources);
  });

  describe("leaf hooks subscribe to one field", () => {
    it("does not rerender when a sibling composer key changes", () => {
      // The regression this pins: routing one-field readers through the slice
      // hook made the mic button rerender whenever `access` changed - an
      // element on screen all day, rerendering on a preference about a
      // different element.
      let renders = 0;
      function MicProbe(): null {
        useComposerLayoutValue("mic");
        renders += 1;
        return null;
      }
      render(<MicProbe />);
      const before = renders;

      act(() => {
        useLayoutStore.getState().setComposerAccess("compact");
      });

      expect(renders).toBe(before);

      // …and it still rerenders for its OWN key, or the hook would be useless.
      act(() => {
        useLayoutStore.getState().setComposerMic("hidden");
      });
      expect(renders).toBeGreaterThan(before);
    });

    it("does not rerender a usage reading when the resource scope changes", () => {
      let renders = 0;
      function TimerProbe(): null {
        useStatusBarRateLimitValue("showTimer");
        renders += 1;
        return null;
      }
      render(<TimerProbe />);
      const before = renders;

      act(() => {
        useLayoutStore.getState().setStatusBarResourceScope("desktop-app");
      });

      expect(renders).toBe(before);
    });

    it("applies an override to the one field it names", () => {
      expect(
        readUnder(
          () => useComposerLayoutValue("mic"),
          under({ composer: { mic: "hidden" } }),
        ),
      ).toBe("hidden");
      expect(
        readUnder(
          () => useComposerLayoutValue("access"),
          under({ composer: { mic: "hidden" } }),
        ),
      ).toBe(useLayoutStore.getState().composer.access);
      expect(
        readUnder(
          () => useStatusBarResourceValue("scope"),
          under({ statusBar: { resources: { scope: "desktop-app" } } }),
        ),
      ).toBe("desktop-app");
    });
  });

  describe("nested maps merge per key", () => {
    it("keeps an outer provider selection when an inner one names another", () => {
      const statusBar = readUnder(useStatusBarLayout, (children) => (
        <LayoutOverrideProvider
          value={{
            statusBar: {
              rateLimits: {
                providers: { codex: { automatic: false, limitKeys: ["a"] } },
              },
            },
          }}
        >
          <LayoutOverrideProvider
            value={{
              statusBar: {
                rateLimits: {
                  providers: {
                    "claude-code": { automatic: false, limitKeys: ["b"] },
                  },
                },
              },
            }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ));

      expect(statusBar.rateLimits.providers.codex?.limitKeys).toEqual(["a"]);
      expect(statusBar.rateLimits.providers["claude-code"]?.limitKeys).toEqual([
        "b",
      ]);
    });

    it("keeps a provider's other leaf when an inner override names one", () => {
      // A popover about WHICH windows a provider draws says nothing about
      // whether it picks them automatically. Replacing the selection whole
      // would switch `automatic` back on behind the user's back.
      const statusBar = readUnder(useStatusBarLayout, (children) => (
        <LayoutOverrideProvider
          value={{
            statusBar: {
              rateLimits: {
                providers: { codex: { automatic: false, limitKeys: ["a"] } },
              },
            },
          }}
        >
          <LayoutOverrideProvider
            value={{
              statusBar: {
                rateLimits: { providers: { codex: { limitKeys: ["b"] } } },
              },
            }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ));

      expect(statusBar.rateLimits.providers.codex).toEqual({
        automatic: false,
        limitKeys: ["b"],
      });
    });

    it("merges checked accounts per host AND per provider", () => {
      // Two levels, because the value under a host id is itself a map: a
      // one-level merge would drop the outer provider on the same machine.
      const statusBar = readUnder(useStatusBarLayout, (children) => (
        <LayoutOverrideProvider
          value={{
            statusBar: {
              rateLimits: { shownProfiles: { "host-a": { codex: ["work"] } } },
            },
          }}
        >
          <LayoutOverrideProvider
            value={{
              statusBar: {
                rateLimits: {
                  shownProfiles: { "host-a": { "claude-code": [null] } },
                },
              },
            }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ));

      expect(statusBar.rateLimits.shownProfiles["host-a"]?.codex).toEqual([
        "work",
      ]);
      expect(
        statusBar.rateLimits.shownProfiles["host-a"]?.["claude-code"],
      ).toEqual([null]);
    });

    it("keeps an outer toolbar cluster when an inner one names the other", () => {
      const composer = readUnder(useComposerLayout, (children) => (
        <LayoutOverrideProvider
          value={{ composer: { toolbar: { left: ["access"] } } }}
        >
          <LayoutOverrideProvider
            value={{ composer: { toolbar: { right: ["model"] } } }}
          >
            {children}
          </LayoutOverrideProvider>
        </LayoutOverrideProvider>
      ));

      expect(composer.toolbar.left).toEqual(["access"]);
      expect(composer.toolbar.right).toEqual(["model"]);
    });

    it("merges an override's providers onto the stored map, not over it", () => {
      act(() => {
        useLayoutStore.getState().setStatusBarProviderAutomatic("codex", false);
      });
      // Refused as undrawable, so seed the stored map through the toggle the
      // store does accept.
      act(() => {
        useLayoutStore
          .getState()
          .toggleStatusBarProviderLimit("codex", "codex:primary");
      });
      expect(
        useLayoutStore.getState().statusBar.rateLimits.providers.codex,
      ).toBeDefined();

      const statusBar = readUnder(
        useStatusBarLayout,
        under({
          statusBar: {
            rateLimits: {
              providers: {
                "claude-code": { automatic: false, limitKeys: ["b"] },
              },
            },
          },
        }),
      );

      // The stored provider survives an override about a different one.
      expect(statusBar.rateLimits.providers.codex?.limitKeys).toEqual([
        "codex:primary",
      ]);
      expect(statusBar.rateLimits.providers["claude-code"]?.limitKeys).toEqual([
        "b",
      ]);
    });

    it("keeps a STORED provider leaf the override does not name", () => {
      // The same rule one level down: the override reaches the stored map, so
      // `automatic: false` set in Settings has to survive an override that
      // only names the windows.
      // The window first, then the switch: a selection with `automatic` off
      // and no windows draws nothing, and the store refuses that order.
      act(() => {
        useLayoutStore
          .getState()
          .toggleStatusBarProviderLimit("codex", "codex:primary");
      });
      act(() => {
        useLayoutStore.getState().setStatusBarProviderAutomatic("codex", false);
      });
      expect(
        useLayoutStore.getState().statusBar.rateLimits.providers.codex
          ?.automatic,
      ).toBe(false);

      const statusBar = readUnder(
        useStatusBarLayout,
        under({
          statusBar: {
            rateLimits: { providers: { codex: { limitKeys: ["weekly"] } } },
          },
        }),
      );

      expect(statusBar.rateLimits.providers.codex).toEqual({
        automatic: false,
        limitKeys: ["weekly"],
      });
    });

    it("replaces an array rather than concatenating it", () => {
      // A metric list means "exactly these", so merging two would produce a
      // selection neither override asked for.
      const statusBar = readUnder(
        useStatusBarLayout,
        under({ statusBar: { resources: { metrics: ["memory"] } } }),
      );

      expect(statusBar.resources.metrics).toEqual(["memory"]);
    });
  });

  it("overrides a settings key without touching its neighbours", () => {
    useSettingsStore.setState({ chatTurnMinimapSide: "left" });

    expect(
      readUnder(
        () => useLayoutSetting("chatTurnMinimapSide"),
        under({ settings: { chatTurnMinimapSide: "hide" } }),
      ),
    ).toBe("hide");
    expect(
      readUnder(
        () => useLayoutSetting("homeTabEnabled"),
        under({ settings: { chatTurnMinimapSide: "hide" } }),
      ),
    ).toBe(useSettingsStore.getState().homeTabEnabled);
  });
});
