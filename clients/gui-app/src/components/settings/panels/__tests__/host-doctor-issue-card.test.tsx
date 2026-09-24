import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMobileApp } from "@/lib/mobile-app";
import { modLabel } from "@/lib/keybindings/platform";
import { HostDoctorIssueCard } from "@/components/settings/panels/host-doctor-issue-card";
import type { HostDoctorIssue } from "@traycer-clients/shared/platform/runner-host";

// A wrapped call site that mounts with plain props - no host/query
// scaffolding: the mod-glyph chip in front of "Open in Terminal".
const issue: HostDoctorIssue = {
  code: "missing-tool",
  severity: "warning",
  title: "Missing tool",
  message: "A required tool could not be found.",
  fixAction: null,
  terminalCommand: "brew install ripgrep",
  details: null,
};

function renderCard() {
  return render(
    <HostDoctorIssueCard
      issue={issue}
      expanded={false}
      recurrenceLocked={false}
      fixPendingCode={null}
      onFix={vi.fn()}
      onToggle={vi.fn()}
    />,
  );
}

describe("<HostDoctorIssueCard /> Open in Terminal hint", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("shows the mod glyph before the label outside the mobile app", () => {
    renderCard();
    const button = screen.getByRole("button", { name: /Open in Terminal/ });
    expect(button.textContent).toContain(modLabel());
    expect(button.textContent).toContain("Open in Terminal");
  });

  it("drops the mod glyph on the installed mobile app but keeps the label", () => {
    setMobileApp(true);
    renderCard();
    const button = screen.getByRole("button", { name: "Open in Terminal" });
    expect(button.textContent).toBe("Open in Terminal");
    expect(button.textContent).not.toContain(modLabel());
  });
});

// M1: "Update service" (`service-refresh`) - the `host service refresh` doctor
// fix. Same card, a different issue shape.
const serviceRefreshIssue: HostDoctorIssue = {
  code: "HOST_SERVICE_DEFINITION_STALE",
  severity: "warning",
  title: "Host service definition is out of date",
  message: "The registered service predates the current launcher.",
  fixAction: "service-refresh",
  terminalCommand: "traycer host service refresh",
  details: null,
};

describe("<HostDoctorIssueCard /> service-refresh (M1)", () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the "Update service" fix button', () => {
    render(
      <HostDoctorIssueCard
        issue={serviceRefreshIssue}
        expanded={false}
        recurrenceLocked={false}
        fixPendingCode={null}
        onFix={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Update service" });
    expect(button.textContent).toBe("Update service");
  });

  it("shows the terminal command as secondary text once expanded", () => {
    render(
      <HostDoctorIssueCard
        issue={serviceRefreshIssue}
        expanded
        recurrenceLocked={false}
        fixPendingCode={null}
        onFix={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    const command = screen.getByTestId("host-doctor-issue-terminal-command");
    expect(command.textContent).toBe("traycer host service refresh");
  });
});
