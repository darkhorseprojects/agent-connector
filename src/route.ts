import type { Message } from "discord.js";
import type { ConnectorConfig } from "./config.ts";

export type RoutedRequest = Readonly<{ policy: string; actor: string; input: string; createThread: boolean }>;

export function stripBotMention(content: string, botId: string): string | null {
  return new RegExp(`<@!?${botId}>`).test(content) ? content.replace(new RegExp(`<@!?${botId}>`), "") : null;
}

export function route(config: ConnectorConfig, message: Message): RoutedRequest | null {
  if (message.author.bot || message.webhookId !== null) return null;
  const parent = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
  let policy: string | undefined;
  let input = message.content;
  let createThread = false;
  if (!message.guildId) policy = config.users[message.author.id];
  else {
    policy = config.channels[parent ?? message.channelId];
    if (policy) {
      input = stripBotMention(input, config.discord.bot) ?? input;
      createThread = parent === undefined;
    } else {
      if (!message.mentions.users.has(config.discord.bot)) return null;
      policy = config.guilds[message.guildId];
      const stripped = stripBotMention(input, config.discord.bot);
      if (stripped === null) return null;
      input = stripped;
    }
  }
  input = input.trim();
  if (!policy || !Object.hasOwn(config.policies, policy) || !input) return null;
  const actor = `discord:${config.discord.application}:${policy}:user:${message.author.id}`;
  return { policy, actor, input, createThread };
}
