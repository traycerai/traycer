import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./support/fixtures.ts";

interface McpProbeWindow extends Window {
  __kimiMcpProbe?: {
    readonly ready: boolean;
    readonly setScenario: (next: string) => void;
    readonly refreshRow: (variant: "changed" | "same") => Promise<void>;
    readonly mutationActions: () => readonly string[];
    readonly deferRemedyError: () => void;
    readonly failDeferredRemedy: () => void;
    readonly mutationSettled: () => boolean;
  };
}

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixture("provider-mcp-remedies"));
  await page.waitForFunction(
    () => (window as McpProbeWindow).__kimiMcpProbe?.ready === true,
  );
}

async function selectScenario(page: Page, scenario: string): Promise<void> {
  await page.evaluate(
    (next) => (window as McpProbeWindow).__kimiMcpProbe?.setScenario(next),
    scenario,
  );
}

async function mutationActions(page: Page): Promise<readonly string[]> {
  return page.evaluate(
    () => (window as McpProbeWindow).__kimiMcpProbe?.mutationActions() ?? [],
  );
}

test("blocking no-row notice, remedy cancel, and successful mutation notice", async ({
  page,
}) => {
  await openFixture(page);
  await expect(
    page.getByText("This file needs repair before its servers can be listed."),
  ).toBeVisible();
  await expect(page.getByText("No MCP servers")).toHaveCount(0);

  await page.getByRole("button", { name: "Repair server" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Repair this server before using it?",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(await mutationActions(page)).toEqual([]);

  await page.getByRole("button", { name: "Repair server" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Repair server" })
    .click();
  await expect(
    page.getByText("The repair finished; no servers remain in this fixture."),
  ).toBeVisible();
  expect(await mutationActions(page)).toEqual(["applyRemedy"]);
  await expect(page.getByText("No MCP servers")).toBeVisible();
});

test("row remedy and stdio enable require their own confirmation", async ({
  page,
}) => {
  await openFixture(page);
  await selectScenario(page, "row");
  await expect(
    page.getByRole("button", { name: "Repair server local-tool" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Repair server local-tool" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Repair this server before using it?",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(await mutationActions(page)).toEqual([]);

  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Enabling runs a local program.",
  );
  expect(await mutationActions(page)).toEqual([]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable" })
    .click();
  await expect(
    page.getByText("The server is enabled in this fixture."),
  ).toBeVisible();
  expect(await mutationActions(page)).toEqual(["applyRemedy"]);

  await selectScenario(page, "empty-confirmation");
  await expect(
    page.getByRole("switch", { name: "Enable local-tool" }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await mutationActions(page)).toEqual([]);
});

test("changed command and offer close confirmation; unchanged offer survives refresh", async ({
  page,
}) => {
  await openFixture(page);
  await selectScenario(page, "row");
  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(async () => {
    await (window as McpProbeWindow).__kimiMcpProbe?.refreshRow("changed");
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await mutationActions(page)).toEqual([]);

  await selectScenario(page, "row");
  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await page.evaluate(async () => {
    await (window as McpProbeWindow).__kimiMcpProbe?.refreshRow("same");
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable" })
    .click();
  await expect(
    page.getByText("The server is enabled in this fixture."),
  ).toBeVisible();
  expect(await mutationActions(page)).toEqual(["applyRemedy"]);
});

test("a failed pending offer cannot put its error on a replacement confirmation", async ({
  page,
}) => {
  await openFixture(page);
  await selectScenario(page, "two-rows");
  await page.evaluate(() =>
    (window as McpProbeWindow).__kimiMcpProbe?.deferRemedyError(),
  );
  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable" })
    .click();
  await page.evaluate(async () => {
    await (window as McpProbeWindow).__kimiMcpProbe?.refreshRow("changed");
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Repair server other-tool" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "Disable other-tool" }),
  ).toBeDisabled();

  await page.evaluate(() =>
    (window as McpProbeWindow).__kimiMcpProbe?.failDeferredRemedy(),
  );
  await page.waitForFunction(() =>
    (window as McpProbeWindow).__kimiMcpProbe?.mutationSettled(),
  );
  await expect(
    page.getByRole("button", { name: "Repair server other-tool" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Repair server other-tool" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(
    "Earlier offer failed",
  );
  expect(await mutationActions(page)).toEqual(["applyRemedy"]);
});

test("a capable host cannot enable a stdio row without an offer", async ({
  page,
}) => {
  await openFixture(page);
  await selectScenario(page, "missing-offer");
  await expect(
    page.getByRole("switch", { name: "Enable local-tool" }),
  ).toHaveCount(0);
  expect(await mutationActions(page)).toEqual([]);
});

test("old-host absent fields keep the empty state and immediate enable", async ({
  page,
}) => {
  await openFixture(page);
  await selectScenario(page, "old-empty");
  await expect(page.getByText("No MCP servers")).toBeVisible();
  await expect(page.getByRole("button", { name: "Repair server" })).toHaveCount(
    0,
  );

  await selectScenario(page, "old-row");
  await expect(
    page.getByRole("switch", { name: "Enable local-tool" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Repair server local-tool" }),
  ).toHaveCount(0);
  await page.getByRole("switch", { name: "Enable local-tool" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await mutationActions(page)).toEqual(["toggleServer"]);
});
