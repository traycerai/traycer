import "../../../../../__tests__/test-browser-apis";
import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderMcpAuthWrite } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderMcpAddDialog } from "@/components/settings/panels/provider-mcp-add-dialog";
import type { McpMutateVariables } from "@/hooks/providers/use-providers-mcp-mutate-mutation";

type MutateOptions = {
  readonly onSuccess: () => void;
  readonly onError: (error: unknown) => void;
};

const mcpMocks = vi.hoisted(() => ({
  mutate:
    vi.fn<(variables: McpMutateVariables, options: MutateOptions) => void>(),
  mutateAsync: vi.fn(),
  reset: vi.fn(),
  mutateIsPending: false,
}));

vi.mock("@/hooks/providers/use-providers-mcp-mutate-mutation", () => ({
  useProvidersMcpMutate: () => ({
    mutate: mcpMocks.mutate,
    mutateAsync: mcpMocks.mutateAsync,
    reset: mcpMocks.reset,
    isPending: mcpMocks.mutateIsPending,
  }),
}));

const BOTH_SCOPES = ["global", "project"] as const;

const REMOTE_HTTP_SSE_CAPS: ProviderMcpCapabilities = {
  transports: ["http", "sse"],
  authTypes: ["none", "header", "oauth"],
  authActions: ["login", "logout"],
  actionScopes: {
    list: [...BOTH_SCOPES],
    add: [...BOTH_SCOPES],
    update: [...BOTH_SCOPES],
    remove: [...BOTH_SCOPES],
    toggleServer: [...BOTH_SCOPES],
    toggleTool: [...BOTH_SCOPES],
    discover: [...BOTH_SCOPES],
    auth: [...BOTH_SCOPES],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  // Matches amp's real capability post round-2 fix: repeatable headers,
  // no Add-time OAuth fields (OAuth completes via a separate login action).
  supportsMultipleHeaders: true,
  oauthFields: [],
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};

const CODEX_CAPS: ProviderMcpCapabilities = {
  ...REMOTE_HTTP_SSE_CAPS,
  transports: ["stdio", "http"],
  authTypes: ["none", "env", "oauth"],
  supportsMultipleHeaders: false,
  oauthFields: ["clientId", "resource"],
};

const STDIO_ONLY_CAPS: ProviderMcpCapabilities = {
  ...REMOTE_HTTP_SSE_CAPS,
  transports: ["stdio"],
  authTypes: ["none"],
};

const FULL_CAPS: ProviderMcpCapabilities = {
  ...REMOTE_HTTP_SSE_CAPS,
  transports: ["stdio", "http", "sse"],
};

/** A genuinely single-header provider: capability declares multiplicity=1. */
const SINGLE_HEADER_CAPS: ProviderMcpCapabilities = {
  ...REMOTE_HTTP_SSE_CAPS,
  supportsMultipleHeaders: false,
};

function expectAddTransport(
  call: McpMutateVariables,
): Extract<McpMutateVariables["mutation"], { action: "add" }>["transport"] {
  if (call.mutation.action !== "add") {
    throw new Error(
      `expected an "add" mutation, got "${call.mutation.action}"`,
    );
  }
  return call.mutation.transport;
}

function expectRemoteAuth(
  call: McpMutateVariables,
): ProviderMcpAuthWrite | null {
  const transport = expectAddTransport(call);
  if (transport.type === "stdio") {
    throw new Error("expected a remote transport");
  }
  return transport.auth;
}

function renderDialog(args: {
  readonly capabilities: ProviderMcpCapabilities;
  readonly providerId: "codex" | "amp" | "qwen";
  readonly mode: "add" | "edit";
  readonly initialServer: ProviderMcpServer | null;
  readonly existingNames: readonly string[];
}) {
  const onOpenChange = vi.fn();
  render(
    <ProviderMcpAddDialog
      open
      onOpenChange={onOpenChange}
      mode={args.mode}
      initialServer={args.initialServer}
      providerLabel={args.providerId}
      capabilities={args.capabilities}
      existingNames={args.existingNames}
      scopeTuple={{
        providerId: args.providerId,
        scope: "global",
        workspaceRoot: null,
      }}
      onAdded={null}
    />,
  );
  return { onOpenChange };
}

describe("<ProviderMcpAddDialog />", () => {
  beforeEach(() => {
    mcpMocks.mutate.mockReset();
    mcpMocks.reset.mockReset();
    mcpMocks.mutateIsPending = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("every input has an accessible name via role queries (remote, header auth)", () => {
    renderDialog({
      capabilities: FULL_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeDefined();
    expect(
      within(dialog).getByRole("textbox", { name: "Server URL" }),
    ).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Header" }));
    expect(
      within(dialog).getByRole("textbox", { name: "Header 1 name" }),
    ).toBeDefined();
    // type="password" values aren't exposed under role="textbox" — assert
    // via label text instead (still a real accessible-name association).
    expect(within(dialog).getByLabelText("Header 1 value")).toBeDefined();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Local (stdio)" }),
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Command" }),
    ).toBeDefined();
    expect(within(dialog).getByRole("textbox", { name: "Args" })).toBeDefined();
    // Env vars is a per-row masked KEY/value editor, not a single textbox.
    expect(
      within(dialog).getByRole("textbox", { name: "Env var 1 name" }),
    ).toBeDefined();
    expect(within(dialog).getByLabelText("Env var 1 value")).toBeDefined();
  });

  it("serializes every header row, not just the first", () => {
    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "srv" },
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Server URL" }),
      { target: { value: "https://mcp.example.com" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Header" }));
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Header 1 name" }),
      { target: { value: "Authorization" } },
    );
    fireEvent.change(within(dialog).getByLabelText("Header 1 value"), {
      target: { value: "Bearer one" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add header" }));
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Header 2 name" }),
      { target: { value: "X-Api-Key" } },
    );
    fireEvent.change(within(dialog).getByLabelText("Header 2 value"), {
      target: { value: "two" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));

    expect(mcpMocks.mutate).toHaveBeenCalledTimes(1);
    const call = mcpMocks.mutate.mock.calls[0][0];
    expect(expectRemoteAuth(call)).toEqual({
      type: "header",
      name: "Authorization",
      value: "Bearer one",
      additionalHeaders: [{ name: "X-Api-Key", value: "two" }],
    });
  });

  it("codex env auth sends only an env-var name reference, never a value field", () => {
    renderDialog({
      capabilities: CODEX_CAPS,
      providerId: "codex",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "srv" },
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Server URL" }),
      { target: { value: "https://mcp.example.com" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Env var" }));
    expect(
      within(dialog).getByRole("textbox", {
        name: "Environment variable name",
      }),
    ).toBeDefined();
    fireEvent.change(
      within(dialog).getByRole("textbox", {
        name: "Environment variable name",
      }),
      { target: { value: "GITHUB_TOKEN" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));

    expect(mcpMocks.mutate).toHaveBeenCalledTimes(1);
    const call = mcpMocks.mutate.mock.calls[0][0];
    expect(expectRemoteAuth(call)).toEqual({
      type: "env",
      name: "GITHUB_TOKEN",
      value: "",
    });
  });

  it("shows OAuth client id/resource fields only for codex, not other providers", () => {
    renderDialog({
      capabilities: CODEX_CAPS,
      providerId: "codex",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const codexDialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.click(within(codexDialog).getByRole("button", { name: "OAuth" }));
    expect(
      within(codexDialog).getByRole("textbox", {
        name: "OAuth client ID (optional)",
      }),
    ).toBeDefined();
    cleanup();

    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const ampDialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.click(within(ampDialog).getByRole("button", { name: "OAuth" }));
    expect(
      within(ampDialog).queryByRole("textbox", {
        name: "OAuth client ID (optional)",
      }),
    ).toBeNull();
  });

  it("renders exactly the OAuth fields the capability declares, not a binary allowlist", () => {
    const RESOURCE_ONLY_OAUTH_CAPS: ProviderMcpCapabilities = {
      ...CODEX_CAPS,
      oauthFields: ["resource"],
    };
    renderDialog({
      capabilities: RESOURCE_ONLY_OAUTH_CAPS,
      providerId: "codex",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "OAuth" }));
    expect(
      within(dialog).queryByRole("textbox", {
        name: "OAuth client ID (optional)",
      }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("textbox", {
        name: "OAuth resource (optional)",
      }),
    ).toBeDefined();
  });

  it("lets the user pick SSE instead of always forcing HTTP", () => {
    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "srv" },
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Server URL" }),
      { target: { value: "https://mcp.example.com" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "SSE" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));

    expect(mcpMocks.mutate).toHaveBeenCalledTimes(1);
    const call = mcpMocks.mutate.mock.calls[0][0];
    expect(expectAddTransport(call).type).toBe("sse");
  });

  it("does not offer a transport-kind chip when only stdio is supported", () => {
    renderDialog({
      capabilities: STDIO_ONLY_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    expect(within(dialog).queryByRole("button", { name: "Remote" })).toBeNull();
    expect(
      within(dialog).getByRole("textbox", { name: "Command" }),
    ).toBeDefined();
  });

  it("never prefills header values in cleartext on Edit, but does prefill the non-secret name (N1)", () => {
    const server: ProviderMcpServer = {
      name: "srv",
      enabled: true,
      transport: {
        type: "http",
        url: "https://mcp.example.com",
        auth: { type: "header", name: "Authorization", hasValue: true },
      },
      status: "connected",
      statusSource: "probe",
      statusDetail: null,
      tools: [],
      discoveryPending: false,
      instructions: null,
      configOnly: false,
      stdioDegraded: false,
    };
    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "edit",
      initialServer: server,
      existingNames: ["srv"],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    const valueInput =
      within(dialog).getByLabelText<HTMLInputElement>("Header 1 value");
    expect(valueInput.value).toBe("");
    expect(valueInput.type).toBe("password");
    const nameInput = within(dialog).getByRole<HTMLInputElement>("textbox", {
      name: "Header 1 name",
    });
    expect(nameInput.value).toBe("Authorization");
    expect(
      within(dialog).getByText(
        "For your security the existing secret isn't shown; re-enter it to save.",
      ),
    ).toBeDefined();
  });

  it("prefills the non-secret env-var name on Edit for env auth, value stays empty (N1)", () => {
    const server: ProviderMcpServer = {
      name: "srv",
      enabled: true,
      transport: {
        type: "http",
        url: "https://mcp.example.com",
        auth: { type: "env", name: "GITHUB_TOKEN", hasValue: true },
      },
      status: "connected",
      statusSource: "probe",
      statusDetail: null,
      tools: [],
      discoveryPending: false,
      instructions: null,
      configOnly: false,
      stdioDegraded: false,
    };
    renderDialog({
      capabilities: CODEX_CAPS,
      providerId: "codex",
      mode: "edit",
      initialServer: server,
      existingNames: ["srv"],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    const nameInput = within(dialog).getByRole<HTMLInputElement>("textbox", {
      name: "Environment variable name",
    });
    expect(nameInput.value).toBe("GITHUB_TOKEN");
  });

  it("gates the 'Add header' affordance off capability.supportsMultipleHeaders (no row silently dropped)", () => {
    renderDialog({
      capabilities: SINGLE_HEADER_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Header" }));
    expect(
      within(dialog).getByRole("textbox", { name: "Header 1 name" }),
    ).toBeDefined();
    expect(
      within(dialog).queryByRole("button", { name: "Add header" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Remove header 1" }),
    ).toBeNull();
  });

  it("clears the mutation cache (mutate.reset) when the dialog closes", () => {
    const { onOpenChange } = renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mcpMocks.reset).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("serializes every stdio env row via a masked per-row editor, not a cleartext textarea", () => {
    renderDialog({
      capabilities: STDIO_ONLY_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "srv" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Command" }), {
      target: { value: "npx" },
    });
    const firstValueInput =
      within(dialog).getByLabelText<HTMLInputElement>("Env var 1 value");
    expect(firstValueInput.type).toBe("password");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Env var 1 name" }),
      { target: { value: "GITHUB_TOKEN" } },
    );
    fireEvent.change(firstValueInput, { target: { value: "ghp_one" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add env var" }),
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Env var 2 name" }),
      { target: { value: "FOO" } },
    );
    fireEvent.change(within(dialog).getByLabelText("Env var 2 value"), {
      target: { value: "bar" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));

    expect(mcpMocks.mutate).toHaveBeenCalledTimes(1);
    const call = mcpMocks.mutate.mock.calls[0][0];
    const transport = expectAddTransport(call);
    if (transport.type !== "stdio") {
      throw new Error("expected a stdio transport");
    }
    expect(transport.env).toEqual([
      { name: "GITHUB_TOKEN", value: "ghp_one" },
      { name: "FOO", value: "bar" },
    ]);
  });

  it("caps dialog height and scrolls the body instead of overflowing", () => {
    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    expect(dialog.className).toContain("max-h-[min(85vh,42rem)]");
    expect(dialog.className).toContain("overflow-hidden");
  });

  it("hand-rolls the footer instead of DialogFooter's p-4-only negative margins", () => {
    renderDialog({
      capabilities: REMOTE_HTTP_SSE_CAPS,
      providerId: "amp",
      mode: "add",
      initialServer: null,
      existingNames: [],
    });
    const addButton = screen.getByRole("button", { name: "Add server" });
    const footer = addButton.parentElement;
    expect(footer).not.toBeNull();
    expect(footer?.className).not.toContain("-mx-4");
    expect(footer?.className).not.toContain("-mb-4");
    expect(footer?.className).toContain("border-t");
  });
});
