import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  type TextBasedChannel,
} from "discord.js";
import { Effect, FiberMap, Semaphore, Stream } from "effect";
import { runAgent } from "./agent.ts";
import { type ConnectorConfig, type InvocationContext, parseOverride } from "./config.ts";
import { deriveThreadTitle } from "./discord/format.ts";
import { DiscordRenderer, type RenderTarget } from "./discord/renderer.ts";
import { type DiscordContext, type DiscordRest, DiscordRpcServer } from "./discord/rpc.ts";
import { route, type RoutedRequest, selectPolicy } from "./route.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });
type Work = Readonly<{
  policy: string;
  input: string;
  override: Readonly<Record<string, unknown>>;
  context: InvocationContext;
  grant: DiscordContext;
  target: RenderTarget;
}>;

async function reportIncident(target: RenderTarget, error: unknown): Promise<void> {
  const incident = crypto.randomUUID().slice(0, 8);
  console.error(`[${incident}] Agent request failed:`, error);
  await target.send({ content: `Request failed. Incident: ${incident}`, allowedMentions: { parse: [] } })
    .catch((delivery) => console.error(`[${incident}] Incident delivery failed:`, delivery));
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
    const fibers = yield* FiberMap.make<string>();
    const submit = yield* FiberMap.runtimePromise(fibers)<never>();
    const semaphore = options.config.concurrency && Semaphore.makeUnsafe(options.config.concurrency);

    const enqueue = (key: string, work: Work) => {
      const pending = options.config.limits.pendingRequests;
      if (pending && !FiberMap.hasUnsafe(fibers, key) && [...fibers].length >= pending) {
        void work.target.send({ content: "Agent queue is full. Try again later.", allowedMentions: { parse: [] } });
        return;
      }
      let effect = task(work, options.config, rpc);
      if (semaphore) effect = semaphore.withPermits(1)(effect);
      const owned = effect.pipe(
        Effect.scoped,
        Effect.matchEffect({
          onFailure: (error) =>
            attempt(() => reportIncident(work.target, error)).pipe(Effect.orElseSucceed(() => undefined)),
          onSuccess: () => Effect.void,
        }),
      );
      void submit(key, owned).catch((error) => console.error("Discord request handling failed:", error));
    };

    const receiveMessage = (message: Message) => {
      const request = route(options.config, message);
      if (!request) return;
      void messageWork(message, request, options.config).then((work) => {
        if (work) enqueue(JSON.stringify([work.policy, work.context.member, work.context.channel]), work);
      }).catch((error) => reportIncident(message.channel as unknown as RenderTarget, error));
    };
    const receiveInteraction = (interaction: ChatInputCommandInteraction) => {
      if (interaction.commandName !== "agent") return;
      void interactionWork(interaction, options.config).then((work) => {
        if (work) enqueue(JSON.stringify([work.policy, work.context.member, work.context.channel]), work);
      }).catch((error) => console.error("Discord command handling failed:", error));
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
  const channel = target.id;
  return {
    policy: request.policy,
    input: request.input,
    override: {},
    context: {
      application: config.identity.application,
      policy: request.policy,
      member: message.author.id,
      channel,
      guild: message.guildId ?? undefined,
      message: message.id,
    },
    grant: {
      policy: request.policy,
      memberId: message.author.id,
      messageId: message.id,
      messageChannelId: message.channelId,
      channelId: channel,
      parentChannelId: target.isThread() ? target.parentId ?? undefined : undefined,
      guildId: message.guildId ?? undefined,
    },
    target: target as unknown as RenderTarget,
  };
}

async function interactionWork(
  interaction: ChatInputCommandInteraction,
  config: ConnectorConfig,
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
    if (source) override = parseOverride(source);
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
  return {
    policy: selected.policy,
    input,
    override,
    context: {
      application: config.identity.application,
      policy: selected.policy,
      member,
      channel: interaction.channelId,
      guild: interaction.guildId ?? undefined,
      message: interaction.id,
    },
    grant: {
      policy: selected.policy,
      memberId: member,
      channelId: interaction.channelId,
      parentChannelId: parent,
      guildId: interaction.guildId ?? undefined,
    },
    target,
  };
}

function task(work: Work, config: ConnectorConfig, rpc: DiscordRpcServer) {
  return Effect.gen(function* () {
    const policy = config.policies[work.policy];
    const grant = policy.discord
      ? yield* Effect.acquireRelease(
        Effect.sync(() => rpc.grant(work.grant)),
        (grant) => Effect.sync(() => grant.revoke()),
      )
      : undefined;
    const renderer = new DiscordRenderer(work.target, config.limits.outputMessages);
    let execution = runAgent({
      policy,
      policies: config.policies,
      context: work.context,
      input: work.input,
      override: work.override,
      discord: grant,
    }).pipe(
      Stream.runForEach((event) => attempt(() => renderer.write(decoder.decode(event.output)))),
    );
    if (config.limits.lifetimeMs !== undefined) execution = execution.pipe(Effect.timeout(config.limits.lifetimeMs));
    yield* execution;
  });
}
