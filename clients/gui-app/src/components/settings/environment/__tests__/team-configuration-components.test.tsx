import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationConflict } from "@/components/settings/environment/configuration-conflict";
import { PlanUnlinkPreview } from "@/components/settings/environment/plan-unlink-preview";
import {
  PlansCard,
  type ConfigurationPlan,
} from "@/components/settings/environment/plans-card";
import { TeamContentNeedsHost } from "@/components/settings/environment/team-content-needs-host";
import { TeamSecretNames } from "@/components/settings/environment/team-secret-names";

const plan: ConfigurationPlan = {
  id: "plan-1",
  linkedBy: "Ada",
  providerLabel: "Claude",
};

function renderPlans(overrides: {
  canAdminister: boolean;
  onLink?: () => void;
  onPreviewUnlink?: (plan: ConfigurationPlan) => void;
}): void {
  render(
    <PlansCard
      teamName="Acme"
      plans={[plan]}
      canAdminister={overrides.canAdminister}
      adminNames={["Ada", "Grace"]}
      isPending={false}
      onLink={overrides.onLink ?? vi.fn()}
      onPreviewUnlink={overrides.onPreviewUnlink ?? vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("PlansCard", () => {
  it("gives a viewer no Link or Unlink verbs and names the admins", () => {
    renderPlans({ canAdminister: false });

    expect(screen.queryByRole("button", { name: /link a plan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /unlink/i })).toBeNull();
    expect(screen.getByText("Admins link a plan: Ada, Grace.")).toBeTruthy();
  });

  it("hands the plan to the preview callback when an admin clicks Unlink", () => {
    const onPreviewUnlink = vi.fn();
    const onLink = vi.fn();
    renderPlans({ canAdminister: true, onPreviewUnlink, onLink });

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(onPreviewUnlink).toHaveBeenCalledExactlyOnceWith(plan);
    expect(onLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /link a plan/i }));
    expect(onLink).toHaveBeenCalledOnce();
  });

  it("never offers to add a profile", () => {
    renderPlans({ canAdminister: true });
    expect(screen.queryByText(/add a profile/i)).toBeNull();
  });
});

describe("TeamSecretNames", () => {
  it("lists names with their state and renders no buttons", () => {
    render(
      <TeamSecretNames
        secrets={[
          { name: "OPENAI_API_KEY", revoked: false },
          { name: "OLD_TOKEN", revoked: true },
        ]}
      />,
    );

    expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
    expect(screen.getByText("Removing · no longer usable")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});

describe("ConfigurationConflict", () => {
  it("names who changed the value", () => {
    render(<ConfigurationConflict changedBy="Grace" />);
    expect(screen.getByRole("status").textContent).toBe(
      "Changed by Grace a moment ago",
    );
  });

  it("falls back to another member when the author is unknown", () => {
    render(<ConfigurationConflict changedBy={null} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Changed by another member a moment ago",
    );
  });
});

describe("PlanUnlinkPreview", () => {
  function renderPreview(
    activeTurns: number | null,
    handlers: { onConfirm: () => void; onClose: () => void },
  ): void {
    render(
      <PlanUnlinkPreview
        teamName="Acme"
        plan={plan}
        activeTurns={activeTurns}
        remainingAccess={["Team key"]}
        isPending={false}
        onClose={handlers.onClose}
        onConfirm={handlers.onConfirm}
      />,
    );
  }

  it("confirms only on the Unlink click, and Cancel closes without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderPreview(3, { onConfirm, onClose });

    expect(screen.getByText(/3 active turns\./)).toBeTruthy();
    expect(screen.getByText("Team key.")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("says so when active turns could not be counted", () => {
    renderPreview(null, { onConfirm: vi.fn(), onClose: vi.fn() });
    expect(
      screen.getByText(/Active turns could not be counted\./),
    ).toBeTruthy();
  });
});

describe("TeamContentNeedsHost", () => {
  it.each([
    ["guide", "The guide needs a host running Acme. Pick one."],
    ["skills", "Skills need a host running Acme. Pick one."],
  ] as const)(
    "reads the %s line and picks a host on click",
    (content, line) => {
      const onPickHost = vi.fn();
      render(
        <TeamContentNeedsHost
          content={content}
          teamName="Acme"
          onPickHost={onPickHost}
        />,
      );

      expect(screen.getByRole("status").textContent).toBe(line);
      expect(onPickHost).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Pick one." }));
      expect(onPickHost).toHaveBeenCalledOnce();
    },
  );
});
