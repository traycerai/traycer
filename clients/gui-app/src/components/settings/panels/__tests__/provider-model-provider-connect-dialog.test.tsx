import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelProviderAuthResult,
  ModelProviderEntry,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { connectChoicesFor } from "@/components/settings/panels/model-provider-connect-model";
import { ProviderModelProviderConnectDialog } from "@/components/settings/panels/provider-model-provider-connect-dialog";
import { useModelProviderPendingAuthStore } from "@/stores/settings/model-provider-pending-auth-store";

type AuthCall = {
  readonly variables: unknown;
  readonly onSuccess: (data: { result: ModelProviderAuthResult }) => void;
  readonly onSettled: (() => void) | undefined;
  readonly onError: (() => void) | undefined;
};

type CancelCall = {
  readonly variables: unknown;
  readonly onSuccess: (data: {
    cancelled: boolean;
    result: ModelProviderAuthResult;
  }) => void;
  readonly onError: (() => void) | undefined;
};

type MutateOptions = {
  readonly onSuccess: AuthCall["onSuccess"];
  readonly onSettled?: () => void;
  readonly onError?: () => void;
};

const mocks = vi.hoisted(() => ({
  authCalls: [] as AuthCall[],
  awaitCalls: [] as AuthCall[],
  cancelCalls: [] as CancelCall[],
  openExternalLink: vi.fn(),
  authIsPending: false,
}));

vi.mock("@/hooks/providers/use-providers-model-provider-auth-mutation", () => ({
  useProvidersModelProviderAuth: () => ({
    mutate: (variables: unknown, options: MutateOptions) => {
      mocks.authCalls.push({
        variables,
        onSuccess: options.onSuccess,
        onSettled: options.onSettled,
        onError: options.onError,
      });
    },
    isPending: mocks.authIsPending,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-await-model-provider-auth-mutation",
  () => ({
    useProvidersAwaitModelProviderAuth: () => ({
      mutate: (variables: unknown, options: MutateOptions) => {
        mocks.awaitCalls.push({
          variables,
          onSuccess: options.onSuccess,
          onSettled: options.onSettled,
          onError: options.onError,
        });
      },
      isPending: false,
    }),
  }),
);

vi.mock(
  "@/hooks/providers/use-providers-cancel-model-provider-auth-mutation",
  () => ({
    useProvidersCancelModelProviderAuth: () => ({
      mutate: (
        variables: unknown,
        options: {
          onSuccess: CancelCall["onSuccess"];
          onError?: () => void;
        },
      ) => {
        mocks.cancelCalls.push({
          variables,
          onSuccess: options.onSuccess,
          onError: options.onError,
        });
      },
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ mutate: mocks.openExternalLink }),
}));

// Radix's Select needs a pointer-capable layout to open its listbox, which
// jsdom does not provide. The stand-in keeps the same element structure with
// every option always rendered, following the mock the host-workspace selector
// suites already use.
vi.mock("@/components/ui/select", () => ({
  Select: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectTrigger: (props: {
    readonly children: ReactNode;
    readonly id?: string;
  }) => (
    <button type="button" id={props.id}>
      {props.children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: {
    readonly children: ReactNode;
    readonly value: string;
  }) => <div data-value={props.value}>{props.children}</div>,
}));

const FULL_CAPS: ProviderModelProvidersCapabilities = {
  actions: ["connect", "oauth", "disconnect"],
};

function entry(overrides: Partial<ModelProviderEntry>): ModelProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    credentialKey: "ANTHROPIC_API_KEY",
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    connected: false,
    methods: [],
    ...overrides,
  };
}

function renderDialog(args: {
  readonly entry: ModelProviderEntry;
  readonly capabilities: ProviderModelProvidersCapabilities;
  readonly onDone: () => void;
}) {
  return render(
    <ProviderModelProviderConnectDialog
      open
      onOpenChange={() => {}}
      providerId="opencode"
      providerLabel="OpenCode"
      entry={args.entry}
      capabilities={args.capabilities}
      hostId="host-1"
      resumedAttempt={null}
      onDone={args.onDone}
    />,
  );
}

const OAUTH_ONLY = entry({
  id: "github-copilot",
  name: "GitHub Copilot",
  credentialKey: null,
  methods: [{ type: "oauth", label: "Sign in with GitHub", prompts: [] }],
});

/**
 * Resolves a recorded call the way TanStack does: `onSuccess`, then
 * `onSettled`. The second half matters - the poll schedules its NEXT tick from
 * `onSettled`, so a mock that skipped it would make single-flight polling look
 * like it had stopped after one request.
 */
function settle(call: AuthCall, result: ModelProviderAuthResult): void {
  act(() => {
    call.onSuccess({ result });
    call.onSettled?.();
  });
}

function settleCancel(
  call: CancelCall,
  data: { cancelled: boolean; result: ModelProviderAuthResult },
): void {
  act(() => {
    call.onSuccess(data);
  });
}

beforeEach(() => {
  mocks.authCalls.length = 0;
  mocks.awaitCalls.length = 0;
  mocks.cancelCalls.length = 0;
  mocks.authIsPending = false;
  mocks.openExternalLink.mockReset();
  useModelProviderPendingAuthStore.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("connectChoicesFor", () => {
  it("offers the plain API-key path only when the provider has a credential key", () => {
    // 3 of ~180 providers have none (multi-secret, or a service-account file),
    // and for those there is no single input the host's connect rule would
    // accept.
    expect(connectChoicesFor(entry({}), FULL_CAPS).map((c) => c.id)).toContain(
      "api-key",
    );
    expect(
      connectChoicesFor(entry({ credentialKey: null }), FULL_CAPS).map(
        (c) => c.id,
      ),
    ).not.toContain("api-key");
  });

  it("shows an advertised method the host cannot run as UNAVAILABLE, never hidden", () => {
    // "This provider offers OAuth, but not from here" is a fact the user is
    // entitled to; dropping the row would read as the provider not having it.
    const choices = connectChoicesFor(
      entry({
        methods: [
          { type: "oauth", label: "Sign in with Anthropic", prompts: [] },
        ],
      }),
      { actions: ["connect"] },
    );
    const oauth = choices.find((choice) => choice.kind === "oauth");
    expect(oauth?.unavailableReason).not.toBeNull();
  });

  it("drops the plain path when the provider ADVERTISES an api method", () => {
    // That method is the key path, with the extra fields it wants. Two "API
    // key" rows differing only in whether they ask the provider's own questions
    // is a choice nobody can make correctly.
    const choices = connectChoicesFor(
      entry({
        methods: [{ type: "api", label: "API key", prompts: [] }],
      }),
      FULL_CAPS,
    );
    expect(choices.map((choice) => choice.id)).toEqual(["method-0"]);
  });

  it("marks an api METHOD unusable when the provider has no credential key", () => {
    // An advertised `api` method still needs the one env-keyed input the host's
    // connect rule requires, and there is no such key to send.
    const choices = connectChoicesFor(
      entry({
        credentialKey: null,
        methods: [{ type: "api", label: "API key", prompts: [] }],
      }),
      FULL_CAPS,
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.unavailableReason).not.toBeNull();
  });
});

describe("connect with an API key", () => {
  it("sends exactly one input, keyed by the provider's credential key", () => {
    const onDone = vi.fn();
    renderDialog({ entry: entry({}), capabilities: FULL_CAPS, onDone });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: " sk-secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(mocks.authCalls).toHaveLength(1);
    expect(mocks.authCalls[0]?.variables).toEqual({
      providerId: "opencode",
      action: {
        action: "connect",
        modelProviderId: "anthropic",
        methodIndex: null,
        inputs: [{ key: "ANTHROPIC_API_KEY", value: "sk-secret" }],
      },
    });
  });

  it("keeps Connect disabled until a key is typed", () => {
    renderDialog({
      entry: entry({}),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    const submit = screen.getByRole("button", { name: "Connect" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "k" },
    });
    expect(
      screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("surfaces the host's invalid_input detail on the form", () => {
    const onDone = vi.fn();
    renderDialog({ entry: entry({}), capabilities: FULL_CAPS, onDone });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const call = mocks.authCalls[0];
    settle(call, {
      kind: "error",
      code: "invalid_input",
      detail: "No API key supplied (expected one of: ANTHROPIC_API_KEY)",
    });
    expect(
      screen.getByText(
        "No API key supplied (expected one of: ANTHROPIC_API_KEY)",
      ),
    ).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("closes on done", () => {
    const onDone = vi.fn();
    renderDialog({ entry: entry({}), capabilities: FULL_CAPS, onDone });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const call = mocks.authCalls[0];
    settle(call, { kind: "done" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("renders conditional prompt fields from the DSL", () => {
    renderDialog({
      entry: entry({
        credentialKey: "COPILOT_API_KEY",
        methods: [
          {
            type: "api",
            label: "API key",
            prompts: [
              {
                type: "text",
                key: "instanceUrl",
                message: "Instance URL",
                placeholder: null,
                when: { key: "deploymentType", op: "eq", value: "enterprise" },
              },
              {
                type: "text",
                key: "accountId",
                message: "Account id",
                placeholder: null,
                when: null,
              },
            ],
          },
        ],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    // `deploymentType` is not a prompt of this method, so nothing can satisfy
    // the condition and the field it guards stays off screen.
    expect(screen.queryByLabelText("Instance URL")).toBeNull();
    expect(screen.getByLabelText("Account id")).toBeTruthy();
  });
});

describe("method picker", () => {
  it("appears only when there is more than one way in", () => {
    // With one route the picker would be a control whose only job is to
    // display a constant.
    renderDialog({
      entry: entry({}),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(screen.queryByText("Sign-in method")).toBeNull();
    cleanup();

    renderDialog({
      entry: entry({
        methods: [
          { type: "oauth", label: "Sign in with Anthropic", prompts: [] },
        ],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(screen.getByText("Sign-in method")).toBeTruthy();
    expect(screen.getByText("Sign in with Anthropic")).toBeTruthy();
    // Twice on purpose: the picker option and the field label for the choice
    // that is currently selected.
    expect(screen.getAllByText("API key").length).toBeGreaterThan(1);
  });
});

describe("OAuth code flow", () => {
  it("opens the URL, shows the provider's instructions and takes a pasted code", () => {
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    expect(start.variables).toEqual({
      providerId: "opencode",
      action: {
        action: "startOauth",
        modelProviderId: "github-copilot",
        methodIndex: 0,
        inputs: [],
      },
    });

    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: "Enter code ABCD-1234",
    });
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://example.test/device",
    );
    expect(screen.getByText("Enter code ABCD-1234")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: " pasted-code " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(mocks.authCalls[1]?.variables).toEqual({
      providerId: "opencode",
      action: {
        action: "submitCode",
        modelProviderId: "github-copilot",
        attemptId: "attempt-1",
        code: "pasted-code",
      },
    });
  });

  it("re-prompts on code_rejected and KEEPS the attempt", () => {
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: null,
    });
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const submit = mocks.authCalls[1];
    settle(submit, {
      kind: "error",
      code: "code_rejected",
      detail: "OpenCode rejected that code",
    });

    // Still on the paste step - restarting would throw away an authorization
    // the host is still holding a server lease for.
    expect(screen.getByLabelText("Paste the code")).toBeTruthy();
    expect(screen.getByText("OpenCode rejected that code")).toBeTruthy();
    expect(useModelProviderPendingAuthStore.getState().entries).not.toEqual({});
  });

  it("offers a fresh start when the attempt expired", () => {
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: null,
    });
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: "late" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const submit = mocks.authCalls[1];
    settle(submit, {
      kind: "error",
      code: "attempt_expired",
      detail: "This sign-in timed out",
    });

    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText("This sign-in timed out")).toBeTruthy();
    expect(useModelProviderPendingAuthStore.getState().entries).toEqual({});
  });

  it("stands down SILENTLY when a newer attempt superseded this one", () => {
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: null,
    });
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: "stale" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const submit = mocks.authCalls[1];
    settle(submit, {
      kind: "error",
      code: "attempt_superseded",
      detail: "A newer sign-in attempt replaced this one",
    });

    // No error text: the newer attempt owns this provider's surface now, and
    // reporting it would accuse the user of breaking the flow they restarted.
    expect(
      screen.queryByText("A newer sign-in attempt replaced this one"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });
});

describe("OAuth auto flow", () => {
  it("polls until the browser round trip completes, opening the browser ONCE", () => {
    // The host answers a still-pending attempt with the STORED
    // `authorizationUrl`, not `{kind:"pending"}` - so this is the real wire
    // shape, and the one that used to reopen the sign-in tab every tick.
    vi.useFakeTimers();
    const onDone = vi.fn();
    renderDialog({ entry: OAUTH_ONLY, capabilities: FULL_CAPS, onDone });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    const pendingArm: ModelProviderAuthResult = {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    };
    settle(start, pendingArm);
    expect(mocks.openExternalLink).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Waiting for the browser to finish signing in"),
    ).toBeTruthy();
    // No paste field: this arm completes on the server's own loopback, and a
    // code box would invite a paste the host refuses as invalid_input.
    expect(screen.queryByLabelText("Paste the code")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    const poll = mocks.awaitCalls[0];
    expect(poll.variables).toEqual({
      providerId: "opencode",
      modelProviderId: "github-copilot",
      attemptId: "attempt-1",
    });
    settle(poll, pendingArm);
    expect(onDone).not.toHaveBeenCalled();

    // Several more ticks of the same still-pending answer.
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    const second = mocks.awaitCalls[1];
    settle(second, pendingArm);
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    const third = mocks.awaitCalls[2];
    expect(third).toBeDefined();
    settle(third, { kind: "done" });

    // ONE open for the whole flow: the start. Every tick after it refreshed
    // the panel and nothing else.
    expect(mocks.openExternalLink).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(useModelProviderPendingAuthStore.getState().entries).toEqual({});

    // Polling stops with the attempt.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.awaitCalls).toHaveLength(3);
  });

  it("is single-flight: no new poll while one is still open", () => {
    // A `setInterval` keeps firing through a slow request, stacking overlapping
    // polls on one attempt - each re-leasing the managed server this flow is
    // trying not to churn.
    vi.useFakeTimers();
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    settle(mocks.authCalls[0], {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    });

    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    expect(mocks.awaitCalls).toHaveLength(1);
    // The first poll never settles; time keeps passing.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mocks.awaitCalls).toHaveLength(1);
  });

  it("stops waiting on cancel and drops the pending attempt", () => {
    vi.useFakeTimers();
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    });
    const cancel = mocks.cancelCalls[0];
    expect(cancel.variables).toEqual({
      providerId: "opencode",
      modelProviderId: "github-copilot",
      attemptId: "attempt-1",
    });

    // Still waiting until the host CONFIRMS: an optimistic teardown would leave
    // a live attempt holding a server lease with no surface able to retry.
    expect(useModelProviderPendingAuthStore.getState().entries).not.toEqual({});
    settleCancel(cancel, { cancelled: true, result: { kind: "done" } });
    expect(useModelProviderPendingAuthStore.getState().entries).toEqual({});
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.awaitCalls).toHaveLength(0);
  });

  it("does NOT report a confirmed cancel as a successful connect", () => {
    // The host answers a real teardown with `{cancelled: true, result: done}`,
    // where `done` describes the CANCEL. Treating it as a credential result
    // would close the dialog claiming the provider had connected.
    vi.useFakeTimers();
    const onDone = vi.fn();
    renderDialog({ entry: OAUTH_ONLY, capabilities: FULL_CAPS, onDone });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    });
    const cancel = mocks.cancelCalls[0];
    settleCancel(cancel, { cancelled: true, result: { kind: "done" } });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("keeps the attempt when the cancel could not be delivered", () => {
    vi.useFakeTimers();
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    });
    const cancel = mocks.cancelCalls[0];
    act(() => {
      cancel.onError?.();
    });
    expect(
      screen.getByText("Couldn't stop the sign-in. Try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeTruthy();
    expect(useModelProviderPendingAuthStore.getState().entries).not.toEqual({});
  });

  it("applies the real outcome when the cancel found nothing pending", () => {
    // The browser callback landing while the click was in flight: nothing to
    // cancel, and `result` says the credential was actually written.
    vi.useFakeTimers();
    const onDone = vi.fn();
    renderDialog({ entry: OAUTH_ONLY, capabilities: FULL_CAPS, onDone });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const start = mocks.authCalls[0];
    settle(start, {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/auth",
      method: "auto",
      instructions: null,
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    });
    const cancel = mocks.cancelCalls[0];
    settleCancel(cancel, { cancelled: false, result: { kind: "done" } });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("no usable sign-in", () => {
  it("says so instead of rendering an empty picker", () => {
    renderDialog({
      entry: entry({
        id: "amazon-bedrock",
        name: "Amazon Bedrock",
        credentialKey: null,
        methods: [],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(
      screen.getByText(/advertises no sign-in method Traycer can drive/),
    ).toBeTruthy();
  });
});
