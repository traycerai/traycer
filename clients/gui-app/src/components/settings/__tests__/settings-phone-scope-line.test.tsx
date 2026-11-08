import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";

interface ScopeReads {
  environment: EnvironmentPick;
  teamLabel: string;
  hostName: string;
  hostKind: "personal" | "sandbox" | null;
  hostMissing: boolean;
  hostLabel: string;
  vanishedName: string | null;
}

const reads = vi.hoisted((): ScopeReads => ({
  environment: { kind: "personal" },
  teamLabel: "Acme",
  hostName: "tgill-mbp",
  hostKind: "personal",
  hostMissing: false,
  hostLabel: "No host",
  vanishedName: null,
}));

vi.mock("@/components/settings/use-settings-anchor-reveal", () => ({
  useSettingsAnchorReveal: () => undefined,
}));

vi.mock("@/components/settings/personal/personal-page-frame", async () => {
  const React = await import("react");
  return {
    PersonalPageFrame: (props: { readonly children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
    PersonalPageHeaderStatus: () => null,
  };
});

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () =>
      hostScopeFixture({
        host: reads.hostMissing
          ? null
          : hostScopeOptionFixture({
              hostId: "host-a",
              name: reads.hostName,
              kind: reads.hostKind,
            }),
        hostLabel: reads.hostLabel,
        vanishedSelection:
          reads.vanishedName === null
            ? null
            : { name: reads.vanishedName, forget: () => undefined },
      }),
  };
});

vi.mock("@/stores/settings/settings-environment-pick-store", () => ({
  useEnvironmentPick: () => reads.environment,
}));

vi.mock("@/components/settings/environment/team-pick-label", () => ({
  usePickedTeamLabel: () => reads.teamLabel,
}));

vi.mock("@/components/settings/panels/diagnostics-settings-panel", async () => {
  const React = await import("react");
  const { SettingsPanelShell } =
    await import("@/components/settings/settings-panel-shell");
  return {
    DiagnosticsSettingsPanel: () =>
      React.createElement(SettingsPanelShell, {
        title: "Diagnostics",
        children: null,
      }),
  };
});

vi.mock("@/components/settings/panels/appearance-settings-panel", async () => {
  const React = await import("react");
  const { SettingsPanelShell } =
    await import("@/components/settings/settings-panel-shell");
  return {
    AppearanceSettingsPanel: () =>
      React.createElement(SettingsPanelShell, {
        title: "Appearance",
        children: null,
      }),
  };
});

vi.mock("@/components/settings/panels/host-settings-panel", async () => {
  const React = await import("react");
  const { SettingsPanelShell } =
    await import("@/components/settings/settings-panel-shell");
  return {
    HostSettingsPanel: () =>
      React.createElement(SettingsPanelShell, {
        title: "Overview",
        children: null,
      }),
  };
});

vi.mock("@/components/settings/panels/worktrees-settings-panel", async () => {
  const React = await import("react");
  const { SettingsPanelShell } =
    await import("@/components/settings/settings-panel-shell");
  return {
    WorktreesSettingsPanel: () =>
      React.createElement(SettingsPanelShell, {
        title: "Worktrees",
        children: null,
      }),
  };
});

vi.mock("@/components/settings/panels/providers-settings-panel", async () => {
  const React = await import("react");
  const { SettingsPanelShell } =
    await import("@/components/settings/settings-panel-shell");
  const Panel = () =>
    React.createElement(SettingsPanelShell, {
      title: "Providers",
      children: null,
    });
  return {
    ProvidersSettingsPanel: Panel,
    McpServersSettingsPanel: Panel,
    SkillsSettingsPanel: Panel,
  };
});

import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";

const originalMatchMedia = window.matchMedia.bind(window);
const originalInnerWidth = window.innerWidth;

function renderSection(
  section: "diagnostics" | "providers" | "appearance" | "host" | "worktrees",
) {
  return render(<SettingsPanelForSection section={section} />);
}

function scopeLine(): HTMLElement {
  return screen.getByTestId("settings-phone-scope-line");
}

beforeEach(() => {
  reads.environment = { kind: "personal" };
  reads.teamLabel = "Acme";
  reads.hostName = "tgill-mbp";
  reads.hostKind = "personal";
  reads.hostMissing = false;
  reads.hostLabel = "No host";
  reads.vanishedName = null;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1024,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches:
        query === "(width < 768px)" ? false : originalMatchMedia(query).matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  setPhoneLayoutOnly(true);
});

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
});

describe("SettingsPanelForSection phone scope line", () => {
  it("shows the host scope beneath the section title in phone layout at tablet width", () => {
    renderSection("diagnostics");

    const title = screen.getByRole("heading", { name: "Diagnostics" });
    const line = scopeLine();
    expect(line.textContent).toBe("Personal › tgill-mbp · Computer");
    expect(
      title.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(window.innerWidth).toBe(1024);
    expect(window.matchMedia("(width < 768px)").matches).toBe(false);
  });

  it("omits Overview scope for team and local picks at phone and tablet widths", () => {
    const localPick: EnvironmentPick = {
      kind: "local",
      hostId: "host-local",
      hostName: "tgill-popos",
    };
    const teamPick: EnvironmentPick = { kind: "team", environmentId: "team-1" };
    const cases = [
      [teamPick, 1024],
      [teamPick, 390],
      [localPick, 1024],
      [localPick, 390],
    ] as const;
    for (const [environment, width] of cases) {
      cleanup();
      reads.environment = environment;
      reads.hostName =
        environment.kind === "local" ? environment.hostName : "tgill-mbp";
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
      });
      renderSection("host");
      expect(screen.getByRole("heading", { name: "Overview" })).not.toBeNull();
      expect(screen.queryByTestId("settings-phone-scope-line")).toBeNull();
    }

    cleanup();
    reads.environment = teamPick;
    reads.hostName = "tgill-mbp";
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    renderSection("worktrees");
    expect(screen.getByRole("heading", { name: "Worktrees" })).not.toBeNull();
    expect(scopeLine().textContent).toBe("Acme › tgill-mbp · Computer");
  });

  it("shows a picked team name alone on an environment section", () => {
    reads.environment = { kind: "team", environmentId: "team-1" };
    renderSection("providers");

    expect(scopeLine().textContent).toBe("Acme");
  });

  it("shows a local computer name alone on an environment section", () => {
    reads.environment = {
      kind: "local",
      hostId: "host-local",
      hostName: "tgill-popos",
    };
    renderSection("providers");

    expect(scopeLine().textContent).toBe("tgill-popos");
  });

  it("uses the no-host label or vanished selection without inventing a kind", () => {
    reads.hostMissing = true;
    const view = renderSection("diagnostics");

    expect(scopeLine().textContent).toBe("Personal › No host");

    reads.vanishedName = "old-host";
    view.rerender(<SettingsPanelForSection section="diagnostics" />);
    expect(scopeLine().textContent).toBe(
      "Personal › old-host is no longer here.",
    );
  });

  it("omits the line from application settings and desktop layout", () => {
    renderSection("appearance");
    expect(screen.queryByTestId("settings-phone-scope-line")).toBeNull();

    cleanup();
    setPhoneLayoutOnly(false);
    renderSection("diagnostics");
    expect(screen.queryByTestId("settings-phone-scope-line")).toBeNull();
  });
});
