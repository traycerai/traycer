import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { ONBOARDING_ACTS } from "@/components/onboarding/onboarding-acts";
import type { OnboardingAgentGuideState } from "@/components/onboarding/onboarding-diorama";
import { RunnerHostContext } from "@/providers/runner-host-context";

type GuideQueryState = {
  readonly data:
    | {
        readonly content: string | null;
        readonly generatedDefaultContent: string;
        readonly providersSettled: boolean;
      }
    | undefined;
  readonly isError: boolean;
};

// Stub heavy layout-only sub-trees that have no bearing on navigation logic.
vi.mock("@/components/auth/cinematic-backdrop", () => ({
  PhotoBloom: () => <div data-testid="photo-bloom-stub" />,
  BrandMark: () => <span data-testid="brand-mark-stub" />,
}));

vi.mock("@/components/onboarding/onboarding-detected-agents", () => ({
  OnboardingDetectedAgents: () => <div data-testid="detected-agents-stub" />,
}));

vi.mock("@/components/onboarding/onboarding-theme-picker", () => ({
  OnboardingThemePicker: () => <div data-testid="theme-picker-stub" />,
}));

vi.mock("@/components/onboarding/onboarding-diorama", () => ({
  OnboardingDiorama: (props: {
    readonly stage: number;
    readonly agentGuide: OnboardingAgentGuideState;
  }) => (
    <div data-testid="onboarding-diorama-stub" data-stage={props.stage}>
      {props.stage === 4 ? (
        <>
          <textarea
            data-testid="mock-agent-guide-input"
            aria-label="Agent selection guide"
            value={props.agentGuide.value}
            disabled={props.agentGuide.loading || props.agentGuide.saving}
            onChange={(event) =>
              props.agentGuide.onValueChange(event.target.value)
            }
          />
          <button
            type="button"
            data-testid="mock-agent-guide-revert"
            disabled={
              props.agentGuide.loading ||
              props.agentGuide.saving ||
              props.agentGuide.value ===
                props.agentGuide.generatedDefaultContent
            }
            onClick={props.agentGuide.onRevertToDefault}
          >
            Revert
          </button>
        </>
      ) : null}
    </div>
  ),
}));

let guideQueryState: GuideQueryState = {
  data: {
    content: "saved guide",
    generatedDefaultContent: "claude guide",
    providersSettled: true,
  },
  isError: false,
};
const setGlobalGuideMock = vi.fn((variables: { readonly content: string }) =>
  Promise.resolve({
    content: variables.content,
    generatedDefaultContent:
      guideQueryState.data?.generatedDefaultContent ?? "",
  }),
);
const resetSetGlobalGuideMock = vi.fn();

vi.mock(
  "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query",
  () => ({
    useAgentSelectionGuideGlobalOnboardingDraftQuery: () => guideQueryState,
  }),
);

vi.mock("@/hooks/agent/use-agent-selection-guide-set-global-mutation", () => ({
  useAgentSelectionGuideSetGlobalMutation: () => ({
    isError: false,
    isPending: false,
    mutateAsync: setGlobalGuideMock,
    reset: resetSetGlobalGuideMock,
  }),
}));

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
const routerHistory = { length: 1, back: historyBackMock };

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useRouter: () => ({ history: routerHistory }),
  };
});

// Import after mocks are registered.
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

function renderPage(args: { readonly replay: boolean }) {
  return render(
    <LazyMotion features={domAnimation}>
      <OnboardingPage replay={args.replay} />
    </LazyMotion>,
  );
}

function createRunnerHost() {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

async function advanceToStage(stage: number): Promise<void> {
  const current = Number(
    screen.getByTestId("onboarding-diorama-stub").getAttribute("data-stage"),
  );
  for (let index = current; index < stage; index++) {
    fireEvent.click(screen.getByTestId("onboarding-advance"));
    await waitFor(() => {
      expect(
        screen
          .getByTestId("onboarding-diorama-stub")
          .getAttribute("data-stage"),
      ).toBe(String(index + 1));
    });
  }
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    navigateMock.mockReset();
    historyBackMock.mockReset();
    setGlobalGuideMock.mockClear();
    resetSetGlobalGuideMock.mockClear();
    routerHistory.length = 1;
    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
  });

  afterEach(() => {
    cleanup();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
  });

  it("renders act 1 copy and the live miniature on initial mount", () => {
    renderPage({ replay: false });

    const firstAct = ONBOARDING_ACTS[0];
    expect(
      screen.getByText(firstAct.title.replace(/\s+/g, " "), {
        exact: false,
      }),
    ).not.toBeNull();
    expect(screen.getByTestId("onboarding-diorama-stub")).not.toBeNull();
  });

  it("starts a new onboarding session from act 1 instead of a stale store step", async () => {
    useOnboardingStore.setState({ completedAt: 123, step: 3 });

    renderPage({ replay: true });

    const firstAct = ONBOARDING_ACTS[0];
    await waitFor(() => {
      expect(
        screen.getByText(firstAct.title.replace(/\s+/g, " "), {
          exact: false,
        }),
      ).not.toBeNull();
      expect(useOnboardingStore.getState().completedAt).toBe(123);
      expect(useOnboardingStore.getState().step).toBe(0);
    });
  });

  it("shows the continue button (not 'Enter Traycer') on the first act", () => {
    renderPage({ replay: false });

    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Continue",
    );
  });

  it("shows the client version in the footer", () => {
    renderPage({ replay: false });

    expect(screen.getByText("v0.0.0")).not.toBeNull();
  });

  it("wires onboarding footer links to the website destinations", () => {
    const host = createRunnerHost();
    render(
      <RunnerHostContext.Provider value={host}>
        <LazyMotion features={domAnimation}>
          <OnboardingPage replay={false} />
        </LazyMotion>
      </RunnerHostContext.Provider>,
    );

    const expectedLinks = [
      ["Features", traycerInfo.mainWebsiteFeatures],
      ["Enterprise", traycerInfo.mainWebsiteEnterprise],
      ["Support", traycerInfo.mainWebsiteContactUs],
    ] as const;

    expectedLinks.forEach(([label, url]) => {
      const link = screen.getByRole<HTMLAnchorElement>("link", {
        name: label,
      });
      expect(link.href).toBe(url);
      fireEvent.click(link);
    });

    expect(host.openedExternalLinks).toEqual(
      expectedLinks.map(([, url]) => url),
    );
  });

  it("falls back to browser navigation when the runner host cannot open a footer link", async () => {
    const host = createRunnerHost();
    const openExternalLinkMock = vi
      .spyOn(host, "openExternalLink")
      .mockRejectedValue(new Error("host unavailable"));
    const windowOpenMock = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);

    render(
      <RunnerHostContext.Provider value={host}>
        <LazyMotion features={domAnimation}>
          <OnboardingPage replay={false} />
        </LazyMotion>
      </RunnerHostContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole<HTMLAnchorElement>("link", {
        name: "Support",
      }),
    );

    await waitFor(() => {
      expect(windowOpenMock).toHaveBeenCalledWith(
        traycerInfo.mainWebsiteContactUs,
        "_blank",
        "noopener,noreferrer",
      );
    });
    expect(openExternalLinkMock).toHaveBeenCalledWith(
      traycerInfo.mainWebsiteContactUs,
    );

    windowOpenMock.mockRestore();
  });

  it("advances through all five acts while keeping the Figma continue label", async () => {
    renderPage({ replay: false });

    const lastActIndex = ONBOARDING_ACTS.length - 1;
    for (let index = 0; index < lastActIndex; index++) {
      const advanceButton = screen.getByTestId("onboarding-advance");
      expect(advanceButton.textContent).toContain("Continue");
      fireEvent.click(advanceButton);
      await waitFor(() => {
        expect(
          screen
            .getByTestId("onboarding-diorama-stub")
            .getAttribute("data-stage"),
        ).toBe(String(index + 1));
      });
    }

    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );
  });

  it("first-run finish (no replay flag) marks complete and opens a fresh draft tab", async () => {
    renderPage({ replay: false });

    await advanceToStage(ONBOARDING_ACTS.length - 1);

    // Now on the last act.
    expect(useOnboardingStore.getState().completedAt).toBeNull();

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "saved guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
    expect(historyBackMock).not.toHaveBeenCalled();
  });

  it("shows the generated guide in onboarding, keeps it in memory on Continue, and saves on finish", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToStage(4);

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("claude guide");

    fireEvent.change(input, { target: { value: "custom onboarding guide" } });
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(
        screen
          .getByTestId("onboarding-diorama-stub")
          .getAttribute("data-stage"),
      ).toBe("5");
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "custom onboarding guide",
      });
    });
  });

  it("keeps onboarding navigation available while provider discovery settles", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "traycer guide",
        providersSettled: false,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToStage(4);

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Agent selection guide",
    });
    expect(input.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /continue/i })
        .disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /skip intro/i })
        .disabled,
    ).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();
  });

  it("persists an edited existing guide even while provider discovery is still settling", async () => {
    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "claude guide",
        providersSettled: false,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToStage(4);

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Agent selection guide",
    });
    expect(input.disabled).toBe(false);

    fireEvent.change(input, {
      target: { value: "edited while providers settle" },
    });
    fireEvent.click(screen.getByRole("button", { name: /skip intro/i }));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "edited while providers settle",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
  });

  it("never traps the user when the onboarding guide fails to load", async () => {
    guideQueryState = { data: undefined, isError: true };
    renderPage({ replay: false });

    await advanceToStage(4);

    // The optional guide keeps spinning (editor disabled) since the read never
    // resolved, but it must not block onboarding: Skip and Advance stay enabled.
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input")
        .disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-skip").disabled,
    ).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-advance").disabled,
    ).toBe(false);

    // Skipping completes onboarding without attempting to persist an unloaded
    // guide.
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();
  });

  it("refreshes an untouched onboarding guide from regenerated defaults and preserves edits", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    const { rerender } = renderPage({ replay: false });

    await advanceToStage(4);

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("claude guide");

    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("codex guide");
    });

    fireEvent.change(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input"),
      {
        target: { value: "hand-written guide" },
      },
    );
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "opencode guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("hand-written guide");

    fireEvent.click(screen.getByTestId("mock-agent-guide-revert"));
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("opencode guide");
  });

  it("replaces cached generated onboarding content with later saved disk content", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    const { rerender } = renderPage({ replay: false });

    await advanceToStage(4);

    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("claude guide");

    guideQueryState = {
      data: {
        content: "saved disk guide",
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("saved disk guide");
    });
  });

  it("shows existing guide content without replacing it with provider defaults", async () => {
    const { rerender } = renderPage({ replay: false });

    await advanceToStage(4);

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("saved guide");

    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("saved guide");
    });

    fireEvent.click(screen.getByTestId("mock-agent-guide-revert"));
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("codex guide");

    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "opencode guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("codex guide");
    });
  });

  it("replay finish (replay flag) saves the visible guide, marks complete, and returns to the prior route", async () => {
    renderPage({ replay: true });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "saved guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("clicking the skip button on a first run saves the visible guide and opens a fresh draft tab", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    renderPage({ replay: false });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "claude guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });
});
