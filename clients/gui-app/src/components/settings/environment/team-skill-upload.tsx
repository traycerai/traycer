import { ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES } from "@traycer/protocol/host/environment/configuration-contracts";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { bytesToBase64Async } from "@/lib/composer/image-base64";
import { useConfigurationSkillsUploadMutation } from "@/hooks/environment/team/use-skills-upload-mutation";
import { useConfigurationSource } from "./configuration-source";

export function TeamSkillUpload(props: {
  readonly onNotServed: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const mutation = useConfigurationSkillsUploadMutation();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = async (): Promise<void> => {
    if (source.kind !== "pool" || file === null) return;
    if (file.size > ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES) {
      setProblem("Choose a skill smaller than 32 MB.");
      return;
    }
    setProblem(null);
    try {
      const archive = await bytesToBase64Async(
        new Uint8Array(await file.arrayBuffer()),
      );
      mutation.mutate(
        { environmentId: source.environmentId, name: name.trim(), archive },
        {
          onSuccess: (result) => {
            if (result.outcome === "not_served") props.onNotServed();
            else if (result.outcome === "saved") {
              setName("");
              setFile(null);
            } else setProblem("Couldn't add this skill.");
          },
        },
      );
    } catch {
      setProblem("Couldn't read the skill archive.");
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-dashed border-border/60 p-3"
      aria-label="Add a skill"
    >
      <Label htmlFor="team-skill-name">Skill name</Label>
      <Input
        id="team-skill-name"
        maxLength={128}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Label htmlFor="team-skill-archive">Skill folder archive</Label>
      <Input
        id="team-skill-archive"
        type="file"
        accept=".tar.gz,.tgz"
        onChange={(event) => setFile(event.target.files?.item(0) ?? null)}
      />
      <p className="text-ui-xs text-muted-foreground">
        Choose a .tar.gz skill folder, up to 32 MB.
      </p>
      {problem === null ? null : (
        <p role="status" className="text-ui-xs text-warning-foreground">
          {problem}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        className="self-end"
        disabled={
          file === null || name.trim().length === 0 || mutation.isPending
        }
        onClick={() => void upload()}
      >
        Add a skill{mutation.isPending ? <MutedAgentSpinner /> : null}
      </Button>
    </section>
  );
}
