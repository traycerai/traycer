import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route as OnboardingRoute } from "@/routes/onboarding";
import { Route as IndexRoute } from "@/routes/index";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

type OnboardingBeforeLoadFn = (args: {
  context: { getAuthSnapshot: () => { status: string } };
  search: { replay: boolean };
}) => void;

type AuthBeforeLoadFn = (args: {
  context: { getAuthSnapshot: () => { status: string } };
}) => void;

/**
 * Calls a beforeLoad function, captures any thrown redirect, and returns it.
 * Returns null when the function completes without throwing.
 */
function callOnboardingBeforeLoad(
  fn: OnboardingBeforeLoadFn,
  status: string,
  replay: boolean,
): unknown {
  try {
    fn({
      context: { getAuthSnapshot: () => ({ status }) },
      search: { replay },
    });
    return null;
  } catch (err) {
    return err;
  }
}

function callAuthBeforeLoad(fn: AuthBeforeLoadFn, status: string): unknown {
  try {
    fn({ context: { getAuthSnapshot: () => ({ status }) } });
    return null;
  } catch (err) {
    return err;
  }
}

function assertRedirectTo(thrown: unknown, to: string): void {
  expect(thrown).not.toBeNull();
  expect(isRedirect(thrown)).toBe(true);
  const redirect = thrown as { options: { to: string; replace: boolean } };
  expect(redirect.options.to).toBe(to);
  expect(redirect.options.replace).toBe(true);
}

describe("/onboarding route — beforeLoad guard", () => {
  beforeEach(() => {
    useOnboardingStore.setState({ completedAt: null });
  });

  afterEach(() => {
    useOnboardingStore.setState({ completedAt: null });
  });

  it("redirects a signed-out user to /", () => {
    const beforeLoad = OnboardingRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    assertRedirectTo(
      callOnboardingBeforeLoad(
        beforeLoad as OnboardingBeforeLoadFn,
        "signed-out",
        false,
      ),
      "/",
    );
  });

  it("redirects a signed-in user who already completed the tour to /", () => {
    useOnboardingStore.setState({ completedAt: Date.now() });

    const beforeLoad = OnboardingRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    assertRedirectTo(
      callOnboardingBeforeLoad(
        beforeLoad as OnboardingBeforeLoadFn,
        "signed-in",
        false,
      ),
      "/",
    );
  });

  it("allows a signed-in user who already completed the tour to replay it", () => {
    useOnboardingStore.setState({ completedAt: Date.now() });

    const beforeLoad = OnboardingRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    expect(
      callOnboardingBeforeLoad(
        beforeLoad as OnboardingBeforeLoadFn,
        "signed-in",
        true,
      ),
    ).toBeNull();
  });

  it("does not redirect a signed-in first-launch user (completedAt is null)", () => {
    const beforeLoad = OnboardingRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    expect(
      callOnboardingBeforeLoad(
        beforeLoad as OnboardingBeforeLoadFn,
        "signed-in",
        false,
      ),
    ).toBeNull();
  });
});

describe("/ route — beforeLoad guard (onboarding is gated in RootComponent)", () => {
  beforeEach(() => {
    useOnboardingStore.setState({ completedAt: null });
  });

  afterEach(() => {
    useOnboardingStore.setState({ completedAt: null });
  });

  it("routes a first-launch user with no restored tabs onward to /draft/new", () => {
    const beforeLoad = IndexRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    assertRedirectTo(
      callAuthBeforeLoad(beforeLoad as AuthBeforeLoadFn, "signed-in"),
      "/draft/new",
    );
  });

  it("does not redirect a signed-out user (auth landing surface)", () => {
    const beforeLoad = IndexRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    expect(
      callAuthBeforeLoad(beforeLoad as AuthBeforeLoadFn, "signed-out"),
    ).toBeNull();
  });

  it("redirects a signed-in user who completed the tour to /draft/new", () => {
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });

    const beforeLoad = IndexRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    assertRedirectTo(
      callAuthBeforeLoad(beforeLoad as AuthBeforeLoadFn, "signed-in"),
      "/draft/new",
    );
  });
});
