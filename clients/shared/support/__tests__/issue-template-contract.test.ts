/**
 * Wire-contract tripwire for `.github/ISSUE_TEMPLATE/*.yml`.
 *
 * `clients/shared/support/issue-reporter.ts` prefills GitHub issue-form fields
 * by id (`template=bug_report.yml&component=...&version=...`). Renaming a field
 * id, flipping `required`, or dropping `"Desktop app"` from the component
 * dropdown breaks every shipped client that still emits the old ids - with no
 * TypeScript compile error. These tests are the gate the frozen-ids comment
 * headers in those YAML files point at.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// support/__tests__ -> shared -> clients -> traycer root
const ISSUE_TEMPLATE_DIR = join(THIS_DIR, "../../../../.github/ISSUE_TEMPLATE");

/** Field ids that issue-reporter.ts currently prefills on bug_report.yml. */
const BUG_REPORT_CLIENT_FIELD_IDS = [
  "component",
  "version",
  "os",
  "what-happened",
  "repro",
] as const;

/** Field ids `buildPublicDraftFields` prefills on feature_request.yml (ticket 07's "idea" route). */
const FEATURE_REQUEST_CLIENT_FIELD_IDS = [
  "problem",
  "proposal",
  "component",
] as const;

/** Field ids `buildPublicDraftFields` prefills on general.yml (ticket 07's "other" route). */
const GENERAL_CLIENT_FIELD_IDS = ["details"] as const;

/** Literal hardcoded in issue-reporter.ts as the component prefill value. */
const DESKTOP_APP_COMPONENT = "Desktop app";

interface IssueFormField {
  readonly id: string | undefined;
  readonly type: string | undefined;
  readonly options: readonly string[] | undefined;
  readonly required: boolean | undefined;
}

interface IssueFormTemplate {
  readonly name: string | undefined;
  readonly labels: readonly string[];
  readonly fields: readonly IssueFormField[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseIssueFormTemplate(filename: string): IssueFormTemplate {
  const path = join(ISSUE_TEMPLATE_DIR, filename);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Issue template contract broken: could not read ${path}. ` +
        `The file may have been moved or deleted. Original error: ${String(error)}`,
    );
  }

  const parsed: unknown = parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Issue template contract broken: ${filename} did not parse to a YAML mapping.`,
    );
  }

  const body = parsed.body;
  const fields: IssueFormField[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (!isPlainObject(entry)) {
        continue;
      }
      const attributes = isPlainObject(entry.attributes)
        ? entry.attributes
        : undefined;
      const validations = isPlainObject(entry.validations)
        ? entry.validations
        : undefined;
      fields.push({
        id: typeof entry.id === "string" ? entry.id : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
        options:
          attributes !== undefined
            ? asStringArray(attributes.options)
            : undefined,
        required:
          validations !== undefined && typeof validations.required === "boolean"
            ? validations.required
            : undefined,
      });
    }
  }

  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    labels: asStringArray(parsed.labels),
    fields,
  };
}

function findField(
  template: IssueFormTemplate,
  fieldId: string,
): IssueFormField | undefined {
  return template.fields.find((field) => field.id === fieldId);
}

describe("GitHub issue template contract", () => {
  describe("bug_report.yml (client prefill target)", () => {
    const template = parseIssueFormTemplate("bug_report.yml");

    it("parses and carries triage + bug labels", () => {
      expect(
        template.name,
        "bug_report.yml is missing a top-level `name` - is the file still a form template?",
      ).toBeTruthy();
      expect(
        template.labels,
        "bug_report.yml labels must include 'triage' so app-routed issues stay in the triage queue " +
          "(issue-reporter deliberately omits labels= so the template's labels apply).",
      ).toEqual(expect.arrayContaining(["bug", "triage"]));
    });

    for (const fieldId of BUG_REPORT_CLIENT_FIELD_IDS) {
      it(`keeps field id "${fieldId}" present and required`, () => {
        const field = findField(template, fieldId);
        expect(
          field,
          `Issue template contract broken: bug_report.yml is missing field id "${fieldId}". ` +
            `issue-reporter.ts prefills this id via GitHub's issue-form query params; ` +
            `renaming or removing it silently drops the prefill for every shipped client. ` +
            `Present ids: [${template.fields
              .map((f) => f.id)
              .filter((id): id is string => id !== undefined)
              .join(", ")}]`,
        ).toBeDefined();
        if (field === undefined) {
          return;
        }
        expect(
          field.required,
          `Issue template contract broken: bug_report.yml field "${fieldId}" must have ` +
            `validations.required === true (got ${String(field.required)}). ` +
            `Flipping required off changes the form GitHub shows for every prefilled draft.`,
        ).toBe(true);
      });
    }

    it(`keeps "${DESKTOP_APP_COMPONENT}" as a component dropdown option`, () => {
      const component = findField(template, "component");
      expect(
        component,
        `Issue template contract broken: bug_report.yml is missing field id "component". ` +
          `issue-reporter.ts hardcodes component=${JSON.stringify(DESKTOP_APP_COMPONENT)}.`,
      ).toBeDefined();
      if (component === undefined) {
        return;
      }
      expect(
        component.type,
        `Issue template contract broken: bug_report.yml field "component" must be a dropdown ` +
          `(got type=${String(component.type)}).`,
      ).toBe("dropdown");
      expect(
        component.options,
        `Issue template contract broken: bug_report.yml field "component" has no options array.`,
      ).toBeDefined();
      if (component.options === undefined) {
        return;
      }
      expect(
        component.options,
        `Issue template contract broken: bug_report.yml component dropdown must include the exact ` +
          `string ${JSON.stringify(DESKTOP_APP_COMPONENT)} (hardcoded in issue-reporter.ts). ` +
          `If this option is renamed or removed, GitHub will not show the prefilled component as selected. ` +
          `Current options: ${JSON.stringify(component.options)}`,
      ).toContain(DESKTOP_APP_COMPONENT);
    });
  });

  describe("feature_request.yml ('idea' route, ticket 07)", () => {
    const template = parseIssueFormTemplate("feature_request.yml");

    it("parses and carries the triage label", () => {
      expect(template.name).toBeTruthy();
      expect(
        template.labels,
        "feature_request.yml labels must include 'triage'.",
      ).toEqual(expect.arrayContaining(["triage"]));
    });

    for (const fieldId of FEATURE_REQUEST_CLIENT_FIELD_IDS) {
      it(`keeps field id "${fieldId}" present and required`, () => {
        const field = findField(template, fieldId);
        expect(
          field,
          `Issue template contract broken: feature_request.yml is missing field id "${fieldId}". ` +
            `buildPublicDraftFields ("idea" reports) prefills this id via GitHub's issue-form query params. ` +
            `Present ids: [${template.fields
              .map((f) => f.id)
              .filter((id): id is string => id !== undefined)
              .join(", ")}]`,
        ).toBeDefined();
        if (field === undefined) {
          return;
        }
        expect(
          field.required,
          `Issue template contract broken: feature_request.yml field "${fieldId}" must have ` +
            `validations.required === true (got ${String(field.required)}).`,
        ).toBe(true);
      });
    }

    it('keeps optional field id "alternatives" present', () => {
      expect(
        findField(template, "alternatives"),
        'Issue template contract broken: feature_request.yml is missing optional field id "alternatives", which the client prefills.',
      ).toBeDefined();
    });

    it(`keeps "${DESKTOP_APP_COMPONENT}" as a component dropdown option`, () => {
      const component = findField(template, "component");
      expect(component).toBeDefined();
      if (component === undefined) {
        return;
      }
      expect(component.type).toBe("dropdown");
      expect(component.options).toBeDefined();
      if (component.options === undefined) {
        return;
      }
      expect(
        component.options,
        `Issue template contract broken: feature_request.yml component dropdown must include ` +
          `${JSON.stringify(DESKTOP_APP_COMPONENT)} (hardcoded in support-public-draft.ts). ` +
          `Current options: ${JSON.stringify(component.options)}`,
      ).toContain(DESKTOP_APP_COMPONENT);
    });
  });

  describe("general.yml ('other' / \"something else\" route, ticket 07)", () => {
    const template = parseIssueFormTemplate("general.yml");

    it("parses and carries the triage label", () => {
      expect(template.name).toBeTruthy();
      expect(
        template.labels,
        "general.yml labels must include 'triage'.",
      ).toEqual(expect.arrayContaining(["triage"]));
    });

    for (const fieldId of GENERAL_CLIENT_FIELD_IDS) {
      it(`keeps field id "${fieldId}" present and required`, () => {
        const field = findField(template, fieldId);
        expect(
          field,
          `Issue template contract broken: general.yml is missing field id "${fieldId}". ` +
            `buildPublicDraftFields ("other" reports) prefills this id via GitHub's issue-form query params.`,
        ).toBeDefined();
        if (field === undefined) {
          return;
        }
        expect(field.required).toBe(true);
      });
    }
  });
});
