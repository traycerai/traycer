import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
  type PendingRuleDraft,
} from "@/components/settings/panels/auto-policy-document";
import {
  RulesTab,
  type RulesEditorState,
} from "@/components/settings/panels/permissions/rules-tab";

// ---- host boundary --------------------------------------------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }): void => {
    void args;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));

const support = vi.hoisted((): { get: boolean | null; set: boolean } => ({
  get: true,
  set: true,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoPolicy.get" ? support.get : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoPolicy.set" ? support.set : false,
}));

// ---- queries --------------------------------------------------------------

const policy = vi.hoisted(
  (): { current: AutoPolicyGetResponse | undefined } => ({
    current: undefined,
  }),
);
const refetchMock = vi.hoisted(() =>
  vi.fn<
    (options: {
      readonly cancelRefetch: boolean;
    }) => Promise<{ readonly isError: boolean }>
  >(),
);
vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data: policy.current,
    isError: false,
    refetch: refetchMock,
  }),
}));

interface SetPolicyCallbacks {
  readonly onSuccess: (response: { readonly updatedAt: string | null }) => void;
}
const setPolicyMutate = vi.hoisted(() =>
  vi.fn<
    (
      variables: { readonly body: string },
      callbacks: SetPolicyCallbacks,
    ) => void
  >(),
);
const setPolicyState = vi.hoisted((): { isPending: boolean } => ({
  isPending: false,
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({
    mutate: setPolicyMutate,
    isPending: setPolicyState.isPending,
  }),
}));

// ---- fixtures -------------------------------------------------------------

const STORED_BODY = joinAutoPolicySections({
  environment: "Staging: k8s-staging",
  allow: "- Run the linter",
  softDeny: "- Drop a table",
  hardDeny: "- Push to main",
  notes: "",
});
const STORED_WITH_NOTES = joinAutoPolicySections({
  environment: "Staging: k8s-staging",
  allow: "- Run the linter",
  softDeny: "- Drop a table",
  hardDeny: "- Push to main",
  notes: "House notes",
});

const SHIPPED = [
  "## Allow exceptions",
  "",
  "- **Read Only Inspection** — read-only commands.",
  "- **Local Test Run** — run the test suite.",
  "",
  "## Soft block",
  "",
  "- **Delete Outside Workspace** — deletes a file elsewhere.",
  "",
  "## Hard block (non-overridable)",
  "",
  "- **Force Push** — git push --force to a shared branch.",
  "- **Exfiltration** — send secrets out.",
  "- **Wipe Disk** — rm -rf /.",
  "",
].join("\n");

function record(
  overrides: Partial<AutoPolicyGetResponse>,
): AutoPolicyGetResponse {
  return {
    body: STORED_BODY,
    updatedAt: "2026-09-10T00:00:00.000Z",
    source: "account",
    readState: "fresh",
    ...overrides,
  };
}

const noop = (): void => undefined;

interface TabProps {
  readonly active: boolean;
  readonly drafts: ReadonlyArray<PendingRuleDraft>;
  readonly onDraftsConsumed: (throughId: number) => void;
  readonly snapshot: RulesEditorState | null;
  readonly onSnapshot: (editor: RulesEditorState) => void;
}

function tab(overrides: Partial<TabProps>): ReactElement {
  const props: TabProps = {
    active: true,
    drafts: [],
    onDraftsConsumed: noop,
    snapshot: null,
    onSnapshot: noop,
    ...overrides,
  };
  return <RulesTab {...props} />;
}

function input(key: string): HTMLTextAreaElement {
  const element = screen.getByTestId(`auto-policy-input-${key}`);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`auto-policy-input-${key} is not a textarea`);
  }
  return element;
}

function button(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return element;
}

/** Save waits for the opening read; this resolves once it has settled. */
async function settledSave(): Promise<HTMLButtonElement> {
  await waitFor(() => {
    expect(screen.queryByTestId("auto-policy-saving-spinner")).toBeNull();
  });
  return button("auto-policy-save");
}

beforeEach(() => {
  support.get = true;
  support.set = true;
  policy.current = record({});
  setPolicyMutate.mockReset();
  setPolicyState.isPending = false;
  refetchMock.mockReset();
  refetchMock.mockResolvedValue({ isError: false });
});

afterEach(cleanup);

describe("RulesTab", () => {
  describe("sections", () => {
    it("renders the four sections, each with its textarea, seeded from the stored policy", () => {
      render(tab({}));

      for (const [key, text] of [
        ["environment", "Staging: k8s-staging"],
        ["allow", "- Run the linter"],
        ["softDeny", "- Drop a table"],
        ["hardDeny", "- Push to main"],
      ] as const) {
        expect(screen.getByTestId(`auto-policy-section-${key}`)).not.toBeNull();
        expect(input(key).value).toBe(text);
      }
    });

    it("adds Notes as a fifth section when the stored document has any", () => {
      policy.current = record({ body: STORED_WITH_NOTES });
      render(tab({}));

      expect(screen.getByTestId("auto-policy-section-notes")).not.toBeNull();
      expect(input("notes").value).toBe("House notes");
    });

    it("hides Notes when there are none", () => {
      render(tab({}));

      expect(screen.queryByTestId("auto-policy-section-notes")).toBeNull();
    });

    it("labels the sections in the tab's words", () => {
      render(tab({}));

      expect(screen.getByLabelText("Always allow")).toBe(input("allow"));
      expect(screen.getByLabelText("Ask first")).toBe(input("softDeny"));
      expect(screen.getByLabelText("Never allow")).toBe(input("hardDeny"));
    });

    it("renders nothing until the record has answered", () => {
      policy.current = undefined;
      render(tab({}));

      expect(screen.queryByTestId("auto-policy-section-allow")).toBeNull();
    });
  });

  describe("Save and Discard", () => {
    it("keeps both off until something changes", async () => {
      render(tab({}));

      expect((await settledSave()).disabled).toBe(true);
      expect(button("auto-policy-discard").disabled).toBe(true);
    });

    it("sends autoPolicy.set with the joined document, then re-seeds from the response's updatedAt", async () => {
      render(tab({}));
      fireEvent.change(input("allow"), {
        target: { value: "- Run the linter\n- Run the tests" },
      });

      const save = await settledSave();
      expect(save.disabled).toBe(false);
      fireEvent.click(save);

      const expectedBody = joinAutoPolicySections({
        environment: "Staging: k8s-staging",
        allow: "- Run the linter\n- Run the tests",
        softDeny: "- Drop a table",
        hardDeny: "- Push to main",
        notes: "",
      });
      expect(setPolicyMutate).toHaveBeenCalledTimes(1);
      expect(setPolicyMutate.mock.calls[0][0]).toEqual({ body: expectedBody });

      // The write-through the real mutation performs: the cache now holds the
      // saved body under the server's new stamp, and the response carries the
      // same stamp. Re-seeding from anything older would read as "changed
      // somewhere else" and raise the banner.
      policy.current = record({
        body: expectedBody,
        updatedAt: "2026-09-10T00:05:00.000Z",
      });
      setPolicyMutate.mock.calls[0][1].onSuccess({
        updatedAt: "2026-09-10T00:05:00.000Z",
      });

      await waitFor(() => {
        expect(button("auto-policy-save").disabled).toBe(true);
      });
      expect(screen.queryByTestId("auto-policy-banner")).toBeNull();
      expect(input("allow").value).toBe("- Run the linter\n- Run the tests");
    });

    it("restores the stored text on Discard", () => {
      render(tab({}));
      fireEvent.change(input("softDeny"), {
        target: { value: "something else" },
      });
      expect(input("softDeny").value).toBe("something else");

      fireEvent.click(button("auto-policy-discard"));

      expect(input("softDeny").value).toBe("- Drop a table");
      expect(button("auto-policy-discard").disabled).toBe(true);
    });

    it("refuses a save over the server's cap and says by how much", async () => {
      render(tab({}));
      fireEvent.change(input("environment"), {
        target: { value: "x".repeat(65 * 1024) },
      });

      const save = await settledSave();
      expect(save.disabled).toBe(true);
      expect(screen.getByText(/Too long by/)).not.toBeNull();
    });
  });

  describe("section order", () => {
    it("says a stored body in another order will be saved in Traycer's", () => {
      policy.current = record({
        body: "## Allow\n\n- a\n\n## Environment\n\nenv\n",
      });
      render(tab({}));

      expect(screen.getByTestId("auto-policy-reorder-notice").textContent).toBe(
        "Saved in Traycer's section order.",
      );
    });

    it("says nothing for a body already in the canonical order", () => {
      render(tab({}));

      expect(screen.queryByTestId("auto-policy-reorder-notice")).toBeNull();
    });
  });

  describe("pending drafts", () => {
    const DRAFT: PendingRuleDraft = {
      id: 1,
      draft: { section: "allow", text: "Deploy to staging" },
    };

    it("appends a draft to Always allow and hands the id back", () => {
      const onDraftsConsumed = vi.fn<(throughId: number) => void>();
      render(tab({ drafts: [DRAFT], onDraftsConsumed }));

      expect(input("allow").value).toBe("- Run the linter\nDeploy to staging");
      expect(onDraftsConsumed).toHaveBeenCalledWith(1);
    });

    it("tells the user the rule applies to every repository", () => {
      render(tab({ drafts: [DRAFT] }));

      const allow = screen.getByTestId("auto-policy-section-allow");
      expect(
        within(allow).getByText(
          "Applies to every repository on your account. Keep it specific.",
        ),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("auto-policy-section-hardDeny")).queryByText(
          /Applies to every repository/,
        ),
      ).toBeNull();
    });

    it("applies a draft once: a rerender with the same drafts does not append it again", () => {
      const view = render(tab({ drafts: [DRAFT] }));
      view.rerender(tab({ drafts: [DRAFT] }));
      view.rerender(tab({ drafts: [DRAFT], active: true }));

      expect(input("allow").value).toBe("- Run the linter\nDeploy to staging");
    });

    it("applies a draft when the editor is already dirty, keeping the edit", () => {
      const view = render(tab({}));
      fireEvent.change(input("environment"), { target: { value: "my edit" } });

      view.rerender(tab({ drafts: [DRAFT] }));

      expect(input("allow").value).toBe("- Run the linter\nDeploy to staging");
      expect(input("environment").value).toBe("my edit");
    });

    it("stacks a second draft below the first, in arrival order", () => {
      const view = render(tab({ drafts: [DRAFT] }));
      view.rerender(
        tab({
          drafts: [
            DRAFT,
            { id: 2, draft: { section: "allow", text: "Run migrations" } },
          ],
        }),
      );

      expect(input("allow").value).toBe(
        "- Run the linter\nDeploy to staging\nRun migrations",
      );
    });

    it("seeds an empty section with the draft alone", () => {
      policy.current = record({ body: null, updatedAt: null });
      render(tab({ drafts: [DRAFT] }));

      expect(input("allow").value).toBe("Deploy to staging");
    });
  });

  describe("the record's state", () => {
    it("blocks Save and disables the fields for an unreadable record", async () => {
      policy.current = record({
        body: null,
        updatedAt: null,
        readState: "unreadable",
      });
      render(tab({}));

      expect(screen.getByTestId("auto-policy-banner").textContent).toBe(
        "Traycer can't read your saved rules right now, so saving is off. Reopen Settings to try again.",
      );
      expect(input("allow").disabled).toBe(true);
      expect((await settledSave()).disabled).toBe(true);
    });

    it("blocks Save, but not editing, for a stale record", async () => {
      policy.current = record({ readState: "stale" });
      render(tab({}));
      fireEvent.change(input("allow"), { target: { value: "edited" } });

      expect(screen.getByTestId("auto-policy-banner").textContent).toContain(
        "couldn't refresh",
      );
      expect(input("allow").disabled).toBe(false);
      expect((await settledSave()).disabled).toBe(true);
    });

    it("blocks Save when the host cannot store a policy", async () => {
      support.set = false;
      render(tab({}));
      fireEvent.change(input("allow"), { target: { value: "edited" } });

      expect(screen.getByTestId("auto-policy-banner").textContent).toContain(
        "can't save rules",
      );
      expect((await settledSave()).disabled).toBe(true);
    });

    it("blocks Save when the opening read failed", async () => {
      refetchMock.mockResolvedValue({ isError: true });
      render(tab({}));
      fireEvent.change(input("allow"), { target: { value: "edited" } });

      await waitFor(() => {
        expect(screen.getByTestId("auto-policy-banner").textContent).toContain(
          "couldn't check whether another device",
        );
      });
      expect(button("auto-policy-save").disabled).toBe(true);
    });

    it("warns, without blocking, when the policy was saved elsewhere since editing began", async () => {
      const view = render(tab({}));
      fireEvent.change(input("allow"), { target: { value: "edited" } });

      policy.current = record({ updatedAt: "2026-09-11T00:00:00.000Z" });
      view.rerender(tab({}));

      expect(screen.getByTestId("auto-policy-banner").textContent).toContain(
        "saved somewhere else",
      );
      expect((await settledSave()).disabled).toBe(false);
    });

    it("shows no banner for a healthy record", () => {
      render(tab({}));

      expect(screen.queryByTestId("auto-policy-banner")).toBeNull();
    });
  });

  describe("while saving or checking", () => {
    it("shows the spinner and disables the fields while a save is in flight", () => {
      setPolicyState.isPending = true;
      render(tab({}));

      expect(screen.getByTestId("auto-policy-saving-spinner")).not.toBeNull();
      expect(input("allow").disabled).toBe(true);
      expect(button("auto-policy-save").disabled).toBe(true);
    });

    it("shows the same spinner while the opening read is pending", () => {
      refetchMock.mockReturnValue(new Promise(noop));
      render(tab({}));

      expect(screen.getByTestId("auto-policy-saving-spinner")).not.toBeNull();
      expect(button("auto-policy-save").disabled).toBe(true);
    });

    it("re-reads the record each time the tab comes on screen", async () => {
      const view = render(tab({ active: false }));
      expect(refetchMock).not.toHaveBeenCalled();

      view.rerender(tab({ active: true }));

      await waitFor(() => {
        expect(refetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("Built-in rules", () => {
    beforeEach(() => {
      policy.current = record({ shippedDefaults: SHIPPED });
    });

    it("counts each tier's rules, and says Never allow's are always on", () => {
      render(tab({}));

      expect(
        within(screen.getByTestId("auto-policy-section-allow")).getByText(
          "Built-in: 2 rules",
        ),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("auto-policy-section-softDeny")).getByText(
          "Built-in: 1 rule",
        ),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("auto-policy-section-hardDeny")).getByText(
          "Built-in: 3 rules, always on",
        ),
      ).not.toBeNull();
      expect(
        within(
          screen.getByTestId("auto-policy-section-environment"),
        ).queryByText(/Built-in/),
      ).toBeNull();
    });

    it("opens Never allow's list by default and leaves the others closed", () => {
      render(tab({}));

      const hard = screen.getByTestId("auto-policy-section-hardDeny");
      expect(
        within(hard).getByRole("button", { name: /Force push/i }),
      ).not.toBeNull();
      const allow = screen.getByTestId("auto-policy-section-allow");
      expect(
        within(allow).queryByRole("button", { name: /Read only/i }),
      ).toBeNull();

      fireEvent.click(within(allow).getByText("Built-in: 2 rules"));
      expect(
        within(allow).getByRole("button", { name: /Read only inspection/i }),
      ).not.toBeNull();
    });

    it("expands a rule's own text when its chip is pressed", () => {
      render(tab({}));
      const hard = screen.getByTestId("auto-policy-section-hardDeny");

      fireEvent.click(
        within(hard).getByRole("button", { name: /Exfiltration/i }),
      );

      expect(within(hard).getByText("send secrets out.")).not.toBeNull();
    });

    it("draws no built-in list when the host sent no shipped defaults", () => {
      policy.current = record({ shippedDefaults: undefined });
      render(tab({}));

      expect(screen.queryByText(/Built-in:/)).toBeNull();
    });
  });

  describe("a host without Auto mode", () => {
    it("shows the one unsupported line", () => {
      support.get = false;
      render(tab({}));

      expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
        "predates Auto mode",
      );
      expect(screen.queryByTestId("auto-policy-section-allow")).toBeNull();
    });
  });

  it("clears the stored policy by saving an all-empty document", async () => {
    render(tab({}));
    for (const key of ["environment", "allow", "softDeny", "hardDeny"]) {
      fireEvent.change(input(key), { target: { value: "" } });
    }

    fireEvent.click(await settledSave());

    expect(setPolicyMutate.mock.calls[0][0]).toEqual({
      body: joinAutoPolicySections(EMPTY_AUTO_POLICY_SECTIONS),
    });
    expect(setPolicyMutate.mock.calls[0][0].body).toBe("");
  });

  describe("re-seed on a record equal to the unsaved edit", () => {
    const EDITED_ALLOW = "- Run the linter\n- Old rule";
    const EDITED_BODY = joinAutoPolicySections({
      environment: "Staging: k8s-staging",
      allow: EDITED_ALLOW,
      softDeny: "- Drop a table",
      hardDeny: "- Push to main",
      notes: "",
    });

    it("keeps the edit dirty when a stale equal record and then the fresh original arrive", () => {
      const { rerender } = render(tab({}));
      fireEvent.change(input("allow"), { target: { value: EDITED_ALLOW } });
      expect(input("allow").value).toBe(EDITED_ALLOW);

      policy.current = record({
        body: EDITED_BODY,
        updatedAt: "2026-09-11T00:00:00.000Z",
        readState: "stale",
      });
      rerender(tab({}));
      policy.current = record({});
      rerender(tab({}));

      expect(input("allow").value).toBe(EDITED_ALLOW);
      expect(button("auto-policy-discard").disabled).toBe(false);
    });

    it("re-seeds clean from a fresh newer record equal to the edit", () => {
      const { rerender } = render(tab({}));
      fireEvent.change(input("allow"), { target: { value: EDITED_ALLOW } });

      policy.current = record({
        body: EDITED_BODY,
        updatedAt: "2026-09-11T00:00:00.000Z",
      });
      rerender(tab({}));

      expect(input("allow").value).toBe(EDITED_ALLOW);
      expect(button("auto-policy-discard").disabled).toBe(true);
    });

    it("leaves the edit in place for a stale record that differs, then the fresh original", () => {
      const { rerender } = render(tab({}));
      fireEvent.change(input("allow"), { target: { value: EDITED_ALLOW } });

      policy.current = record({
        body: STORED_WITH_NOTES,
        updatedAt: "2026-09-11T00:00:00.000Z",
        readState: "stale",
      });
      rerender(tab({}));
      policy.current = record({});
      rerender(tab({}));

      expect(input("allow").value).toBe(EDITED_ALLOW);
    });
  });
});
