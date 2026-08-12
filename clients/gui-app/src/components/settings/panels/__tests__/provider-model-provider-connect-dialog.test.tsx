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
// suites already use - and it forwards `onValueChange` so a test can pick an
// option by clicking it, which is what keeps non-default selections testable.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const ValueChangeContext = createContext<(value: string) => void>(() => {});
  return {
    Select: (props: {
      readonly children: ReactNode;
      readonly value?: string;
      readonly onValueChange?: (value: string) => void;
    }) => (
      <ValueChangeContext.Provider value={props.onValueChange ?? (() => {})}>
        <div>{props.children}</div>
      </ValueChangeContext.Provider>
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
    }) => {
      const onValueChange = useContext(ValueChangeContext);
      return (
        <button
          type="button"
          data-value={props.value}
          onClick={() => onValueChange(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});

const FULL_CAPS: ProviderModelProvidersCapabilities = {
  actions: ["connect", "oauth", "disconnect"],
};

function entry(overrides: Partial<ModelProviderEntry>): ModelProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    configDeclaredCustom: false,
    custom: null,
    connected: false,
    // What the host really sends when `/provider/auth` advertises nothing: it
    // synthesizes this generic key method itself, so the client never sees an
    // empty list for an ordinary provider.
    methods: [{ type: "api", label: "API key", prompts: [] }],
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
  it("maps the host's synthesized key method like any other", () => {
    // Synthesis is host-side now, so this only ever maps what it was given -
    // and every provider, Bedrock included, arrives with the same generic key
    // method rather than a classifier deciding who deserves one.
    expect(connectChoicesFor(entry({}), FULL_CAPS).map((c) => c.label)).toEqual(
      ["API key"],
    );
    expect(
      connectChoicesFor(
        entry({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
        FULL_CAPS,
      ).map((c) => c.label),
    ).toEqual(["API key"]);
  });

  it("offers NOTHING when the host offered nothing", () => {
    // An empty method list no longer means "we forgot to synthesize"; it means
    // the host had nothing for this provider, and inventing a field here would
    // put back the second source of truth the host now owns.
    expect(connectChoicesFor(entry({ methods: [] }), FULL_CAPS)).toEqual([]);
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
        methods: [
          { type: "api", label: "Manually enter API Key", prompts: [] },
        ],
      }),
      FULL_CAPS,
    );
    expect(choices.map((choice) => choice.id)).toEqual(["method-0"]);
  });

  it("drops the plain path for an OAUTH-ONLY provider that still has an env var", () => {
    // github-copilot, verified live: it advertises `['oauth']` and nothing
    // else, while carrying `env: ['GITHUB_TOKEN']`. That env entry is for
    // DETECTION, not a field to type into - Copilot needs the GitHub token
    // exchanged for a Copilot API token, which pasting cannot do. Every
    // provider that DOES accept a pasted key advertises an `api` arm of its own
    // (openai, xai, poe, gitlab, digitalocean, snowflake-cortex all do), so
    // "advertises any method" is the rule, not "advertises an api method".
    const choices = connectChoicesFor(
      entry({
        id: "github-copilot",
        name: "GitHub Copilot",
        methods: [
          { type: "oauth", label: "Login with GitHub Copilot", prompts: [] },
        ],
      }),
      FULL_CAPS,
    );
    expect(choices.map((choice) => choice.label)).toEqual([
      "Login with GitHub Copilot",
    ]);
  });

  it("leaves an advertised api method usable - nothing gates it now", () => {
    // This used to be marked unavailable whenever the classifier returned null
    // for the provider. The host takes the pasted value regardless, so the only
    // reason left to disable an `api` arm is the host withholding `connect`.
    const choices = connectChoicesFor(
      entry({
        methods: [
          { type: "api", label: "Manually enter API Key", prompts: [] },
        ],
      }),
      FULL_CAPS,
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.unavailableReason).toBeNull();
  });
});

describe("connect with an API key", () => {
  it("sends the pasted secret as `key`, with prompts as a keyed record", () => {
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
        // The host's synthesized key method is a real entry in `methods[]`, so
        // it is addressed by INDEX like any other. `methodIndex: null` still
        // reaches the same host path; we simply have an index to send now.
        methodIndex: 0,
        // `key` is the pasted SECRET - upstream's `ApiAuth.key`, which reads
        // like an identifier and is not one. No env-var name travels any more.
        key: "sk-secret",
        inputs: {},
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

  it("reveals a conditional field once its condition is met, and submits its value", () => {
    renderDialog({
      entry: entry({
        methods: [
          {
            type: "api",
            label: "API key",
            prompts: [
              {
                type: "select",
                key: "deploymentType",
                message: "Deployment",
                options: [
                  { label: "Cloud", value: "cloud", hint: null },
                  { label: "Enterprise", value: "enterprise", hint: null },
                ],
                when: null,
              },
              {
                type: "text",
                key: "instanceUrl",
                message: "Instance URL",
                placeholder: null,
                when: { key: "deploymentType", op: "eq", value: "enterprise" },
              },
            ],
          },
        ],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(screen.queryByLabelText("Instance URL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enterprise" }));
    fireEvent.change(screen.getByLabelText("Instance URL"), {
      target: { value: "https://ghe.example.test" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-enterprise" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(mocks.authCalls[0]?.variables).toEqual({
      providerId: "opencode",
      action: {
        action: "connect",
        modelProviderId: "anthropic",
        methodIndex: 0,
        key: "sk-enterprise",
        inputs: {
          deploymentType: "enterprise",
          instanceUrl: "https://ghe.example.test",
        },
      },
    });
  });
});

describe("credential precedence", () => {
  it("warns when something else already supplies the credential, naming it", () => {
    // Observed live: a stored openai OAuth credential still reports
    // `source: env` while OPENAI_API_KEY is exported. The sign-in is still
    // legitimate and still stored - it just will not take effect until the
    // variable is unset - so this is a warning, not a block.
    renderDialog({
      entry: entry({
        id: "openai",
        name: "OpenAI",
        connected: true,
        source: "env",
        methods: [{ type: "oauth", label: "ChatGPT Pro/Plus", prompts: [] }],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    // The variable's NAME went with `credentialKey`; the client cannot know it
    // without one, and guessing would be worse than the general statement.
    expect(
      screen.getByText(/environment variable on this host already provides/),
    ).toBeTruthy();
    // A warning, not a block: the sign-in is still offered.
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("names the provider in the config-file notice", () => {
    renderDialog({
      entry: entry({ connected: true, source: "config" }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(
      screen.getByText(/OpenCode's own config file already provides/),
    ).toBeTruthy();
  });

  it("says nothing for a provider Traycer itself holds the key for", () => {
    renderDialog({
      entry: entry({ connected: true, source: "api" }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    // "takes precedence" is the phrase every notice shares, so its absence is
    // the assertion that NO notice rendered - not that one particular wording
    // happened to change.
    expect(screen.queryByText(/takes precedence/)).toBeNull();
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

    // Two ways in means the provider ADVERTISED two - the real shape for
    // openai / xai / poe / gitlab, which pair an OAuth arm with an explicit
    // "Manually enter API Key" one.
    renderDialog({
      entry: entry({
        id: "xai",
        name: "xAI",
        methods: [
          { type: "oauth", label: "SuperGrok Subscription", prompts: [] },
          { type: "api", label: "Manually enter API Key", prompts: [] },
        ],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    expect(screen.getByText("Sign-in method")).toBeTruthy();
    expect(screen.getByText("SuperGrok Subscription")).toBeTruthy();
    expect(screen.getByText("Manually enter API Key")).toBeTruthy();
    // And no third, invented "API key" row beside the two it advertised.
    expect(screen.queryByText("API key")).toBeNull();
  });

  it("sends the picked method's own index, not the first one's", () => {
    // The second arm here is the API-key one, so a submit routed through
    // `methodIndex: 0` would send the pasted key down the OAuth arm.
    renderDialog({
      entry: entry({
        id: "xai",
        name: "xAI",
        methods: [
          { type: "oauth", label: "SuperGrok Subscription", prompts: [] },
          { type: "api", label: "Manually enter API Key", prompts: [] },
        ],
      }),
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Manually enter API Key" }),
    );
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-second-arm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(mocks.authCalls[0]?.variables).toEqual({
      providerId: "opencode",
      action: {
        action: "connect",
        modelProviderId: "xai",
        methodIndex: 1,
        key: "sk-second-arm",
        inputs: {},
      },
    });
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
        inputs: {},
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

  it("does not double-submit one attempt on two fast Enters", () => {
    // The button is disabled while the mutation is pending; the paste field's
    // Enter handler was not, so a second Enter sent the SAME attemptId again.
    // The host consumes the first, so the second returns a failure against an
    // attempt that actually succeeded - the user is told their code was
    // rejected when it was not.
    //
    // The dialog is RERENDERED rather than remounted: the mocked hook reads
    // `authIsPending` at render time, and a fresh mount would have no live
    // attempt at all - the second Enter would land on a Continue button and
    // the test would pass with the guard deleted.
    mocks.authIsPending = false;
    // A FACTORY, not a stored element: React bails out of a re-render when the
    // root element is referentially identical, so reusing one object would
    // leave the mocked hook's `isPending` at its old value and the test would
    // report a double-submit that never happened.
    const element = (): ReactNode => (
      <ProviderModelProviderConnectDialog
        open
        onOpenChange={() => {}}
        providerId="opencode"
        providerLabel="OpenCode"
        entry={OAUTH_ONLY}
        capabilities={FULL_CAPS}
        hostId="host-1"
        resumedAttempt={null}
        onDone={vi.fn()}
      />
    );
    const { rerender } = render(element());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    settle(mocks.authCalls[0], {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: null,
    });
    const field = screen.getByLabelText("Paste the code");
    fireEvent.change(field, { target: { value: "pasted-code" } });

    fireEvent.keyDown(field, { key: "Enter" });
    expect(mocks.authCalls).toHaveLength(2);

    // Same dialog, same live attempt, submit now in flight.
    mocks.authIsPending = true;
    rerender(element());
    expect(screen.getByLabelText("Paste the code")).toBe(field);

    fireEvent.keyDown(field, { key: "Enter" });
    expect(mocks.authCalls).toHaveLength(2);
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
  it("promotes a transcribable confirmation code to a copyable field", () => {
    // Some `auto` flows want the user to READ a code off this screen and type
    // it into the browser. The instructions stay above it verbatim; this only
    // lifts the fragment that has to be transcribed.
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
      instructions: "Enter this code in your browser: ABCD-1234",
    });

    const field = screen.getByLabelText("Confirmation code");
    expect(
      field.getAttribute("value") ?? (field as HTMLInputElement).value,
    ).toBe("ABCD-1234");
    expect(field.hasAttribute("readonly")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Copy confirmation code" }),
    ).toBeTruthy();
    // The provider's own wording is still shown in full above it.
    expect(
      screen.getByText("Enter this code in your browser: ABCD-1234"),
    ).toBeTruthy();
  });

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
    // Nothing code-shaped in these instructions, so no field is invented.
    expect(screen.queryByLabelText("Confirmation code")).toBeNull();

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

  it.each([
    ["provider_auth_failed", "OpenCode rejected the sign-in"],
    ["server_unavailable", "the server went away"],
  ] as const)(
    "ends the attempt when a poll reports a terminal %s",
    (code, detail) => {
      // The host only answers a status read this way once the background
      // callback has already failed and released its lease - the row is
      // settled. Reporting it while the panel keeps saying "Waiting" strands
      // the user: nothing further arrives, and Stop waiting has no live
      // attempt left to cancel.
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
      settle(mocks.awaitCalls[0], { kind: "error", code, detail });

      // Back to a fresh start, with the reason kept on screen.
      expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
      expect(
        screen.queryByText("Waiting for the browser to finish signing in"),
      ).toBeNull();
      expect(useModelProviderPendingAuthStore.getState().entries).toEqual({});

      // And the poll is stopped, not merely quiet for one tick.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(mocks.awaitCalls).toHaveLength(1);
    },
  );

  it("keeps a submit-code failure ADVISORY, with the attempt still live", () => {
    // The same disposition, the opposite meaning: a submit reports against an
    // attempt the host is still holding, so the user can act on it again.
    renderDialog({
      entry: OAUTH_ONLY,
      capabilities: FULL_CAPS,
      onDone: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    settle(mocks.authCalls[0], {
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/device",
      method: "code",
      instructions: null,
    });
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: "some-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    settle(mocks.authCalls[1], {
      kind: "error",
      code: "provider_auth_failed",
      detail: "the provider refused it",
    });

    expect(screen.getByLabelText("Paste the code")).toBeTruthy();
    expect(screen.getByText("the provider refused it")).toBeTruthy();
    expect(useModelProviderPendingAuthStore.getState().entries).not.toEqual({});
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
