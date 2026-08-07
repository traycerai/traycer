import { describe, expect, it } from "vitest";
import type { ModelProviderPrompt } from "@traycer/protocol/host/provider-native-schemas";
import {
  defaultModelProviderPromptAnswers,
  modelProviderPromptConditionSatisfied,
  modelProviderPromptInputs,
  unansweredModelProviderPrompts,
  visibleModelProviderPrompts,
} from "@/components/settings/panels/model-provider-prompts";

/**
 * Pure tests for the prompts DSL, deliberately not driven through the dialog.
 * Upstream evaluates nothing here - the renderer is the only thing that decides
 * which fields are on screen - so the rule is the contract, and it is testable
 * without a form.
 */
const DEPLOYMENT: ModelProviderPrompt = {
  type: "select",
  key: "deploymentType",
  message: "Deployment",
  options: [
    { label: "GitHub.com", value: "github.com", hint: null },
    { label: "Enterprise", value: "enterprise", hint: "self-hosted" },
  ],
  when: null,
};

const ENTERPRISE_URL: ModelProviderPrompt = {
  type: "text",
  key: "instanceUrl",
  message: "Instance URL",
  placeholder: "https://github.example.com",
  when: { key: "deploymentType", op: "eq", value: "enterprise" },
};

const NOT_ENTERPRISE_NOTE: ModelProviderPrompt = {
  type: "text",
  key: "accountId",
  message: "Account id",
  placeholder: null,
  when: { key: "deploymentType", op: "neq", value: "enterprise" },
};

const PROMPTS = [DEPLOYMENT, ENTERPRISE_URL, NOT_ENTERPRISE_NOTE];

describe("modelProviderPromptConditionSatisfied", () => {
  it("compares the recorded answer with eq and neq", () => {
    const answers = new Map([["k", "a"]]);
    expect(
      modelProviderPromptConditionSatisfied(
        { key: "k", op: "eq", value: "a" },
        answers,
      ),
    ).toBe(true);
    expect(
      modelProviderPromptConditionSatisfied(
        { key: "k", op: "neq", value: "a" },
        answers,
      ),
    ).toBe(false);
    expect(
      modelProviderPromptConditionSatisfied(
        { key: "k", op: "neq", value: "b" },
        answers,
      ),
    ).toBe(true);
  });

  it("fails BOTH operators for an unanswered key", () => {
    // `neq` against nothing looks like it should pass, and must not: the only
    // way a key goes unanswered is that it names a prompt this method does not
    // have or one that is itself hidden, and a field whose precondition never
    // held is a field we cannot honestly ask for.
    const empty = new Map<string, string>();
    expect(
      modelProviderPromptConditionSatisfied(
        { key: "missing", op: "neq", value: "x" },
        empty,
      ),
    ).toBe(false);
    expect(
      modelProviderPromptConditionSatisfied(
        { key: "missing", op: "eq", value: "x" },
        empty,
      ),
    ).toBe(false);
  });
});

describe("defaultModelProviderPromptAnswers", () => {
  it("starts a select on its first option and a text field empty", () => {
    const answers = defaultModelProviderPromptAnswers(PROMPTS);
    expect(answers.get("deploymentType")).toBe("github.com");
    expect(answers.get("instanceUrl")).toBe("");
  });
});

describe("visibleModelProviderPrompts", () => {
  it("shows the branch matching the current selection and hides the other", () => {
    const answers = defaultModelProviderPromptAnswers(PROMPTS);
    expect(
      visibleModelProviderPrompts(PROMPTS, answers).map((p) => p.key),
    ).toEqual(["deploymentType", "accountId"]);

    const enterprise = new Map(answers);
    enterprise.set("deploymentType", "enterprise");
    expect(
      visibleModelProviderPrompts(PROMPTS, enterprise).map((p) => p.key),
    ).toEqual(["deploymentType", "instanceUrl"]);
  });

  it("does not let a HIDDEN prompt's answer reveal a later one", () => {
    // The form is a CLI prompt loop rendered at once: `region` is never asked
    // while the deployment is github.com, so the field predicated on its value
    // must not appear either - even though the answer map still carries the
    // default it was seeded with.
    const chained: readonly ModelProviderPrompt[] = [
      DEPLOYMENT,
      {
        type: "select",
        key: "region",
        message: "Region",
        options: [{ label: "EU", value: "eu", hint: null }],
        when: { key: "deploymentType", op: "eq", value: "enterprise" },
      },
      {
        type: "text",
        key: "regionalUrl",
        message: "Regional URL",
        placeholder: null,
        when: { key: "region", op: "eq", value: "eu" },
      },
    ];
    const answers = defaultModelProviderPromptAnswers(chained);
    expect(answers.get("region")).toBe("eu");
    expect(
      visibleModelProviderPrompts(chained, answers).map((p) => p.key),
    ).toEqual(["deploymentType"]);
  });
});

describe("unansweredModelProviderPrompts", () => {
  it("counts only VISIBLE prompts", () => {
    const answers = defaultModelProviderPromptAnswers(PROMPTS);
    // `instanceUrl` is empty but hidden, so it does not block submission;
    // `accountId` is empty and visible, so it does.
    expect(
      unansweredModelProviderPrompts(PROMPTS, answers).map((p) => p.key),
    ).toEqual(["accountId"]);

    const filled = new Map(answers);
    filled.set("accountId", "acct-1");
    expect(unansweredModelProviderPrompts(PROMPTS, filled)).toEqual([]);
  });

  it("treats whitespace as unanswered", () => {
    const answers = new Map(defaultModelProviderPromptAnswers(PROMPTS));
    answers.set("accountId", "   ");
    expect(
      unansweredModelProviderPrompts(PROMPTS, answers).map((p) => p.key),
    ).toEqual(["accountId"]);
  });
});

describe("modelProviderPromptInputs", () => {
  it("submits only the fields the user was actually shown", () => {
    // The host rejects any input key the selected method did not ask for, and a
    // hidden field is exactly that - sending its seeded default would be a
    // client bug dressed as data.
    const answers = new Map(defaultModelProviderPromptAnswers(PROMPTS));
    answers.set("accountId", "acct-1");
    expect(modelProviderPromptInputs(PROMPTS, answers)).toEqual({
      deploymentType: "github.com",
      accountId: "acct-1",
    });
  });

  it("TRIMS what it sends, matching the answered-check", () => {
    // The predicate trims before deciding a prompt counts as answered, so
    // untrimmed values passed the submit gate and reached upstream with their
    // padding intact - the form said complete and the provider got something
    // subtly different from what the field displayed.
    const answers = new Map(defaultModelProviderPromptAnswers(PROMPTS));
    answers.set("accountId", "  acct-123  ");
    expect(modelProviderPromptInputs(PROMPTS, answers).accountId).toBe(
      "acct-123",
    );
  });
});
