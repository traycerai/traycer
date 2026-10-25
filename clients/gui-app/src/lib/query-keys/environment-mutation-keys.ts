/**
 * Write keys for the Personal settings the host forwards to the person's
 * environment (`environment.*`): agent definitions and machine setup, plus the
 * Tracy Bots host binding (`environment.host.bind`) and main bot
 * (`environment.setMainBot`), and the environments redesign's writes: the
 * move, a team configuration's items and policy, members, and the
 * retrospective sheet's held items.
 */
export const environmentMutationKeys = {
  agentDefinitionsPut: () => ["environment.agentDefinitions.put"] as const,
  agentDefinitionsDelete: () =>
    ["environment.agentDefinitions.delete"] as const,
  setupPut: () => ["environment.setup.put"] as const,
  setupRetry: () => ["environment.setup.retry"] as const,
  undo: () => ["environment.undo"] as const,
  localOverrideSet: () => ["config.env.localOverride.set"] as const,
  localOverrideClear: () => ["config.env.localOverride.clear"] as const,
  remoteAccessSet: () => ["host.remoteAccess.set"] as const,
  setMainBot: () => ["environment.setMainBot"] as const,
  moveAccept: () => ["environment.move.accept"] as const,
  moveStop: () => ["environment.move.stop"] as const,
  configurationItemsPut: () => ["environment.configuration.items.put"] as const,
  configurationItemsDelete: () =>
    ["environment.configuration.items.delete"] as const,
  configurationMcpServersPut: () =>
    ["environment.configuration.mcpServers.put"] as const,
  configurationMcpServersDelete: () =>
    ["environment.configuration.mcpServers.delete"] as const,
  configurationMcpServersSetEnabled: () =>
    ["environment.configuration.mcpServers.setEnabled"] as const,
  configurationSkillsUpload: () =>
    ["environment.configuration.skills.upload"] as const,
  configurationSkillsRemove: () =>
    ["environment.configuration.skills.remove"] as const,
  configurationSkillsSetProviders: () =>
    ["environment.configuration.skills.setProviders"] as const,
  configurationPolicyPut: () =>
    ["environment.configuration.policy.put"] as const,
  membersInvite: () => ["environment.members.invite"] as const,
  membersSetRole: () => ["environment.members.setRole"] as const,
  membersRemove: () => ["environment.members.remove"] as const,
  membersNoticeSeen: () => ["environment.members.noticeSeen"] as const,
  reviewHeldApply: () => ["environment.review.heldApply"] as const,
  reviewRecord: () => ["environment.review.record"] as const,
  plansUnlink: () => ["environment.plans.unlink"] as const,
  // `providers.link@1.1` carries a team's `environmentId`: a team's Plans
  // card links a plan into that configuration.
  providersLink: () => ["providers.link"] as const,
  providersLinkComplete: () => ["providers.linkComplete"] as const,
  configurationGuideSet: () => ["environment.configuration.guide.set"] as const,
  configurationGuideReset: () =>
    ["environment.configuration.guide.reset"] as const,
};
