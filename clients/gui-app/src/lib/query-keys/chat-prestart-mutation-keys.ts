export const chatPrestartMutationKeys = {
  prestart: (hostId: string, chatId: string) =>
    ["chat.prestartRuntime", hostId, chatId] as const,
};
