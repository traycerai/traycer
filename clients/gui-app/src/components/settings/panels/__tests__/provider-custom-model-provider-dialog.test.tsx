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
  readonly isPending?: boolean;
}) {
  return render(
    <ProviderCustomModelProviderDialog
      open
      onOpenChange={() => {}}
      providerLabel="OpenCode"
      takenIds={args.takenIds}
      disabledIds={args.disabledIds}
      initial={args.initial}
      // What the CATALOG says is declared. These cases open on a settled
      // config, so it matches the row's own values; the mid-retry case that
      // makes the two diverge lives in the tab suite, where a refetch can
      // actually land under an open form.
      stored={{
        models: (args.initial?.models ?? []).map((model) => model.id),
        headers: (args.initial?.headers ?? []).map((header) => header.key),
      }}
      isPending={args.isPending ?? false}
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

/** A declaration that is already in the config - every row of it stored. */
const STORED: CustomProviderValues = {
  modelProviderId: "myprovider",
  name: "My AI Provider",
  baseUrl: "https://api.myprovider.com/v1",
  models: [{ id: "a", name: "A" }],
  headers: [{ key: "X-Org", value: "acme" }],
  key: null,
  env: [],
};

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
    // the helper has to distinguish UNTOUCHED from EMPTIED, because those are
    // now different instructions: one keeps the declaration, the other deletes
    // it. "Leave empty and nothing happens" was true only while clearing was
    // unspellable.
    expect(screen.getByLabelText("API key").getAttribute("value")).toBe("");
    expect(
      screen.getByText(
        "Optional. Untouched keeps the saved key and env fallbacks; clearing a restored {env:VAR} removes it.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "https://api.myprovider.com/v1",
      models: [{ id: "a", name: "A" }],
      headers: [{ key: "X-Org", value: "acme" }],
      // Both null, and for the same reason: an untouched form is not an
      // instruction. `[]` here would delete the env declaration.
      key: null,
      env: null,
    });
  });

  it("locks a STORED row's key and leaves its value editable", () => {
    // The write is a deep merge with no way to say "delete this key", so
    // changing one is not a rename - it adds the new key and leaves the old one
    // behind, which is a duplicate plus an orphan nothing can now remove. The
    // value beside it carries no such risk.
    const onSubmit = vi.fn();
    renderDialog({
      initial: STORED,
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    expect(screen.getAllByLabelText("ID")[0].hasAttribute("readonly")).toBe(
      true,
    );
    expect(screen.getAllByLabelText("Header")[0].hasAttribute("readonly")).toBe(
      true,
    );
    expect(screen.getAllByLabelText("Name")[0].hasAttribute("readonly")).toBe(
      false,
    );
    expect(screen.getAllByLabelText("Value")[0].hasAttribute("readonly")).toBe(
      false,
    );

    typeNth("Name", 0, "A renamed");
    typeNth("Value", 0, "wonka");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "https://api.myprovider.com/v1",
      // The key rides through untouched; only what sits beside it moved.
      models: [{ id: "a", name: "A renamed" }],
      headers: [{ key: "X-Org", value: "wonka" }],
      key: null,
      env: null,
    });
  });

  it("gives a stored row NO remove, rather than a disabled one", () => {
    // A disabled control says "not right now". This row can never be removed
    // from this form, so the button would be an affordance that lies.
    renderDialog({
      initial: STORED,
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    expect(screen.queryByRole("button", { name: "Remove model 1" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove header 1" }),
    ).toBeNull();
  });

  it("keeps the trash on a row added during this session", () => {
    // Nothing is stored under it yet, so there is nothing the merge could
    // orphan - it is removable right up until save.
    renderDialog({
      initial: STORED,
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const remove = screen.getByRole("button", { name: "Remove model 2" });
    expect(remove.hasAttribute("disabled")).toBe(false);
    fireEvent.click(remove);
    expect(screen.getAllByPlaceholderText("model-id")).toHaveLength(1);
  });

  it("says why the rows are locked, and where the removal path is", () => {
    // "Why is there no delete button" is the question this surface will be
    // asked, and the honest answer names the route that does work.
    renderDialog({
      initial: STORED,
      takenIds: ["myprovider"],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    expect(
      screen.getByText(/Saved models can be renamed but not removed/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Saved headers can have their value changed/),
    ).toBeTruthy();
  });

  it("leaves CREATE alone - everything is removable before it is saved", () => {
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    expect(screen.getAllByLabelText("ID")[0].hasAttribute("readonly")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(
      screen
        .getByRole("button", { name: "Remove model 1" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText(/Saved models/)).toBeNull();
  });

  it("round-trips a dotted id like wafer.ai through Edit -> Save", () => {
    // `updateCustom` takes any non-empty existing id on the wire now, because
    // the minting pattern was never a judgement to make about an id already in
    // someone's config. `wafer.ai` is the shape that motivated it: legal to the
    // host, unmintable by us, and previously stuck - no re-enable and an Edit
    // whose id field could not be changed.
    const onSubmit = vi.fn();
    renderDialog({
      initial: {
        modelProviderId: "wafer.ai",
        name: "Wafer",
        baseUrl: "https://api.wafer.ai/v1",
        models: [{ id: "wafer-1", name: "Wafer One" }],
        headers: [],
        key: null,
        env: [],
      },
      takenIds: ["wafer.ai"],
      disabledIds: [],
      onSubmit,
      submitError: null,
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Wafer AI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(
      screen.queryByText(
        "Use lowercase letters, numbers, hyphens, or underscores",
      ),
    ).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "wafer.ai",
      name: "Wafer AI",
      baseUrl: "https://api.wafer.ai/v1",
      models: [{ id: "wafer-1", name: "Wafer One" }],
      headers: [],
      key: null,
      env: null,
    });
  });

  it("still refuses to MINT a dotted id", () => {
    // Create stays a naming surface: the strict pattern is ours to impose on an
    // id we are proposing, and the wire agrees - `createCustom` keeps the regex
    // that `updateCustom` dropped.
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    type("Provider ID", "wafer.ai");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(
      screen.getByText(
        "Use lowercase letters, numbers, hyphens, or underscores",
      ),
    ).toBeTruthy();
  });

  it("refuses a second submit while one is in flight", () => {
    // The label does NOT change while pending (repo rule: disable, never swap
    // to "Submitting…"), so the guard is the only thing standing between an
    // impatient double click and two writes to one config file.
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      disabledIds: [],
      onSubmit,
      submitError: null,
      isPending: true,
    });
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fillValidForm();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
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
