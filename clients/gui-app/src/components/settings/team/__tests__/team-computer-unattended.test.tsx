import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TeamComputerUnattended,
  type TeamComputerUnattendedProps,
} from "../team-computer-unattended";

const TOKEN = "one-time-secret-token";
const TEAM_SELECTOR = "team's org";

function props(
  overrides: Partial<TeamComputerUnattendedProps>,
): TeamComputerUnattendedProps {
  return {
    teamSelector: TEAM_SELECTOR,
    pending: false,
    token: { installToken: TOKEN, expiresAt: Date.now() + 60_000 },
    failure: null,
    onMint: vi.fn(),
    ...overrides,
  };
}

function installClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TeamComputerUnattended", () => {
  it("hides a token that is already expired on the first mount", () => {
    render(
      <TeamComputerUnattended
        {...props({
          token: { installToken: TOKEN, expiresAt: Date.now() - 1 },
        })}
      />,
    );

    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.getByText(/install token expired/i)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Create a new token" }),
    ).not.toBeNull();
  });

  it("hides the token when its deadline elapses", () => {
    render(
      <TeamComputerUnattended
        {...props({
          token: { installToken: TOKEN, expiresAt: Date.now() + 1_000 },
        })}
      />,
    );
    expect(screen.getByText(TOKEN)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.getByText(/install token expired/i)).not.toBeNull();
  });

  it("copies a shell-quoted selector while keeping the token out of the command", async () => {
    const copyAttempt = Promise.withResolvers<void>();
    const writeText = vi.fn((_value: string) => copyAttempt.promise);
    installClipboard(writeText);
    render(<TeamComputerUnattended {...props({})} />);

    const command =
      "traycer host install --team 'team'\\''s org' < install-token.txt";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
      expect(writeText.mock.calls).toEqual([[command]]);
      copyAttempt.resolve();
      await copyAttempt.promise;
    });
  });

  it("keeps a credential-bearing clipboard error out of the app logger", async () => {
    const clipboardError = new Error(`Clipboard refused ${TOKEN}`);
    const loggerDelivery = Promise.withResolvers<void>();
    const writeText = vi.fn((_value: string) => Promise.reject(clipboardError));
    installClipboard(writeText);
    const loggerBackend = vi
      .spyOn(console, "error")
      .mockImplementation(() => loggerDelivery.resolve());
    render(<TeamComputerUnattended {...props({})} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy install token" }),
      );
      await loggerDelivery.promise;
    });

    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't copy. Copy the text manually.",
    );
    expect(loggerBackend).toHaveBeenCalledTimes(1);
    const loggedOutput = loggerBackend.mock.calls.flat().join(" ");
    expect(loggedOutput).not.toContain(TOKEN);
  });

  it("calls onMint once and disables another request while pending", () => {
    const onMint = vi.fn();
    const initialProps = props({ token: null, onMint });
    const { rerender } = render(<TeamComputerUnattended {...initialProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );
    expect(onMint).toHaveBeenCalledTimes(1);

    rerender(
      <TeamComputerUnattended
        {...initialProps}
        pending
        failure="Mint failed. Try again."
      />,
    );

    const button = screen.getByRole("button", { name: "Creating token…" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onMint).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Mint failed. Try again.",
    );
  });
});
