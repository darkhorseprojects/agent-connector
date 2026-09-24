import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  type SendableChannels,
  type TextBasedChannel,
} from "discord.js";
import { Effect, FiberMap, Semaphore, Stream } from "effect";
import { runAgent } from "./agent.ts";
import { type ConnectorConfig, type InvocationContext, parseOverride } from "./config.ts";
import { deriveThreadTitle } from "./discord/format.ts";
import { DiscordRenderer, type RenderTarget } from "./discord/renderer.ts";
import { type DiscordContext, type DiscordRest, DiscordRpcServer } from "./discord/rpc.ts";
import { OperatorLog } from "./diagnostics.ts";
import { route, type RoutedRequest, selectPolicy } from "./route.ts";

const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });
type Work = Readonly<{
  id: string;
  receivedAt: number;
  readyAt: number;
  input: string;
  override: Readonly<Record<string, unknown>>;
  context: InvocationContext;
  grant: DiscordContext;
  target: RenderTarget;
  typingChannel?: SendableChannels;
}>;

async function reportIncident(target: RenderTarget, id: string, error: unknown, log: OperatorLog): Promise<void> {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error
    ? error.name
    : "UnknownFailure";
  await log.record(id, "request.failed", undefined, code)
    .catch(() => console.error(`[${id}] Operator log write failed`));
  console.error(`[${id}] Agent request failed: ${code}`);
  await target.send({ content: `Request failed. Incident: ${id}`, allowedMentions: { parse: [] } })
    .catch(() => console.error(`[${id}] Incident delivery failed`));
}

export function runConnector(options: { token: string; config: ConnectorConfig }) {
  return Effect.gen(function* () {
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
      Effect.sync(() => new DiscordRpcServer(client.rest as unknown as DiscordRest, options.config.limits.rpcBytes)),
      (rpc) => Effect.promise(() => rpc.close()),
    );
    const log = new OperatorLog();
    yield* Effect.promise(() => log.record("connector", "connector.started"));
    const fibers = yield* FiberMap.make<string>();
    const submit = yield* FiberMap.runtimePromise(fibers)<never>();
    const semaphore = Semaphore.makeUnsafe(options.config.concurrency);
    let preparing = 0;

    const enqueue = (work: Work) => {
      const key = JSON.stringify([work.context.policy, work.context.member, work.context.channel]);
      const pending = options.config.limits.pendingRequests;
      if (!FiberMap.hasUnsafe(fibers, key) && [...fibers].length + preparing >= pending) {
        void work.target.send({ content: "Agent queue is full. Try again later.", allowedMentions: { parse: [] } });
        return;
      }
      const owned = semaphore.withPermits(1)(task(work, options.config, rpc, log)).pipe(
        Effect.scoped,
        Effect.matchEffect({
          onFailure: (error) =>
            attempt(() => reportIncident(work.target, work.id, error, log)).pipe(Effect.orElseSucceed(() => undefined)),
          onSuccess: () => Effect.void,
        }),
      );
      void submit(key, owned).catch(() => console.error("Discord request handling failed"));
    };

    const receiveMessage = (message: Message) => {
      const receivedAt = performance.now();
      const request = route(options.config, message);
      if (!request) return;
      const key = JSON.stringify([request.policy, message.author.id, message.channelId]);
      const reserve = request.createThread || !FiberMap.hasUnsafe(fibers, key);
      if (reserve && [...fibers].length + preparing >= options.config.limits.pendingRequests) {
        if (message.channel.isSendable()) {
          void message.channel.send({
            content: "Agent queue is full. Try again later.",
            allowedMentions: { parse: [] },
          });
        }
        return;
      }
      if (reserve) preparing++;
      const id = crypto.randomUUID();
      void messageWork(message, request, options.config, id, receivedAt).then((work) => {
        if (reserve) preparing--;
        if (work) enqueue(work);
      }, (error) => {
        if (reserve) preparing--;
        return reportIncident(message.channel as unknown as RenderTarget, id, error, log);
      });
    };
    const receiveInteraction = (interaction: ChatInputCommandInteraction) => {
      const receivedAt = performance.now();
      if (interaction.commandName !== "agent") return;
      const id = crypto.randomUUID();
      void interactionWork(interaction, options.config, id, receivedAt).then((work) => {
        if (work) enqueue(work);
      }).catch((error) => {
        void log.record(id, "interaction.failed", undefined, error instanceof Error ? error.name : "UnknownFailure");
        console.error(`[${id}] Discord command handling failed`);
      });
    };
    client.on(Events.MessageCreate, receiveMessage);
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) receiveInteraction(interaction);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        client.removeAllListeners(Events.MessageCreate);
        client.removeAllListeners(Events.InteractionCreate);
      })
    );
    yield* attempt(() => client.login(options.token));
    console.log(`Connected as ${client.user!.username}`);
    return yield* Effect.never;
  });
}

async function messageWork(
  message: Message,
  request: RoutedRequest,
  config: ConnectorConfig,
  id: string,
  receivedAt: number,
): Promise<Work | undefined> {
  let target: TextBasedChannel = message.channel;
  if (request.createThread) {
    if (!message.inGuild() || !message.channel.isSendable()) throw new Error("Discord message cannot start a thread");
    target = await message.startThread({
      name: deriveThreadTitle(request.input),
      autoArchiveDuration: 60,
      reason: "Agent Connector request",
    });
  }
  if (!target.isSendable()) return undefined;
  const context: InvocationContext = {
    application: config.identity.application,
    policy: request.policy,
    member: message.author.id,
    channel: target.id,
    guild: message.guildId ?? undefined,
    message: message.id,
  };
  return {
    id,
    receivedAt,
    readyAt: performance.now(),
    input: request.input,
    override: {},
    context,
    grant: {
      policy: context.policy,
      memberId: context.member,
      messageId: context.message,
      messageChannelId: message.channelId,
      channelId: context.channel,
      parentChannelId: target.isThread() ? target.parentId ?? undefined : undefined,
      guildId: context.guild,
    },
    target: target as unknown as RenderTarget,
    typingChannel: target,
  };
}

async function interactionWork(
  interaction: ChatInputCommandInteraction,
  config: ConnectorConfig,
  id: string,
  receivedAt: number,
): Promise<Work | undefined> {
  const channel = interaction.channel;
  const member = interaction.user.id;
  const parent = channel?.isThread() ? channel.parentId ?? undefined : undefined;
  const selected = selectPolicy(config, member, interaction.channelId, parent, interaction.guildId ?? undefined);
  if (!selected.policy || !channel) {
    await interaction.reply({ content: "This command is not configured here.", ephemeral: true });
    return undefined;
  }
  const input = interaction.options.getString("prompt", true).trim();
  if (!input) {
    await interaction.reply({ content: "Prompt cannot be empty.", ephemeral: true });
    return undefined;
  }
  let override: Record<string, unknown> = {};
  try {
    const source = interaction.options.getString("config");
    if (source) override = parseOverride(source, config.policies[selected.policy].overrides);
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : String(error), ephemeral: true });
    return undefined;
  }
  await interaction.deferReply();
  let initial = true;
  const target: RenderTarget = {
    send: async (message) => {
      if (initial) {
        initial = false;
        return await interaction.editReply(message);
      }
      return await interaction.followUp(message);
    },
  };
  const context: InvocationContext = {
    application: config.identity.application,
    policy: selected.policy,
    member,
    channel: interaction.channelId,
    guild: interaction.guildId ?? undefined,
    message: interaction.id,
  };
  return {
    id,
    receivedAt,
    readyAt: performance.now(),
    input,
    override,
    context,
    grant: {
      policy: context.policy,
      memberId: context.member,
      channelId: context.channel,
      parentChannelId: parent,
      guildId: context.guild,
    },
    target,
  };
}

function task(work: Work, config: ConnectorConfig, rpc: DiscordRpcServer, log: OperatorLog) {
  return Effect.gen(function* () {
    const activeAt = performance.now();
    const observations: Array<{ stage: string; childUs: number; receivedMs: number; logWriteMs?: number }> = [];
    let droppedStages = 0;
    let firstOutputReceivedMs: number | undefined;
    let firstSendStartedMs: number | undefined;
    let firstSendCompletedMs: number | undefined;
    let firstDeltaLogMs: number | undefined;
    if (config.profiling) {
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          log.recordProfile(work.id, {
            readyMs: work.readyAt - work.receivedAt,
            activeMs: activeAt - work.receivedAt,
            totalMs: performance.now() - work.receivedAt,
            observations,
            droppedStages,
            firstOutputReceivedMs,
            firstSendStartedMs,
            firstSendCompletedMs,
            firstDeltaLogMs,
          }).catch(() => console.error(`[${work.id}] Profile write failed`))
        )
      );
    }
    const policy = config.policies[work.context.policy];
    const grant = policy.discord
      ? yield* Effect.acquireRelease(
        Effect.sync(() => rpc.grant(work.grant)),
        (grant) => Effect.sync(() => grant.revoke()),
      )
      : undefined;
    let delivered = false;
    const target: RenderTarget = work.typingChannel || config.profiling
      ? {
        send: async (options) => {
          if (config.profiling) firstSendStartedMs ??= performance.now() - work.receivedAt;
          const message = await work.target.send(options);
          delivered = true;
          if (config.profiling) firstSendCompletedMs ??= performance.now() - work.receivedAt;
          return message;
        },
      }
      : work.target;
    if (work.typingChannel) {
      const channel = work.typingChannel;
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (!delivered) {
            const sent = yield* attempt(() => channel.sendTyping()).pipe(
              Effect.match({ onFailure: () => false, onSuccess: () => true }),
            );
            if (!sent) {
              yield* Effect.promise(() =>
                log.record(work.id, "typing.failed")
                  .catch(() => console.error(`[${work.id}] Typing diagnostic write failed`))
              );
              return;
            }
            yield* Effect.sleep("8 seconds");
          }
        }),
      );
    }
    const renderer = new DiscordRenderer(target, config.limits.outputMessages);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const started = performance.now();
    let firstDelta = true;
    yield* Effect.promise(() => log.record(work.id, "request.started"));
    const execution = runAgent({
      policy,
      policies: config.policies,
      context: work.context,
      input: work.input,
      override: work.override,
      discord: grant,
      profile: config.profiling,
    }).pipe(
      Stream.runForEach((event) => {
        if (event.type === "log") {
          const received = performance.now();
          let observation: (typeof observations)[number] | undefined;
          if (config.profiling) {
            if (event.atUs === undefined) return Effect.fail(new Error("profile timestamp is unavailable"));
            if (observations.length < 256) {
              observation = { stage: event.stage, childUs: event.atUs, receivedMs: received - work.receivedAt };
              observations.push(observation);
            } else droppedStages++;
          }
          return Effect.promise(async () => {
            await log.record(work.id, event.stage, received - started);
            if (observation) observation.logWriteMs = performance.now() - received;
          });
        }
        if (event.type === "traceback") {
          return Effect.promise(() => log.record(work.id, "lua.traceback", performance.now() - started));
        }
        if (config.profiling && (event.type === "append" || event.type === "emit") && event.output.length > 0) {
          firstOutputReceivedMs ??= performance.now() - work.receivedAt;
        }
        return attempt(async () => {
          let text: string;
          if (event.type === "append") text = decoder.decode(event.output, { stream: true });
          else {
            decoder.decode();
            text = decoder.decode(event.output);
          }
          if (event.type === "append") {
            if (firstDelta) {
              firstDelta = false;
              const received = performance.now();
              await log.record(work.id, "model.first_delta", received - started);
              if (config.profiling) firstDeltaLogMs = performance.now() - received;
            }
            await renderer.append(text);
          } else if (event.type === "result") await renderer.result(text);
          else await renderer.write(text);
        });
      }),
    );
    yield* execution.pipe(Effect.timeout(config.limits.lifetimeMs));
    yield* Effect.promise(() => log.record(work.id, "request.completed", performance.now() - started));
  });
}
