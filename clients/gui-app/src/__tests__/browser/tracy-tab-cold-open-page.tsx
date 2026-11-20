import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { FixtureApp } from "./bot-compact-actions-menu-frame";

export function ColdOpenFixture() {
  return (
    <FixtureApp>
      <div className="flex h-full min-h-0">
        <TopLevelTabHost />
      </div>
    </FixtureApp>
  );
}
