import { Fragment, StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RetainedStepUpVerifyFetchResult,
  StepUpChallengeFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import type { StepUpCredential } from "@/lib/auth/step-up-flow";
import type { StepUpPromptRequest } from "@/lib/auth/step-up-prompt";

// The REAL mutation stack: `useMutation`'s observers and the dialog on top of
// them. Only the auth transport under `useHostBinding()` is faked, because the
// defect is TanStack detaching an observer from a mutation fired in the mount
// pass - which no fake of the mutation hooks themselves can show.
const auth = vi.hoisted(() => ({
  requestStepUpChallenge: vi.fn<() => Promise<StepUpChallengeFetchResult>>(),
  verifyStepUpChallenge:
    vi.fn<(code: string) => Promise<RetainedStepUpVerifyFetchResult>>(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  const binding = { auth };
  return { ...actual, useHostBinding: () => binding };
});

import { StepUpChallengeDialog } from "@/components/auth/step-up-challenge-dialog";

const SENT: StepUpChallengeFetchResult = {
  kind: "ok",
  response: { ok: true, expires_in: 600 },
};

function prompt(): StepUpPromptRequest {
  return {
    id: 1,
    purpose: "session-revoke",
    subjectLabel: null,
    resolve: () => undefined,
    reject: () => undefined,
  };
}

/** The desktop renderer mounts under `<StrictMode>`, so the dev builds run
 *  every mount effect setup -> cleanup -> setup. Production runs it once;
 *  the dialog has to work in both. */
const MOUNT_MODES = [
  { name: "under StrictMode", Wrapper: StrictMode },
  { name: "without StrictMode", Wrapper: Fragment },
] as const;

function renderDialog(
  Wrapper: (props: { readonly children: ReactNode }) => ReactNode,
  onVerified: (credential: StepUpCredential) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <Wrapper>
      <QueryClientProvider client={queryClient}>
        <StepUpChallengeDialog
          request={prompt()}
          onVerified={onVerified}
          onCancel={() => undefined}
        />
      </QueryClientProvider>
    </Wrapper>,
  );
}

function codeField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Email code");
}

beforeEach(() => {
  auth.requestStepUpChallenge.mockResolvedValue(SENT);
  auth.verifyStepUpChallenge.mockResolvedValue({
    kind: "ok",
    response: { expires_in: 300 },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(MOUNT_MODES)("<StepUpChallengeDialog /> $name", ({ Wrapper }) => {
  it("sends one code on open, then leaves 'Sending code' for the code field", async () => {
    renderDialog(Wrapper, vi.fn());

    expect(
      await screen.findByText("Check your email for the verification code."),
    ).toBeTruthy();
    expect(screen.queryByText("Sending code")).toBeNull();
    expect(codeField().disabled).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Resend code" })
        .hasAttribute("disabled"),
    ).toBe(false);
    // One email per prompt, whatever the mount pass does.
    expect(auth.requestStepUpChallenge).toHaveBeenCalledTimes(1);
  });

  it("hands the verified credential back once the code is accepted", async () => {
    const onVerified = vi.fn<(credential: StepUpCredential) => void>();
    renderDialog(Wrapper, onVerified);
    await screen.findByText("Check your email for the verification code.");

    fireEvent.change(codeField(), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(auth.verifyStepUpChallenge).toHaveBeenCalledWith("123456");
    // 300 s from the verify response, less the client's small expiry skew.
    const credential = onVerified.mock.calls.at(0)?.[0];
    expect(credential?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("says a failed send inline and sends again from Resend code", async () => {
    auth.requestStepUpChallenge.mockResolvedValueOnce({
      kind: "network-error",
    });
    renderDialog(Wrapper, vi.fn());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't send a verification code. Try again.",
    );
    expect(screen.queryByText("Sending code")).toBeNull();
    const resend = screen.getByRole("button", { name: "Resend code" });
    expect(resend.hasAttribute("disabled")).toBe(false);

    fireEvent.click(resend);

    expect(
      await screen.findByText("Check your email for the verification code."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(auth.requestStepUpChallenge).toHaveBeenCalledTimes(2);
    expect(codeField().disabled).toBe(false);
  });

  it("consumes a failed send that lands after the dialog unmounted", async () => {
    let fail: (error: Error) => void = () => undefined;
    auth.requestStepUpChallenge.mockImplementation(
      () =>
        new Promise<StepUpChallengeFetchResult>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { unmount } = renderDialog(Wrapper, vi.fn());
      await waitFor(() =>
        expect(auth.requestStepUpChallenge).toHaveBeenCalledTimes(1),
      );
      unmount();

      fail(new Error("offline"));
      // Node reports an unhandled rejection only once the microtasks that
      // produced it have drained, so give it two macrotask turns.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
