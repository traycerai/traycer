import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  HostSwitcher,
  type HostSwitcherSurface,
} from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

/**
 * The status bar needed a picker in a 24px strip and a third ending for its
 * list ("Activate this host"), and both had to be ADDITIVE: the four surfaces
 * that existed before must render byte-identically, or a preset that was only
 * meant to be added has quietly restyled Settings' sidebar and two popovers.
 *
 * The trigger and its label are asserted as exact class strings rather than by
 * `toContain`, because the change that would break this is a REORDERING or a
 * silent `tailwind-merge` displacement - both of which every containment check
 * passes. `HOST_SWITCHER_SURFACES` grew a `label` field in the same pass, and
 * the label span's classes moved from an inline ternary into it; these strings
 * are what proves that move produced the same markup rather than merely the
 * same intent.
 */

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(cleanup);

const SELECTED_HOST = hostScopeOptionFixture({
  hostId: "host-a",
  name: "Host A",
});

const TRIGGER_BASE =
  "group/host-switcher flex items-center text-start transition-colors " +
  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:pointer-events-none disabled:opacity-60 " +
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent";
/** The roomy presets keep the base's own width and padding. */
const PADDED_TRIGGER_BASE = TRIGGER_BASE.replace(
  "flex items-center",
  "flex w-full items-center gap-3 px-3 py-2",
);
const LABEL_BASE = "min-w-0 flex-1 truncate";
const LABEL_TAIL = "group-hover/host-switcher:text-foreground";

interface SurfaceMarkup {
  readonly surface: HostSwitcherSurface;
  readonly trigger: string;
  readonly label: string;
}

const EXISTING_SURFACES: ReadonlyArray<SurfaceMarkup> = [
  {
    surface: "rail",
    trigger: `${PADDED_TRIGGER_BASE} rounded-md bg-foreground/5 hover:bg-foreground/7`,
    label: `${LABEL_BASE} text-ui-sm font-medium text-foreground ${LABEL_TAIL}`,
  },
  {
    surface: "panel-header",
    trigger: `${PADDED_TRIGGER_BASE} hover:bg-foreground/5`,
    label: `${LABEL_BASE} text-ui-sm font-medium text-foreground ${LABEL_TAIL}`,
  },
  {
    surface: "field",
    trigger: `${PADDED_TRIGGER_BASE} rounded-lg border border-input/40 bg-input/25 hover:bg-input/40 dark:hover:bg-input/40`,
    label: `${LABEL_BASE} text-ui-sm font-medium text-foreground ${LABEL_TAIL}`,
  },
  {
    surface: "inline",
    trigger: `${TRIGGER_BASE} h-7 w-fit max-w-full gap-1.5 rounded-lg px-1.5 py-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground`,
    label: `${LABEL_BASE} text-ui-sm font-medium text-muted-foreground ${LABEL_TAIL}`,
  },
];

function renderSwitcher(props: {
  readonly surface: HostSwitcherSurface;
  readonly actionKind?: "manage-hosts" | "activate-host";
  readonly actionDisabled?: boolean;
  readonly onAction?: () => void;
  readonly hosts?: ReadonlyArray<typeof SELECTED_HOST>;
  readonly listsFailed?: boolean;
}): void {
  const hosts = props.hosts ?? [SELECTED_HOST];
  render(
    <HostSwitcher
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      hosts={hosts}
      selected={hosts.length === 0 ? null : SELECTED_HOST}
      activeHostId="host-a"
      onSelect={() => undefined}
      action={{
        kind: props.actionKind ?? "manage-hosts",
        disabled: props.actionDisabled ?? false,
        onSelect: props.onAction ?? (() => undefined),
      }}
      surface={props.surface}
      intent="view"
      disabled={false}
      isLoading={false}
      listsFailed={props.listsFailed ?? false}
      onRetryLists={() => undefined}
      updateViewForHost={null}
    />,
  );
}

function openList(): void {
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
}

describe("<HostSwitcher /> surface presets are additive", () => {
  for (const expected of EXISTING_SURFACES) {
    it(`leaves the ${expected.surface} trigger markup unchanged`, () => {
      renderSwitcher({ surface: expected.surface });

      const trigger = screen.getByTestId("settings-host-switcher");
      expect(trigger.className).toBe(expected.trigger);
      const label = trigger.firstElementChild;
      expect(label).not.toBeNull();
      expect(label?.className).toBe(expected.label);
    });
  }

  it("still mutes the name of an unresolved selection on a padded surface", () => {
    // The one case the label preset does NOT cover: `selected === null` still
    // overrides the preset's colour at the call site, and `tailwind-merge` has
    // to displace the preset's `text-foreground` rather than emit both.
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[SELECTED_HOST]}
        selected={null}
        activeHostId="host-a"
        onSelect={() => undefined}
        action={{
          kind: "manage-hosts",
          disabled: false,
          onSelect: () => undefined,
        }}
        surface="rail"
        intent="view"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
      />,
    );

    const label = screen.getByTestId(
      "settings-host-switcher",
    ).firstElementChild;
    expect(label?.className).toBe(
      `${LABEL_BASE} text-ui-sm font-medium text-muted-foreground ${LABEL_TAIL}`,
    );
  });

  it("keeps a disabled:false action row exactly as it was", () => {
    // `disabled` became a REQUIRED field on `HostSwitcherAction`. cmdk already
    // published `aria-disabled` / `data-disabled` from `Boolean(disabled)`, so
    // passing `false` explicitly must render what passing nothing rendered.
    renderSwitcher({ surface: "panel-header" });
    openList();

    const row = screen.getByTestId("settings-host-switcher-manage");
    expect(row.getAttribute("aria-disabled")).toBe("false");
    expect(row.getAttribute("data-disabled")).toBe("false");
  });
});

describe("<HostSwitcher /> status-bar surface", () => {
  it("fits the strip's row height and drops the padded chrome", () => {
    renderSwitcher({ surface: "status-bar" });

    const trigger = screen.getByTestId("settings-host-switcher");
    expect(trigger.className).toBe(
      `${TRIGGER_BASE} h-6 w-fit max-w-full gap-1.5 rounded-none px-2 py-0 text-ui-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground`,
    );
    expect(trigger.firstElementChild?.className).toBe(
      `${LABEL_BASE} text-ui-xs font-medium text-muted-foreground ${LABEL_TAIL}`,
    );
  });

  it("opens its list upward, since nothing sits below the strip", () => {
    renderSwitcher({ surface: "status-bar" });
    openList();

    expect(
      screen
        .getByTestId("settings-host-switcher-list")
        .getAttribute("data-side"),
    ).toBe("top");
  });

  it("keeps opening downward on every other surface", () => {
    renderSwitcher({ surface: "rail" });
    openList();

    expect(
      screen
        .getByTestId("settings-host-switcher-list")
        .getAttribute("data-side"),
    ).toBe("bottom");
  });

  it("collapses the zero-host notice to one row instead of stacking it", () => {
    // The stacked `px-3 py-2` two-line form is taller than the strip it would
    // be rendered into, so the same words and the same action lay out in a
    // single 24px line here.
    renderSwitcher({ surface: "status-bar", hosts: [] });

    const notice = screen.getByTestId("settings-host-switcher-empty");
    expect(notice.className).toContain("h-6");
    expect(notice.className).toContain("items-center");
    expect(notice.className).not.toContain("flex-col");
    expect(notice.className).not.toContain("py-2");
  });

  it("collapses the failed-list notice too, and keeps its retry", () => {
    renderSwitcher({ surface: "status-bar", hosts: [], listsFailed: true });

    const notice = screen.getByTestId("settings-host-switcher-lists-failed");
    expect(notice.className).toContain("h-6");
    expect(notice.className).not.toContain("flex-col");
    expect(
      screen.getByTestId("settings-host-switcher-retry-lists"),
    ).not.toBeNull();
  });

  it("keeps the stacked notice on a roomy surface", () => {
    renderSwitcher({ surface: "rail", hosts: [] });

    const notice = screen.getByTestId("settings-host-switcher-empty");
    expect(notice.className).toBe("flex w-full flex-col gap-2 px-3 py-2");
  });
});

describe("<HostSwitcher /> activate-host ending", () => {
  it("ends the list in Activate this host and calls back", () => {
    const onAction = vi.fn();
    renderSwitcher({
      surface: "status-bar",
      actionKind: "activate-host",
      onAction,
    });
    openList();

    expect(screen.getByText("Activate this host")).not.toBeNull();
    // The other two endings belong to surfaces that own a different
    // consequence; only one row is ever offered.
    expect(screen.queryByTestId("settings-host-switcher-manage")).toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-add")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-host-switcher-activate"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("goes inert while an activation is already in flight", () => {
    // `makeActive` validates, persists, re-derives and fires the app's only
    // `HostSelected` event, so a second click issues two of each. Its own latch
    // is silent; this is the half the user can see.
    const onAction = vi.fn();
    renderSwitcher({
      surface: "status-bar",
      actionKind: "activate-host",
      actionDisabled: true,
      onAction,
    });
    openList();

    const row = screen.getByTestId("settings-host-switcher-activate");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-disabled")).toBe("true");

    fireEvent.click(row);
    expect(onAction).not.toHaveBeenCalled();
  });
});
