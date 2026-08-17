import type { ConnectorConfig } from "./config.ts";

export type IncomingMessage = Readonly<{
  authorId: string;
  authorIsBot: boolean;
  webhook: boolean;
  channelId: string;
  parentChannelId?: string;
  guildId?: string;
  content: string;
  mentionedBot: boolean;
}>;

export type RoutedRequest = Readonly<{
  policy: string;
  actor: string;
  input: string;
  createThread: boolean;
}>;

export function stripBotMention(content: string, botId: string): string | null {
  const expression = new RegExp(`<@!?${botId}>`);
  if (!expression.test(content)) return null;
  return content.replace(expression, "");
}

export function route(config: ConnectorConfig, message: IncomingMessage): RoutedRequest | null {
  if (message.authorIsBot || message.webhook) return null;

  let policy: string | undefined;
  let input = message.content;
  let createThread = false;

  if (!message.guildId) {
    policy = config.users[message.authorId];
  } else {
    const configuredChannel = message.parentChannelId ?? message.channelId;
    policy = config.channels[configuredChannel];
    if (policy) {
      const stripped = stripBotMention(input, config.discord.bot);
      if (stripped !== null) input = stripped;
      createThread = message.parentChannelId === undefined;
    } else {
      if (!message.mentionedBot) return null;
      policy = config.guilds[message.guildId];
      const stripped = stripBotMention(input, config.discord.bot);
      if (stripped === null) return null;
      input = stripped;
    }
  }

  input = input.trim();
  if (!policy || !Object.hasOwn(config.policies, policy) || !input) return null;

  return Object.freeze({
    policy,
    actor: `discord:${config.discord.application}:${policy}:user:${message.authorId}`,
    input,
    createThread,
  });
}
