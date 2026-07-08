import { describe, expect, it, vi } from "vitest";
import {
  StepUpRequiredError,
  createStepUpCredential,
  getActiveStepUpCredential,
  runStepUpProtectedAction,
  type StepUpCredential,
} from "../step-up-flow";

describe("gui-app step-up flow helper", () => {
  it("uses an active cached credential without requesting a new challenge", async () => {
    const cached: StepUpCredential = {
      accessToken: "step-up-cached",
      expiresAtMs: Date.now() + 60_000,
    };
    let stored: StepUpCredential | null = cached;
    const action = vi.fn((accessToken: string | null) =>
      Promise.resolve(accessToken),
    );
    const requestCredential = vi.fn(() =>
      Promise.reject(new Error("unexpected challenge")),
    );

    await expect(
      runStepUpProtectedAction({
        getCredential: () => stored,
        setCredential: (credential) => {
          stored = credential;
        },
        requestCredential,
        action,
      }),
    ).resolves.toBe("step-up-cached");

    expect(requestCredential).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("re-challenges once when the server rejects the cached credential as stale", async () => {
    let stored: StepUpCredential | null = {
      accessToken: "step-up-stale",
      expiresAtMs: Date.now() + 60_000,
    };
    const fresh: StepUpCredential = {
      accessToken: "step-up-fresh",
      expiresAtMs: Date.now() + 120_000,
    };
    const action = vi.fn((accessToken: string | null) => {
      if (accessToken === "step-up-stale") {
        return Promise.reject(new StepUpRequiredError());
      }
      return Promise.resolve(accessToken);
    });

    await expect(
      runStepUpProtectedAction({
        getCredential: () => stored,
        setCredential: (credential) => {
          stored = credential;
        },
        requestCredential: () => Promise.resolve(fresh),
        action,
      }),
    ).resolves.toBe("step-up-fresh");

    expect(action).toHaveBeenCalledTimes(2);
    expect(stored).toBe(fresh);
  });

  it("does not loop if a retry also requires step-up", async () => {
    let stored: StepUpCredential | null = {
      accessToken: "step-up-stale",
      expiresAtMs: Date.now() + 60_000,
    };
    const action = vi.fn(() => Promise.reject(new StepUpRequiredError()));

    await expect(
      runStepUpProtectedAction({
        getCredential: () => stored,
        setCredential: (credential) => {
          stored = credential;
        },
        requestCredential: () =>
          Promise.resolve({
            accessToken: "step-up-fresh",
            expiresAtMs: Date.now() + 120_000,
          }),
        action,
      }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    expect(action).toHaveBeenCalledTimes(2);
    expect(stored).toBeNull();
  });

  it("derives the local expiry from the server expires_in value", () => {
    expect(
      createStepUpCredential(
        {
          access_token: "step-up",
          token_type: "Bearer",
          expires_in: 17,
        },
        1_000,
      ),
    ).toEqual({ accessToken: "step-up", expiresAtMs: 18_000 });
  });

  it("treats credentials inside the expiry skew as inactive", () => {
    expect(
      getActiveStepUpCredential(
        { accessToken: "step-up", expiresAtMs: 10_000 },
        6_000,
      ),
    ).toBeNull();
  });
});
