import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  SurfaceDemandContext,
  useSurfaceDemand,
  type ActiveSurfaceDemand,
} from "@/stores/tabs/surface-demand";

describe("useSurfaceDemand", () => {
  function demandFor(input: {
    readonly demand: ActiveSurfaceDemand | undefined;
    readonly paneVisible: boolean;
    readonly tabSelected: boolean;
  }) {
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => {
      const tree = createElement(
        PaneVisibilityContext.Provider,
        { value: input.paneVisible },
        createElement(
          TabBodySelectedContext.Provider,
          { value: input.tabSelected },
          props.children,
        ),
      );
      return input.demand === undefined
        ? tree
        : createElement(
            SurfaceDemandContext.Provider,
            { value: input.demand },
            tree,
          );
    };
    return renderHook(() => useSurfaceDemand(), { wrapper }).result.current;
  }

  it("reports the provided demand only while the surface is both pane-visible and its tab body is selected", () => {
    for (const demand of ["preview", "settled"] as const) {
      expect(demandFor({ demand, paneVisible: true, tabSelected: true })).toBe(
        demand,
      );
      expect(
        demandFor({ demand, paneVisible: false, tabSelected: true }),
      ).toBeNull();
      expect(
        demandFor({ demand, paneVisible: true, tabSelected: false }),
      ).toBeNull();
    }
  });

  it("with no provider, a visible surface is settled: ordinary mounts never wait on a preview", () => {
    expect(
      demandFor({ demand: undefined, paneVisible: true, tabSelected: true }),
    ).toBe("settled");
  });
});
