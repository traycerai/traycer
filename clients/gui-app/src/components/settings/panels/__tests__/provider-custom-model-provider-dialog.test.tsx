import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCustomModelProviderDialog } from "@/components/settings/panels/provider-custom-model-provider-dialog";
import type { CustomProviderValues } from "@/components/settings/panels/model-provider-custom-draft";

const mocks = vi.hoisted(() => ({ openExternalLink: vi.fn() }));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ mutate: mocks.openExternalLink }),
}));

function renderDialog(args: {
  readonly initial: CustomProviderValues | null;
  readonly takenIds: readonly string[];
  readonly disabledIds: readonly string[];
  readonly onSubmit: (values: CustomProviderValues) => void;
  readonly submitError: string | null;
}) {
  return render(
    <ProviderCustomModelProviderDialog
      open
      onOpenChange={() => {}}
      providerLabel="OpenCode"
      takenIds={args.takenIds}
      disabledIds={args.disabledIds}
      initial={args.initial}
      isPending={false}
      submitError={args.submitError}
      onSubmit={args.onSubmit}
    />,
  );
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function typeNth(label: string, index: number, value: string): void {
  fireEvent.change(screen.getAllByLabelText(label)[index], {
    target: { value },
  });
}

function fillValidForm(): void {
  type("Provider ID", "myprovider");
  type("Display name", "My AI Provider");
  type("Base URL", "https://api.myprovider.com/v1");
  typeNth("ID", 0, "model-id");
  typeNth("Name", 0, "Display Name");
}

beforeEach(() => {
  mocks.openExternalLink.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("custom model provider dialog", () => {
  it("shows upstream's fields, in upstream's words", () => {
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    expect(screen.getByText("Custom provider")).toBeTruthy();
    expect(
      screen.getByText(/Configure an OpenAI-compatible provider/),
    ).toBeTruthy();
    expect(
      screen.getByText("Lowercase letters, numbers, hyphens, or underscores"),
    ).toBeTruthy();
    expect(
      screen.getByText("Optional. Leave empty if you manage auth via headers."),
    ).toBeTruthy();
    expect(screen.getByText("Models")).toBeTruthy();
    expect(screen.getByText("Headers (optional)")).toBeTruthy();
    for (const placeholder of [
      "myprovider",
      "My AI Provider",
      "https://api.myprovider.com/v1",
      "model-id",
      "Display Name",
      "Header-Name",
      "value",
    ]) {
      expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
    }
  });

  it("hands the docs link to the shell", () => {
    // The renderer has no browser to navigate; the shell owns external links.
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    fireEvent.click(screen.getByText("provider config docs"));
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://opencode.ai/docs/providers/#custom-provider",
    );
  });

  it("sends models, headers and the key in the wire's shape", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    fillValidForm();
    type("API key", "sk-live-123");
    typeNth("Header", 0, "X-Org");
    typeNth("Value", 0, "acme");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "https://api.myprovider.com/v1",
      models: [{ id: "model-id", name: "Display Name" }],
      headers: [{ key: "X-Org", value: "acme" }],
      key: "sk-live-123",
      env: [],
    });
  });

  it("parses {env:VAR} into a reference rather than a secret", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    fillValidForm();
    type("API key", "{env:MY_KEY}");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      key: null,
      env: ["MY_KEY"],
    });
  });

  it("adds and removes model rows, keeping the last one", () => {
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    // Upstream disables the trash on a single row: the section is required.
    expect(
      screen
        .getByRole("button", { name: "Remove model 1" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(screen.getAllByPlaceholderText("model-id")).toHaveLength(2);
    expect(
      screen
        .getByRole("button", { name: "Remove model 1" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove model 2" }));
    expect(screen.getAllByPlaceholderText("model-id")).toHaveLength(1);
  });

  it("stays live on a blank form and reports everything on the first attempt", () => {
    // Upstream's shape, and the reason for it: a Submit disabled until valid is
    // a dead button on a blank form whose reasons are exactly the errors a
    // blank form has. Nothing is red until asked.
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Provider ID is required")).toBeNull();

    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Provider ID is required")).toBeTruthy();
    expect(screen.getByText("Display name is required")).toBeTruthy();
    expect(screen.getByText("Base URL is required")).toBeTruthy();
    // Including the row lists - a model row needs both halves.
    expect(screen.getAllByText("Required").length).toBeGreaterThanOrEqual(2);

    fillValidForm();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("refuses a model row missing its display name", () => {
    // Upstream's rule, not ours: the config's model map carries a name per id.
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    fillValidForm();
    typeNth("Name", 0, "");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText("Required").length).toBeGreaterThanOrEqual(1);
  });

  it("refuses an id that already exists, unless it is disabled", () => {
    const { unmount } = renderDialog({
      initial: null,
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    type("Provider ID", "myprovider");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("That provider ID already exists")).toBeTruthy();
    unmount();

    // Re-declaring into a DISABLED id is upstream's re-enable.
    renderDialog({
      initial: null,
      takenIds: ["myprovider"],
      disabledIds: ["myprovider"],
      onSubmit: vi.fn(),
      submitError: null,
    });
    type("Provider ID", "myprovider");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.queryByText("That provider ID already exists")).toBeNull();
  });

  it("opens an edit on the row's values, with the key field empty", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: {
        modelProviderId: "myprovider",
        name: "My AI Provider",
        baseUrl: "https://api.myprovider.com/v1",
        models: [{ id: "a", name: "A" }],
        headers: [{ key: "X-Org", value: "acme" }],
        key: null,
        env: [],
      },
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    // A rename would be a delete and a create wearing one button.
    expect(screen.getByLabelText("Provider ID").hasAttribute("disabled")).toBe(
      true,
    );
    // The stored secret is never read back, so the field cannot show it - and
    // the helper has to say that empty KEEPS it rather than clears it.
    expect(screen.getByLabelText("API key").getAttribute("value")).toBe("");
    expect(
      screen.getByText(
        "Optional. Leave empty to keep the saved key, or manage auth via headers.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "https://api.myprovider.com/v1",
      models: [{ id: "a", name: "A" }],
      headers: [{ key: "X-Org", value: "acme" }],
      // Null, so the host leaves the stored credential alone.
      key: null,
      env: [],
    });
  });

  it("keeps the form open and shows what the host rejected", () => {
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: "That base URL isn't reachable.",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "That base URL isn't reachable.",
    );
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
  });
});
