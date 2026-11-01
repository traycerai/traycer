import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ConsequencesBlock } from "@/components/composer/consequences-block";
import {
  consequencesShownSubject,
  type ConsequencesInput,
} from "@/lib/sandboxes/sandbox-stage-model";
import { CONSEQUENCES_WORDING_VERSION } from "@/lib/sandboxes/sandbox-strings";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  consequencesShown,
  useTeamHostDisclosureSeenStore,
} from "@/stores/hosts/team-host-disclosure-seen-store";

const mocks = vi.hoisted(() => ({
  openLink: vi.fn<(url: string, kind: string) => void>(),
}));

vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://billing.test/acme",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => (url: string, kind: string) => {
    mocks.openLink(url, kind);
    return Promise.resolve();
  },
}));

const VIEWER = "user-me";
const ACME = { kind: "team", teamId: "team-acme", teamName: "Acme" } as const;

function input(overrides: Partial<ConsequencesInput>): ConsequencesInput {
  return {
    configuration: ACME,
    price: { awakeMcPerHour: 120, exact: true },
    needsCredits: false,
    audience: "shared",
    reachHost: null,
    unmovedComputer: null,
    ...overrides,
  };
}

function block(value: ConsequencesInput) {
  return (
    <ConsequencesBlock
      input={value}
      onMoveFirst={null}
      onOpenTerminalInstead={null}
      chooseAnotherHostLabel="Use This computer"
    />
  );
}

function subjectOf(value: ConsequencesInput): string {
  return consequencesShownSubject(
    value.configuration,
    value.audience,
    CONSEQUENCES_WORDING_VERSION,
  );
}

beforeEach(() => {
  localStorage.clear();
  useTeamHostDisclosureSeenStore.setState({ seen: {} });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "me" },
  });
  mocks.openLink.mockClear();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<ConsequencesBlock />", () => {
  it("renders every clause in full the first time and records it as shown", () => {
    const value = input({ reachHost: "Build box" });
    render(block(value));

    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "$0.12 an hour while awake · uses your Acme credits",
    );
    for (const kind of [
      "audience",
      "reach",
      "team",
      "resting-storage",
      "shared-use",
    ]) {
      expect(screen.getByTestId(`consequences-clause-${kind}`)).toBeDefined();
    }
    expect(screen.queryByTestId("consequences-what-this-means")).toBeNull();
    expect(screen.queryByTestId("consequences-show-less")).toBeNull();
    expect(
      consequencesShown(
        useTeamHostDisclosureSeenStore.getState().seen,
        VIEWER,
        subjectOf(value),
      ),
    ).toBe(true);
  });

  it("collapses an unchanged repeat to the price and What this means, which expands", () => {
    const value = input({});
    const first = render(block(value));
    first.unmount();

    render(block(value));

    expect(screen.getByTestId("consequences-price")).toBeDefined();
    expect(screen.queryByTestId("consequences-clause-team")).toBeNull();
    fireEvent.click(screen.getByTestId("consequences-what-this-means"));
    expect(screen.getByTestId("consequences-clause-team")).toBeDefined();
    expect(screen.queryByTestId("consequences-what-this-means")).toBeNull();

    fireEvent.click(screen.getByTestId("consequences-show-less"));
    expect(screen.queryByTestId("consequences-clause-team")).toBeNull();
  });

  it("renders in full again for a different audience", () => {
    render(block(input({ audience: "private" }))).unmount();
    expect(
      consequencesShown(
        useTeamHostDisclosureSeenStore.getState().seen,
        VIEWER,
        subjectOf(input({ audience: "shared" })),
      ),
    ).toBe(false);

    render(block(input({ audience: "shared" })));

    expect(screen.getByTestId("consequences-clause-audience")).toBeDefined();
    expect(screen.getByTestId("consequences-clause-team")).toBeDefined();
  });

  it("renders in full again for a different configuration", () => {
    render(block(input({}))).unmount();

    render(
      block(
        input({
          configuration: {
            kind: "team",
            teamId: "team-globex",
            teamName: "Globex",
          },
        }),
      ),
    );

    expect(
      screen.getByTestId("consequences-clause-team").textContent,
    ).toContain("Globex");
  });

  it("renders in full and collapses nothing for a signed-out viewer, recording nothing", () => {
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    render(block(input({}))).unmount();

    render(block(input({})));

    expect(screen.getByTestId("consequences-clause-team")).toBeDefined();
    expect(useTeamHostDisclosureSeenStore.getState().seen).toEqual({});
  });

  it("is the price alone, with no What this means, when nothing else applies", () => {
    render(
      block(
        input({ configuration: { kind: "personal" }, audience: "private" }),
      ),
    );

    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "$0.12 an hour while awake · uses your credits",
    );
    expect(screen.queryByTestId("consequences-what-this-means")).toBeNull();
  });

  it("at a short balance asks for the team's credits and links to the configuration's billing page", () => {
    render(block(input({ needsCredits: true, shortfallMc: 120 })));

    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "Your Acme allowance is short $0.12. $0.12 more starts this sandbox for an hour.",
    );
    const link = within(screen.getByTestId("consequences-block")).getByRole(
      "button",
      { name: "Add credits ↗" },
    );
    fireEvent.click(link);
    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://billing.test/acme",
      "account",
    );
  });

  it("at a short balance on Personal asks for credits, without a team's name", () => {
    render(
      block(
        input({
          configuration: { kind: "personal" },
          audience: "private",
          needsCredits: true,
          shortfallMc: 120,
        }),
      ),
    );

    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "Not enough credits. $0.12 more starts this sandbox for an hour.",
    );
  });

  it("offers another host instead of a terminal at a short allowance", () => {
    const choose = vi.fn<() => void>();
    render(
      <ConsequencesBlock
        input={input({ needsCredits: true, shortfallMc: 210 })}
        onMoveFirst={null}
        onOpenTerminalInstead={vi.fn()}
        chooseAnotherHostLabel="Use This computer"
        onChooseAnotherHost={choose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use This computer" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Open terminal instead" }),
    ).toBeNull();
  });

  it("says who takes over payment before a task wakes a team sandbox", () => {
    render(block(input({ wakingName: "e2e-sbx-t1" })));
    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "Waking e2e-sbx-t1 uses your Acme allowance and makes you the payer.",
    );
  });

  it("does not offer Add credits at a covered balance", () => {
    render(block(input({})));
    expect(screen.queryByTestId("consequences-add-credits")).toBeNull();
  });

  it("prefixes `from ` for a price that is only a lower bound", () => {
    render(block(input({ price: { awakeMcPerHour: 120, exact: false } })));
    expect(screen.getByTestId("consequences-price").textContent).toBe(
      "from $0.12 an hour while awake · uses your Acme credits",
    );
  });

  it("offers Move them first beside the move clause only when the surface can move them", () => {
    const onMoveFirst = vi.fn<() => void>();
    const withMove = input({
      configuration: { kind: "personal" },
      audience: "private",
      unmovedComputer: "MacBook",
    });
    render(
      <ConsequencesBlock
        input={withMove}
        onMoveFirst={onMoveFirst}
        onOpenTerminalInstead={null}
        chooseAnotherHostLabel="Use This computer"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move them first" }));
    expect(onMoveFirst).toHaveBeenCalledTimes(1);
    cleanup();
    useTeamHostDisclosureSeenStore.setState({ seen: {} });

    render(block(withMove));
    expect(
      screen.getByTestId("consequences-clause-move").textContent,
    ).toContain("MacBook");
    expect(
      screen.queryByRole("button", { name: "Move them first" }),
    ).toBeNull();
  });
});
