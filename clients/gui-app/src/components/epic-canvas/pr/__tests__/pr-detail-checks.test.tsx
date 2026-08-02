import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PrCheckContext,
  PrChecksSection,
} from "@traycer/protocol/host/pr-schemas";
import { PrDetailChecks } from "@/components/epic-canvas/pr/pr-detail-sections";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";

/**
 * The Checks tab. The reported problems, in order: a flat ungrouped wall, no
 * app icons, job names shown without the workflow that disambiguates them,
 * and a separate trailing button doing what the name itself should do.
 */

function check(overrides: Partial<PrCheckContext>): PrCheckContext {
  return {
    name: "build",
    workflowName: null,
    event: null,
    appName: null,
    appLogoUrl: null,
    description: null,
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    ...overrides,
  };
}

function section(contexts: readonly PrCheckContext[]): PrChecksSection {
  return { observedAt: 1_000, contexts: [...contexts], isTruncated: false };
}

function renderChecks(args: {
  readonly contexts: readonly PrCheckContext[];
  readonly onOpenDetails: (url: string) => void;
}): void {
  render(
    <PrDetailChecks
      checks={section(args.contexts)}
      counts={{ passed: 1, failing: 1, pending: 0, total: 2 }}
      onOpenDetails={args.onOpenDetails}
    />,
  );
}

afterEach(cleanup);

describe("PrDetailChecks", () => {
  it("groups by outcome with a counted heading", () => {
    renderChecks({
      contexts: [
        check({ name: "pre-commit", conclusion: "failure" }),
        check({ name: "a", conclusion: "success" }),
        check({ name: "b", conclusion: "success" }),
        check({ name: "docs", conclusion: "skipped" }),
      ],
      onOpenDetails: () => undefined,
    });

    const groups = screen.getAllByTestId("pr-detail-check-group");
    expect(groups.map((node) => node.getAttribute("data-outcome"))).toEqual([
      "failing",
      "skipped",
      "successful",
    ]);
    expect(screen.getByText("1 failing check")).toBeTruthy();
    expect(screen.getByText("2 successful checks")).toBeTruthy();
  });

  it("opens every group, whatever its outcome", () => {
    // The grouping orders and labels the rows; it does not hide them. A check
    // you have to click to see is a check you have to know to look for.
    renderChecks({
      contexts: [
        check({ name: "pre-commit", conclusion: "failure" }),
        check({ name: "running", status: "in_progress", conclusion: null }),
        check({ name: "docs", conclusion: "skipped" }),
        check({ name: "a", conclusion: "success" }),
      ],
      onOpenDetails: () => undefined,
    });

    const groups = screen.getAllByTestId("pr-detail-check-group");
    expect(groups).toHaveLength(4);
    expect(groups.every((node) => node.hasAttribute("open"))).toBe(true);
    // Every row is reachable without a click.
    expect(screen.getAllByTestId("pr-detail-check-name")).toHaveLength(4);
  });

  it("shows the full composed name, not the bare job name", () => {
    renderChecks({
      contexts: [
        check({
          name: "pre-commit",
          workflowName: "Run Pre-commit",
          event: "pull_request",
          conclusion: "failure",
        }),
      ],
      onOpenDetails: () => undefined,
    });

    expect(
      screen.getByText("Run Pre-commit / pre-commit (pull_request)"),
    ).toBeTruthy();
  });

  it("makes the name itself the link, with no separate trailing button", () => {
    const opened: string[] = [];
    renderChecks({
      contexts: [
        check({
          name: "pre-commit",
          conclusion: "failure",
          detailsUrl: "https://ci/run/1",
        }),
      ],
      onOpenDetails: (url) => opened.push(url),
    });

    fireEvent.click(screen.getByTestId("pr-detail-check-name"));
    expect(opened).toEqual(["https://ci/run/1"]);
    expect(screen.queryByTestId("pr-detail-check-details")).toBeNull();
  });

  it("renders a name with no details url as plain text, not a dead control", () => {
    renderChecks({
      contexts: [check({ name: "orphan", conclusion: "failure" })],
      onOpenDetails: () => undefined,
    });

    const name = screen.getByTestId("pr-detail-check-name");
    expect(name.tagName).toBe("SPAN");
  });

  it("shows the reporting app's mark when it served one", () => {
    renderChecks({
      contexts: [
        check({
          name: "CodeRabbit",
          conclusion: "failure",
          appName: "CodeRabbit",
          appLogoUrl: "https://avatars/coderabbit.png",
        }),
      ],
      onOpenDetails: () => undefined,
    });

    const mark = screen.getByTestId("pr-detail-check-app-mark");
    expect(mark.getAttribute("src")).toBe("https://avatars/coderabbit.png");
    expect(tooltipTextFor(mark)).toBe("CodeRabbit");
  });

  it("omits the mark entirely when the app served no icon", () => {
    // A generic placeholder adds noise without adding a distinction.
    renderChecks({
      contexts: [check({ name: "plain", conclusion: "failure" })],
      onOpenDetails: () => undefined,
    });
    expect(screen.queryByTestId("pr-detail-check-app-mark")).toBeNull();
  });

  it("distinguishes five jobs that share a name", () => {
    // The real failure mode: one reusable workflow across several packages
    // reports `build` every time.
    renderChecks({
      contexts: [
        check({ name: "build", workflowName: "Build Host", event: "push" }),
        check({ name: "build", workflowName: "Build GUI", event: "push" }),
        check({ name: "build", workflowName: "Build CLI", event: "push" }),
      ],
      onOpenDetails: () => undefined,
    });

    const rendered = screen
      .getAllByTestId("pr-detail-check-name")
      .map((node) => node.textContent);
    expect(new Set(rendered).size).toBe(3);
  });
});
