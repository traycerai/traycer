import { expect, test as base } from "@playwright/test";
import {
  expectVanishesWithoutFade,
  openTree,
  pageErrors,
  recordCloud,
  seedCloud,
  trackOf,
  type CloudSpec,
  type Shape,
} from "./support/chat-tree-motion.ts";

// A cloud row: a chat the task has in the cloud and this computer does not
// hold, drawn from the cloud list. An open cloud orchestrator holds its
// subagents as rows under it.

const test = base.extend<{ pageErrorLog: string[] }>({
  pageErrorLog: [
    async ({ page }, use) => {
      const log: string[] = [];
      page.on("pageerror", (error) => {
        log.push(error.stack ?? error.message);
      });
      await use(log);
      expect(log, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});

const LOCAL_ONLY: Shape = { roots: ["a"], children: {}, updatedAt: undefined };
const ORCHESTRATOR: CloudSpec = { id: "orch", parentId: null };
const SUBAGENTS: readonly CloudSpec[] = ["s1", "s2", "s3"].map((id) => ({
  id,
  parentId: ORCHESTRATOR.id,
}));
/** A cached answer that is applied in the render the write causes. */
const FRAME_BY_WHICH_IT_IS_GONE = 3;

test.describe("virtual chat tree: cloud rows", () => {
  test("a subagent removed from an open cloud orchestrator vanishes without fading", async ({
    page,
  }) => {
    await openTree(page, LOCAL_ONLY, 0, "a");
    await seedCloud(page, [ORCHESTRATOR, ...SUBAGENTS]);
    for (const { id } of [ORCHESTRATOR, ...SUBAGENTS]) {
      await expect(
        page.getByTestId(`epic-sidebar-cloud-item-${id}`),
      ).toBeVisible();
    }
    // The cached list is the one the tree reads: this must find it.
    const cached = await page.evaluate(
      (list) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.replaceCloudChats(list);
      },
      [ORCHESTRATOR, ...SUBAGENTS],
    );
    expect(cached, "cached cloud lists").toBe(1);
    const recording = await recordCloud(page, [
      ORCHESTRATOR,
      SUBAGENTS[0],
      SUBAGENTS[2],
    ]);
    expectVanishesWithoutFade(recording, "s2", FRAME_BY_WHICH_IT_IS_GONE);
    // Recorded, not asserted: whether its siblings and the rows below slide
    // or snap, for a run on another tree to be compared with.
    await test.info().attach("cloud-sibling-tracks", {
      body: JSON.stringify(
        Object.fromEntries(
          ["orch", "s1", "s3", "a"].map((id) => [id, trackOf(recording, id)]),
        ),
      ),
      contentType: "application/json",
    });
    expect(await pageErrors(page), "errors in the fixture").toEqual([]);
  });
});
