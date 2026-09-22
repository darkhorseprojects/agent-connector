import type { Message } from "discord.js";
import type { ConnectorConfig } from "./config.ts";

export type RoutedRequest = Readonly<{
  policy: string;
  input: string;
  createThread: boolean;
}>;

export function stripBotMention(content: string, botId: string): string | null {
  return new RegExp(`<@!?${botId}>`).test(content) ? content.replace(new RegExp(`<@!?${botId}>`), "") : null;
}

export function selectPolicy(
  config: ConnectorConfig,
  member: string,
  channel: string,
  parent: string | undefined,
  guild: string | undefined,
): { policy?: string; channel: boolean } {
  if (!guild) return { policy: config.members[member], channel: false };
  const channelPolicy = config.channels[parent ?? channel];
  if (channelPolicy) return { policy: channelPolicy, channel: true };
  return { policy: config.members[member] ?? config.guilds[guild], channel: false };
}

export function route(config: ConnectorConfig, message: Message): RoutedRequest | null {
  if (message.author.bot || message.webhookId !== null) return null;
  const parent = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
  const selected = selectPolicy(config, message.author.id, message.channelId, parent, message.guildId ?? undefined);
  let input = message.content;
  if (message.guildId && !selected.channel) {
    if (!message.mentions.users.has(config.identity.bot)) return null;
    const stripped = stripBotMention(input, config.identity.bot);
    if (stripped === null) return null;
    input = stripped;
  } else input = stripBotMention(input, config.identity.bot) ?? input;
  input = input.trim();
  return selected.policy && input
    ? { policy: selected.policy, input, createThread: selected.channel && parent === undefined }
    : null;
}
