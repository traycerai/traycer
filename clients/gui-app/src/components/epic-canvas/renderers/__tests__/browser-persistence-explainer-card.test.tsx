import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPersistenceExplainerCard } from "@/components/epic-canvas/renderers/browser-persistence-explainer-card";
import type { BrowserPersistenceController } from "@/lib/browser-view/use-browser-persistence-state";
import type {
  BrowserPersistenceDecision,
  BrowserPersistencePlatform,
} from "@traycer-clients/shared/platform/browser-view";

afterEach(cleanup);

function makeController(input: {
  readonly decision: BrowserPersistenceDecision;
  readonly promptsOnEnable: boolean;
  readonly platform: BrowserPersistencePlatform;
  readonly enable: () => void;
  readonly decline: () => void;
}): BrowserPersistenceController {
  return {
    state: {
      decision: input.decision,
      cryptoState: {
        mode: "degraded",
        persistence: "ephemeral",
        reason: "not-enabled",
        storageBackend: null,
        encryptionAvailable: false,
      },
      promptsOnEnable: input.promptsOnEnable,
      appName: "Traycer Staging",
      platform: input.platform,
    },
    pending: false,
    enable: input.enable,
    decline: input.decline,
    relaunch: () => undefined,
  };
}

describe("BrowserPersistenceExplainerCard", () => {
  it("mocks the exact keychain dialog for the running app name", () => {
    render(
      <BrowserPersistenceExplainerCard
        persistence={makeController({
          decision: { kind: "undecided" },
          promptsOnEnable: true,
          platform: "darwin",
          enable: () => undefined,
          decline: () => undefined,
        })}
        agentDriven={false}
      />,
    );

    // The staging build's dialog quotes its own product name; a card that said
    // "Traycer" would not match what the user is about to see.
    expect(
      screen.getByLabelText(
        'Preview of the system dialog: "Traycer Staging" wants to access key "Traycer Staging Safe Storage" in your keychain.',
      ),
    ).toBeTruthy();
    // Twice on purpose: the mocked button, and the caption telling the user to
    // pick it.
    expect(screen.getAllByText("Always Allow")).toHaveLength(2);
    expect(screen.getByText("Deny")).toBeTruthy();
    expect(screen.getByText("Allow")).toBeTruthy();
  });

  it("routes Enable saved logins and Not now to the bridge", async () => {
    const enable = vi.fn();
    const decline = vi.fn();
    render(
      <BrowserPersistenceExplainerCard
        persistence={makeController({
          decision: { kind: "undecided" },
          promptsOnEnable: true,
          platform: "darwin",
          enable,
          decline,
        })}
        agentDriven={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Enable saved logins" }),
    );
    expect(enable).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(decline).toHaveBeenCalledTimes(1);
  });

  it("names the agent when the tile was agent-placed", () => {
    render(
      <BrowserPersistenceExplainerCard
        persistence={makeController({
          decision: { kind: "undecided" },
          promptsOnEnable: true,
          platform: "darwin",
          enable: () => undefined,
          decline: () => undefined,
        })}
        agentDriven
      />,
    );

    expect(
      screen.getByText(/An agent opened this browser and it is signed out\./),
    ).toBeTruthy();
  });

  it("stays hidden once the machine has a decision", () => {
    render(
      <BrowserPersistenceExplainerCard
        persistence={makeController({
          decision: { kind: "declined", decidedAt: 1 },
          promptsOnEnable: true,
          platform: "darwin",
          enable: () => undefined,
          decline: () => undefined,
        })}
        agentDriven={false}
      />,
    );

    expect(screen.queryByTestId("browser-persistence-explainer-card")).toBe(
      null,
    );
  });

  it("stays hidden on a platform that never prompts", () => {
    render(
      <BrowserPersistenceExplainerCard
        persistence={makeController({
          decision: { kind: "undecided" },
          promptsOnEnable: false,
          platform: "win32",
          enable: () => undefined,
          decline: () => undefined,
        })}
        agentDriven={false}
      />,
    );

    expect(screen.queryByTestId("browser-persistence-explainer-card")).toBe(
      null,
    );
  });
});
