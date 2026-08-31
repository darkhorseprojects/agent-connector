import { Client, Events, GatewayIntentBits, type Message, Partials, type TextBasedChannel } from "discord.js";
import { Effect, Fiber, Semaphore, Stream } from "effect";
import type { ConnectorConfig } from "./config.ts";
import { type DiscordRest, DiscordRpcServer } from "./discord/rpc.ts";
import { deriveThreadTitle } from "./discord/format.ts";
import { DiscordRenderer, type RenderTarget } from "./discord/renderer.ts";
import { route } from "./route.ts";
import { runAgent } from "./runtime/invoke.ts";

export class SchedulerCapacityError extends Error {}
class Scheduler {
  readonly #semaphore: Semaphore.Semaphore;
  readonly #actors = new Map<string, Fiber.Fiber<void, never>>();
  #closed = false;

  constructor(concurrency: number, readonly maximum: number) {
    this.#semaphore = Semaphore.makeUnsafe(concurrency);
  }
  submit(actor: string, task: Effect.Effect<void, never>): Effect.Effect<void, SchedulerCapacityError> {
    // deno-lint-ignore no-this-alias
    const self = this;
    return Effect.gen(function* () {
      if (self.#closed) return;
      const previous = self.#actors.get(actor);
      if (previous) yield* Fiber.interrupt(previous);
      else if (self.#actors.size >= self.maximum) {
        return yield* Effect.fail(new SchedulerCapacityError("request queue is full"));
      }
      // deno-lint-ignore prefer-const
      let fiber!: Fiber.Fiber<void, never>;
      fiber = Effect.runFork(
        self.#semaphore.withPermits(1)(task).pipe(Effect.ensuring(Effect.sync(() => {
          if (self.#actors.get(actor) === fiber) self.#actors.delete(actor);
        }))),
      );
      self.#actors.set(actor, fiber);
    });
  }
  close(): Effect.Effect<void> {
    // deno-lint-ignore no-this-alias
    const self = this;
    return Effect.gen(function* () {
      self.#closed = true;
      yield* Fiber.interruptAll([...self.#actors.values()]);
      self.#actors.clear();
    });
  }
}

const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });
export async function reportIncident(
  target: TextBasedChannel,
  error: unknown,
  incident = crypto.randomUUID().slice(0, 8),
): Promise<void> {
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
export class DiscordConnector {
  readonly #scheduler: Scheduler;
  readonly #client = new Client({
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages |
      GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent,
    partials: [Partials.Channel],
  });
  #rpc: DiscordRpcServer | undefined;
  #stopping: Promise<void> | undefined;

  constructor(readonly options: ConnectorOptions) {
    this.#scheduler = new Scheduler(options.config.concurrency, options.config.limits.pendingRequests);
  }
  async start(): Promise<void> {
    this.options.signal.throwIfAborted();
    this.#client.once(Events.ClientReady, (client) => this.options.onReady?.(client.user.username));
    this.#client.on(
      Events.MessageCreate,
      (message) =>
        void Effect.runPromise(this.#receive(message)).catch((error) =>
          console.error("Discord message handling failed:", error)
        ),
    );
    this.options.signal.addEventListener("abort", () => void this.stop(), { once: true });
    await this.#client.login(this.options.token);
    this.options.signal.throwIfAborted();
    this.#rpc = new DiscordRpcServer(
      this.#client.rest as unknown as DiscordRest,
      this.options.config.limits.frameBytes,
    );
  }
  stop(): Promise<void> {
    // deno-lint-ignore no-this-alias
    const self = this;
    return this.#stopping ??= Effect.runPromise(Effect.gen(function* () {
      yield* self.#scheduler.close();
      if (self.#rpc) yield* attempt(() => self.#rpc!.close()).pipe(Effect.orElseSucceed(() => undefined));
      self.#rpc = undefined;
      self.#client.destroy();
    }));
  }
  #receive(message: Message): Effect.Effect<void, unknown> {
    const channel = message.channel;
    const request = route(this.options.config, {
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      webhook: message.webhookId !== null,
      channelId: message.channelId,
      parentChannelId: channel.isThread() ? channel.parentId ?? undefined : undefined,
      guildId: message.guildId ?? undefined,
      content: message.content,
      mentionedBot: message.mentions.users.has(this.options.config.discord.bot),
    });
    if (!request || this.options.signal.aborted) return Effect.void;
    // deno-lint-ignore no-this-alias
    const self = this;
    const task = Effect.gen(function* () {
      let target: TextBasedChannel = channel;
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
      const rpc = self.#rpc;
      if (!rpc) return yield* Effect.fail(new Error("Discord RPC is unavailable"));
      const grant = yield* Effect.acquireRelease(
        Effect.sync(() =>
          rpc.grant({
            actor: request.actor,
            policy: request.policy,
            userId: message.author.id,
            messageId: message.id,
            channelId: target.id,
            parentChannelId: target.isThread() ? target.parentId ?? undefined : undefined,
            guildId: message.guildId ?? undefined,
          })
        ),
        (grant) => Effect.sync(() => grant.revoke()),
      );
      const renderer = new DiscordRenderer(target as RenderTarget, {
        outputMessages: self.options.config.limits.outputMessages,
      });
      yield* Stream.runForEach(
        runAgent(
          self.options.config.policies[request.policy],
          request.actor,
          request.input,
          self.options.config.limits.frameBytes,
          grant.environment,
        ),
        (event) => attempt(() => renderer.push(event)),
      );
      yield* attempt(() => renderer.finish());
    }).pipe(
      Effect.scoped,
      Effect.matchEffect({
        onFailure: (error) => attempt(() => reportIncident(channel, error)).pipe(Effect.orElseSucceed(() => undefined)),
        onSuccess: () => Effect.void,
      }),
    );
    return this.#scheduler.submit(request.actor, task).pipe(
      Effect.matchEffect({
        onFailure: () =>
          channel.isSendable()
            ? attempt(() =>
              channel.send({ content: "Agent queue is full. Try again later.", allowedMentions: { parse: [] } }).then(
                () => {},
              )
            ).pipe(Effect.asVoid)
            : Effect.void,
        onSuccess: () => Effect.void,
      }),
    );
  }
}
