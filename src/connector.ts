import { Client, Events, GatewayIntentBits, type Message, Partials, type TextBasedChannel } from "discord.js";
import { Effect, FiberMap, Semaphore, Stream } from "effect";
import { runAgent } from "./agent.ts";
import type { ConnectorConfig } from "./config.ts";
import { deriveThreadTitle } from "./discord/format.ts";
import { DiscordRenderer, type RenderTarget } from "./discord/renderer.ts";
import { type DiscordRest, DiscordRpcServer } from "./discord/rpc.ts";
import { route, type RoutedRequest } from "./route.ts";

const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });

async function reportIncident(target: TextBasedChannel, error: unknown): Promise<void> {
  const incident = crypto.randomUUID().slice(0, 8);
  console.error(`[${incident}] Agent request failed:`, error);
  if (target.isSendable()) {
    await target.send({ content: `Request failed. Incident: ${incident}`, allowedMentions: { parse: [] } })
      .catch((delivery) => console.error(`[${incident}] Incident delivery failed:`, delivery));
  }
}

export type ConnectorOptions = {
  token: string;
  config: ConnectorConfig;
  signal: AbortSignal;
  onReady?: (name: string) => void;
};

export function runConnector(options: ConnectorOptions) {
  return Effect.gen(function* () {
    options.signal.throwIfAborted();
    const client = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new Client({
          intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages |
            GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent,
          partials: [Partials.Channel],
        })
      ),
      (client) => Effect.sync(() => client.destroy()),
    );
    const rpc = yield* Effect.acquireRelease(
      Effect.sync(() => new DiscordRpcServer(client.rest as unknown as DiscordRest, options.config.limits.frameBytes)),
      (rpc) => attempt(() => rpc.close()).pipe(Effect.orElseSucceed(() => undefined)),
    );
    const fibers = yield* FiberMap.make<string>();
    const submit = yield* FiberMap.runtimePromise(fibers)<never>();
    const semaphore = Semaphore.makeUnsafe(options.config.concurrency);
    const receive = (message: Message) => {
      const request = route(options.config, message);
      if (!request || options.signal.aborted) return;
      if (!FiberMap.hasUnsafe(fibers, request.actor) && [...fibers].length >= options.config.limits.pendingRequests) {
        if (message.channel.isSendable()) {
          void message.channel.send({
            content: "Agent queue is full. Try again later.",
            allowedMentions: { parse: [] },
          })
            .catch((error) => console.error("Queue notice delivery failed:", error));
        }
        return;
      }
      const work = semaphore.withPermits(1)(task(message, request, options.config, rpc)).pipe(
        Effect.scoped,
        Effect.matchEffect({
          onFailure: (error) => attempt(() => reportIncident(message.channel, error)).pipe(Effect.orElseSucceed(() => undefined)),
          onSuccess: () => Effect.void,
        }),
      );
      void submit(request.actor, work).catch((error) => console.error("Discord message handling failed:", error));
    };
    client.once(Events.ClientReady, (ready) => options.onReady?.(ready.user.username));
    client.on(Events.MessageCreate, receive);
    yield* attempt(() => client.login(options.token));
    options.signal.throwIfAborted();
    yield* Effect.callback<void>((resume) => {
      const stop = () => resume(Effect.void);
      options.signal.addEventListener("abort", stop, { once: true });
      return Effect.sync(() => options.signal.removeEventListener("abort", stop));
    });
  });
}

function task(message: Message, request: RoutedRequest, config: ConnectorConfig, rpc: DiscordRpcServer) {
  return Effect.gen(function* () {
    let target: TextBasedChannel = message.channel;
    if (request.createThread) {
      if (!message.inGuild() || !message.channel.isSendable()) {
        return yield* Effect.fail(new Error("Discord message cannot start a thread"));
      }
      target = yield* attempt(() =>
        message.startThread({
          name: deriveThreadTitle(request.input),
          autoArchiveDuration: 60,
          reason: "Agent Connector request",
        })
      );
    }
    if (!target.isSendable()) return yield* Effect.fail(new Error("Discord target is not sendable"));
    const grant = yield* Effect.acquireRelease(
      Effect.sync(() =>
        rpc.grant({
          actor: request.actor,
          policy: request.policy,
          userId: message.author.id,
          messageId: message.id,
          messageChannelId: message.channelId,
          channelId: target.id,
          parentChannelId: target.isThread() ? target.parentId ?? undefined : undefined,
          guildId: message.guildId ?? undefined,
        })
      ),
      (grant) => Effect.sync(() => grant.revoke()),
    );
    const renderer = new DiscordRenderer(target as RenderTarget, { outputMessages: config.limits.outputMessages });
    yield* Stream.runForEach(
      runAgent(
        config.policies[request.policy],
        request.actor,
        request.input,
        config.limits.frameBytes,
        grant.environment,
      ),
      (event) => attempt(() => renderer.push(event)),
    );
    yield* attempt(() => renderer.finish());
  });
}
