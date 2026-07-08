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
      expiresAtMs: Date.now() + 60_000,
    };
    let stored: StepUpCredential | null = cached;
    const action = vi.fn((useStepUpCredential: boolean) =>
      Promise.resolve(useStepUpCredential),
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
        nowMs: () => Date.now(),
      }),
    ).resolves.toBe(true);

    expect(requestCredential).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("re-challenges once when the server rejects the cached credential as stale", async () => {
    let stored: StepUpCredential | null = {
      expiresAtMs: Date.now() + 60_000,
    };
    const fresh: StepUpCredential = {
      expiresAtMs: Date.now() + 120_000,
    };
    let attempts = 0;
    const action = vi.fn((useStepUpCredential: boolean) => {
      attempts += 1;
      if (attempts === 1 && useStepUpCredential) {
        return Promise.reject(new StepUpRequiredError());
      }
      return Promise.resolve(useStepUpCredential);
    });

    await expect(
      runStepUpProtectedAction({
        getCredential: () => stored,
        setCredential: (credential) => {
          stored = credential;
        },
        requestCredential: () => Promise.resolve(fresh),
        action,
        nowMs: () => Date.now(),
      }),
    ).resolves.toBe(true);

    expect(action).toHaveBeenCalledTimes(2);
    expect(stored).toBe(fresh);
  });

  it("does not loop if a retry also requires step-up", async () => {
    let stored: StepUpCredential | null = {
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
            expiresAtMs: Date.now() + 120_000,
          }),
        action,
        nowMs: () => Date.now(),
      }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    expect(action).toHaveBeenCalledTimes(2);
    expect(stored).toBeNull();
  });

  it("derives the local expiry from the server expires_in value", () => {
    expect(
      createStepUpCredential(
        {
          expires_in: 17,
        },
        1_000,
      ),
    ).toEqual({ expiresAtMs: 13_000 });
  });

  it("treats expired credentials as inactive", () => {
    expect(
      getActiveStepUpCredential({ expiresAtMs: 10_000 }, 10_000),
    ).toBeNull();
  });

  it("filters stale credentials inside the helper before running the action", async () => {
    let stored: StepUpCredential | null = { expiresAtMs: 10_000 };
    const action = vi.fn((useStepUpCredential: boolean) =>
      Promise.resolve(useStepUpCredential),
    );

    await expect(
      runStepUpProtectedAction({
        getCredential: () => stored,
        setCredential: (credential) => {
          stored = credential;
        },
        requestCredential: () => Promise.reject(new Error("unexpected")),
        action,
        nowMs: () => 10_000,
      }),
    ).resolves.toBe(false);

    expect(action).toHaveBeenCalledWith(false);
  });
});
