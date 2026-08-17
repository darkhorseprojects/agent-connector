import { Client, Events, GatewayIntentBits, type Message, Partials, type TextBasedChannel } from "discord.js";
import type { ConnectorConfig } from "./config.ts";
import { type DiscordRest, DiscordRpcServer } from "./discord/rpc.ts";
import { deriveThreadTitle } from "./discord/format.ts";
import { runAgent } from "./runtime/invoke.ts";
import { DiscordRenderer, type RenderTarget } from "./discord/renderer.ts";
import { route } from "./route.ts";
import { Scheduler, SchedulerCapacityError } from "./runtime/scheduler.ts";

export type ConnectorOptions = Readonly<{
  token: string;
  config: ConnectorConfig;
  signal: AbortSignal;
  onReady?: (name: string) => void;
}>;

export class DiscordConnector {
  readonly #token: string;
  readonly #config: ConnectorConfig;
  readonly #signal: AbortSignal;
  readonly #onReady?: (name: string) => void;
  readonly #scheduler: Scheduler;
  readonly #client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  #rpc: DiscordRpcServer | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: ConnectorOptions) {
    this.#token = options.token;
    this.#config = options.config;
    this.#signal = options.signal;
    this.#onReady = options.onReady;
    this.#scheduler = new Scheduler(
      options.config.concurrency,
      options.config.limits.pendingRequests,
      options.config.limits.pendingPerActor,
    );
  }

  async start(): Promise<void> {
    this.#signal.throwIfAborted();
    this.#client.once(Events.ClientReady, (client) => this.#onReady?.(client.user.username));
    this.#client.on(Events.MessageCreate, (message) => {
      this.#receive(message).catch((error) => console.error("Discord message handling failed:", error));
    });
    this.#signal.addEventListener("abort", () => void this.stop(), { once: true });
    await this.#client.login(this.#token);
    this.#signal.throwIfAborted();
    this.#rpc = new DiscordRpcServer(
      this.#client.rest as unknown as DiscordRest,
      this.#config.limits.rpcBytes,
    );
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      await this.#scheduler.close(this.#signal.reason ?? new Error("Agent Connector stopped."));
      await this.#rpc?.close();
      this.#rpc = undefined;
      this.#client.destroy();
    })();
    return this.#stopping;
  }

  async #receive(message: Message): Promise<void> {
    if (this.#signal.aborted) return;
    const channel = message.channel;
    const parentChannelId = channel.isThread() ? channel.parentId ?? undefined : undefined;
    const request = route(this.#config, {
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      webhook: message.webhookId !== null,
      channelId: message.channelId,
      parentChannelId,
      guildId: message.guildId ?? undefined,
      content: message.content,
      mentionedBot: message.mentions.users.has(this.#config.discord.bot),
    });
    if (!request) return;

    try {
      await this.#scheduler.run(request.actor, this.#signal, async (signal) => {
        let target: TextBasedChannel = channel;
        try {
          if (request.createThread) {
            if (!message.inGuild() || !message.channel.isSendable()) {
              throw new Error("Discord message cannot start a thread");
            }
            target = await message.startThread({
              name: deriveThreadTitle(request.input),
              autoArchiveDuration: 60,
              reason: "Agent Connector request",
            });
          }
          if (!target.isSendable()) throw new Error("Discord target is not sendable");

          const rpc = this.#rpc;
          if (!rpc) throw new Error("Discord RPC is unavailable");
          const policy = this.#config.policies[request.policy];
          const capability = rpc.grant({
            actor: request.actor,
            policy: request.policy,
            userId: message.author.id,
            messageId: message.id,
            channelId: target.id,
            parentChannelId: target.isThread() ? target.parentId ?? undefined : undefined,
            guildId: message.guildId ?? undefined,
          });
          try {
            const renderer = new DiscordRenderer(target as RenderTarget, {
              outputBytes: this.#config.limits.outputBytes,
              outputMessages: this.#config.limits.outputMessages,
            });
            try {
              for await (
                const event of runAgent(
                  policy,
                  request.actor,
                  request.input,
                  this.#config.limits.eventBytes,
                  signal,
                  capability.environment,
                )
              ) {
                await renderer.push(event);
              }
              await renderer.finish();
            } catch (error) {
              if (renderer.terminal) await renderer.finish();
              throw error;
            }
          } finally {
            capability.revoke();
          }
        } catch (error) {
          if (signal.aborted) throw error;
          await this.#incident(target, error);
        }
      });
    } catch (error) {
      if (this.#signal.aborted) return;
      if (error instanceof SchedulerCapacityError) {
        if (channel.isSendable()) {
          await channel.send({
            content: "Agent queue is full. Try again later.",
            allowedMentions: { parse: [] },
          });
        }
        return;
      }
      await this.#incident(channel, error);
    }
  }

  async #incident(target: TextBasedChannel, error: unknown): Promise<void> {
    const incident = crypto.randomUUID().slice(0, 8);
    console.error(`[${incident}] Agent request failed:`, error);
    if (target.isSendable()) {
      await target.send({
        content: `Request failed. Incident: ${incident}`,
        allowedMentions: { parse: [] },
      });
    }
  }
}
