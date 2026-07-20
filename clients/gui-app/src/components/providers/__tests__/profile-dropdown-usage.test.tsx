import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileDropdownUsageEntry,
  ProfileDropdownUsagePresentation,
} from "../profile-dropdown-usage";

vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  const DropdownMenu = (props: {
    readonly children: ReactNode;
    readonly onOpenChange: ((open: boolean) => void) | undefined;
  }): ReactNode => {
    const initialOpenChange = React.useRef(props.onOpenChange);
    React.useEffect(() => initialOpenChange.current?.(true), []);
    return <div>{props.children}</div>;
  };
  const DropdownMenuItem = React.forwardRef<
    HTMLButtonElement,
    {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly onFocus:
        ((event: React.FocusEvent<HTMLButtonElement>) => void) | undefined;
      readonly onPointerMove:
        ((event: React.PointerEvent<HTMLButtonElement>) => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-keyshortcuts": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly title: string | undefined;
    }
  >((props, ref) => (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      aria-label={props["aria-label"]}
      aria-keyshortcuts={props["aria-keyshortcuts"]}
      aria-current={props["aria-current"]}
      className={props.className}
      disabled={props.disabled}
      title={props.title}
      onFocus={props.onFocus}
      onPointerMove={props.onPointerMove}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ));
  DropdownMenuItem.displayName = "DropdownMenuItem";
  return {
    DropdownMenu,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly onKeyDown:
        ((event: React.KeyboardEvent<HTMLDivElement>) => void) | undefined;
    }): ReactNode => (
      <div
        role="menu"
        tabIndex={-1}
        data-testid="profile-menu"
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    ),
    DropdownMenuItem,
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

import { ProfileDropdown } from "../profile-dropdown";

const NOW = Date.now();

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  label: string,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const AMBIENT = profile("ambient", "ambient", "Terminal account");
const WORK = profile("work", "managed", "Work profile with a very long label");

function detailEntry(
  profileId: string | null,
  refresh: () => Promise<void>,
): ProfileDropdownUsageEntry {
  return {
    profileId,
    refreshStatus: "idle",
    refresh,
    ensureFresh: () => Promise.resolve(),
    projection: {
      kind: "detail",
      severity: "running_low",
      checkedAt: NOW,
      unavailableReason: null,
      compactWindow: {
        id: "primary",
        role: "primary",
        name: null,
        severity: "running_low",
        window: {
          usedPercent: 84,
          resetsAt: NOW + 60 * 60 * 1_000,
          durationMinutes: 300,
        },
      },
      windows: [
        {
          id: "primary",
          role: "primary",
          name: null,
          severity: "running_low",
          window: {
            usedPercent: 84,
            resetsAt: NOW + 60 * 60 * 1_000,
            durationMinutes: 300,
          },
        },
        {
          id: "secondary",
          role: "secondary",
          name: null,
          severity: "healthy",
          window: {
            usedPercent: 46,
            resetsAt: NOW + 3 * 24 * 60 * 60 * 1_000,
            durationMinutes: 10_080,
          },
        },
        {
          id: "extra:fable",
          role: "extra",
          name: "Fable",
          severity: "limited",
          window: {
            usedPercent: 100,
            resetsAt: NOW + 30 * 60 * 1_000,
            durationMinutes: 300,
          },
        },
      ],
    },
  };
}

function semanticEntry(
  refresh: () => Promise<void>,
): ProfileDropdownUsageEntry {
  return {
    profileId: null,
    refreshStatus: "idle",
    refresh,
    ensureFresh: () => Promise.resolve(),
    projection: {
      kind: "semantic_only",
      severity: "limited",
      compactWindow: null,
      windows: [],
      checkedAt: NOW,
      unavailableReason: null,
    },
  };
}

function renderDropdown(
  usagePresentation: ProfileDropdownUsagePresentation | null,
  onSelectProfile: (profileId: string | null) => void,
) {
  return render(
    <ProfileDropdown
      providerLabel="Codex"
      profiles={[AMBIENT, WORK]}
      activeProfileId="work"
      onSelectProfile={onSelectProfile}
      onCreateProfile={vi.fn()}
      createProfileDisabled={false}
      createProfileDisabledReason={undefined}
      shortcutHintForIndex={(index) => ({
        digit: String(index + 1),
        label: `Hint ${index + 1}`,
      })}
      contentContainer={null}
      onCloseAutoFocus={null}
      usagePresentation={usagePresentation}
    />,
  );
}

describe("ProfileDropdown picker usage opt-in", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this.hasAttribute("data-profile-usage-sidecar")) {
          return new DOMRect(0, 0, 300, 240);
        }
        if (this.getAttribute("role") === "menuitem") {
          const top = this.getAttribute("aria-current") === "true" ? 160 : 120;
          return new DOMRect(120, top, 240, 32);
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("keeps Settings/default rows identity-only with no bars or sidecar", async () => {
    renderDropdown(null, vi.fn());
    await screen.findByRole("menuitem", { name: "Terminal account, Terminal" });
    expect(screen.queryByTestId("profile-usage-bar-null")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("renders concise accessible rows, compact bars, and the selected profile sidecar", async () => {
    const usagePresentation = {
      isHostReady: true,
      entries: new Map([
        [null, semanticEntry(vi.fn(() => Promise.resolve()))],
        [
          "work",
          detailEntry(
            "work",
            vi.fn(() => Promise.resolve()),
          ),
        ],
      ]),
    } satisfies ProfileDropdownUsagePresentation;
    renderDropdown(usagePresentation, vi.fn());

    const selected = await screen.findByRole("menuitem", {
      name: "Work profile with a very long label, Signed in, Selected, Running low",
    });
    expect(selected.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(screen.getByTestId("profile-usage-bar-work").textContent).toBe("");
    expect(
      screen
        .getByTestId("profile-usage-bar-work")
        .firstElementChild?.getAttribute("style"),
    ).toContain("84%");
    expect(screen.getByTestId("profile-usage-bar-null").children.length).toBe(
      0,
    );

    const sidecar = await screen.findByRole("complementary", {
      name: "Usage details for Work profile with a very long label",
    });
    await waitFor(() => expect(sidecar.dataset.visible).toBe("true"));
    expect(sidecar.dataset.side).toBe("right");
    expect(sidecar.textContent).toContain("Current session");
    expect(sidecar.textContent).toContain("Weekly");
    expect(sidecar.textContent).toContain("Fable · Current session");
  });

  it("follows pointer and keyboard preview without selecting", async () => {
    const onSelect = vi.fn();
    const usagePresentation = {
      isHostReady: true,
      entries: new Map([
        [null, semanticEntry(vi.fn(() => Promise.resolve()))],
        [
          "work",
          detailEntry(
            "work",
            vi.fn(() => Promise.resolve()),
          ),
        ],
      ]),
    } satisfies ProfileDropdownUsagePresentation;
    renderDropdown(usagePresentation, onSelect);
    const ambient = await screen.findByRole("menuitem", {
      name: "Terminal account, Terminal, Signed in, Not selected, Limited",
    });

    fireEvent.pointerMove(ambient);
    expect(
      await screen.findByRole("complementary", {
        name: "Usage details for Terminal account",
      }),
    ).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();

    const work = screen.getByRole("menuitem", {
      name: "Work profile with a very long label, Signed in, Selected, Running low",
    });
    fireEvent.focus(work);
    expect(
      await screen.findByRole("complementary", {
        name: "Usage details for Work profile with a very long label",
      }),
    ).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("refreshes exactly the previewed profile by pointer or R without selecting", async () => {
    const onSelect = vi.fn();
    const refreshAmbient = vi.fn(() => Promise.resolve());
    const refreshWork = vi.fn(() => Promise.resolve());
    const usagePresentation = {
      isHostReady: true,
      entries: new Map([
        [null, semanticEntry(refreshAmbient)],
        ["work", detailEntry("work", refreshWork)],
      ]),
    } satisfies ProfileDropdownUsagePresentation;
    renderDropdown(usagePresentation, onSelect);
    await screen.findByRole("complementary", {
      name: "Usage details for Work profile with a very long label",
    });

    fireEvent.keyDown(screen.getByTestId("profile-menu"), { key: "r" });
    expect(refreshWork).toHaveBeenCalledTimes(1);
    expect(refreshAmbient).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    const ambient = screen.getByRole("menuitem", {
      name: "Terminal account, Terminal, Signed in, Not selected, Limited",
    });
    fireEvent.pointerMove(ambient);
    const refreshButton = await screen.findByRole("button", {
      name: "Refresh usage for Terminal account",
    });
    fireEvent.pointerDown(refreshButton);
    fireEvent.click(refreshButton);
    expect(refreshAmbient).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("complementary", {
        name: "Usage details for Terminal account",
      }),
    ).toBeDefined();
  });
});
