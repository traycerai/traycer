import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderUsageLimitsSection } from "@/components/settings/panels/provider-usage-limits-section";

// The pick itself is held by `provider-limits-choose.test.tsx`; this suite is
// about WHERE it is offered, so the control is a marker.
vi.mock("@/components/layout-editor/inspector/provider-limits", () => ({
  ProviderLimitsControl: (props: { readonly providerId: string }) => (
    <div data-testid="limits-control">{props.providerId}</div>
  ),
}));

afterEach(cleanup);

describe("the Limits pick on a provider's own page", () => {
  it("is offered for a provider that reports rolling windows", () => {
    render(<ProviderUsageLimitsSection providerId="codex" />);

    expect(screen.getByText("Limits in usage readings")).toBeTruthy();
    expect(screen.getByTestId("limits-control").textContent).toBe("codex");
  });

  it("is withheld for a provider that reports a credit balance, which has no windows to pick", () => {
    render(<ProviderUsageLimitsSection providerId="openrouter" />);

    expect(screen.queryByTestId("limits-control")).toBeNull();
    expect(screen.queryByText("Limits in usage readings")).toBeNull();
  });

  it("is withheld for a provider that reports no usage at all", () => {
    render(<ProviderUsageLimitsSection providerId="traycer" />);

    expect(screen.queryByTestId("limits-control")).toBeNull();
  });
});
