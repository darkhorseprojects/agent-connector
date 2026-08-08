import type { ConnectorConfig } from "./config.ts";
import { RequestQueue } from "./queue.ts";
import { runAgent } from "./invoke.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES = 4609

export interface DiscordGatewayOptions {
  token: string;
  config: ConnectorConfig;
  signal?: AbortSignal;
  onReady?: (user: string) => void;
}

export function stripBotMention(content: string, botId: string): string | null {
  const std = `<@${botId}>`;
  const nick = `<@!${botId}>`;
  const idx = content.indexOf(std);
  if (idx !== -1) return content.slice(0, idx) + content.slice(idx + std.length);
  const idxNick = content.indexOf(nick);
  if (idxNick !== -1) return content.slice(0, idxNick) + content.slice(idxNick + nick.length);
  return null;
}

export class DiscordConnector {
  readonly #token: string;
  readonly #config: ConnectorConfig;
  readonly #queue = new RequestQueue(4, 32);
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatAcked = true;
  #sessionId: string | null = null;
  #sequence: number | null = null;
  #signal?: AbortSignal;
  #onReady?: (user: string) => void;

  constructor(options: DiscordGatewayOptions) {
    this.#token = options.token;
    this.#config = options.config;
    this.#signal = options.signal;
    this.#onReady = options.onReady;
  }

  async start(): Promise<void> {
    this.#connect();
    if (this.#signal) this.#signal.addEventListener("abort", () => this.stop());
  }

  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#ws) {
      this.#ws.close(1000, "shutdown");
      this.#ws = null;
    }
  }

  #connect(): void {
    if (this.#signal?.aborted) return;
    const ws = new WebSocket(GATEWAY_URL);
    this.#ws = ws;

    ws.onmessage = (event) => {
      try {
        const p = JSON.parse(String(event.data));
        this.#handlePayload(p);
      } catch (err) {
        console.error("Gateway parse error:", err);
      }
    };

    ws.onclose = (event) => {
      if (this.#heartbeatTimer !== null) {
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = null;
      }
      if (!this.#signal?.aborted && event.code !== 1000) {
        console.warn(`Gateway closed (${event.code}). Reconnecting in 3s...`);
        setTimeout(() => this.#connect(), 3000);
      }
    };

    ws.onerror = (err) => console.error("Gateway WebSocket error:", err);
  }

  #handlePayload(payload: { op: number; d: any; s?: number; t?: string }): void {
    if (payload.s != null) this.#sequence = payload.s;

    if (payload.op === 10) { // Hello
      const interval = payload.d.heartbeat_interval;
      this.#heartbeatAcked = true;
      setTimeout(() => {
        this.#sendHeartbeat();
        this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), interval);
      }, Math.floor(interval * Math.random()));

      if (this.#sessionId && this.#sequence !== null) {
        this.#send(6, { token: this.#token, session_id: this.#sessionId, seq: this.#sequence }); // Resume
      } else {
        this.#send(2, { token: this.#token, intents: INTENTS, properties: { os: Deno.build.os, browser: "AgentConnector", device: "AgentConnector" } }); // Identify
      }
    } else if (payload.op === 11) {
      this.#heartbeatAcked = true;
    } else if (payload.op === 1) {
      this.#sendHeartbeat();
    } else if (payload.op === 7) {
      this.#ws?.close(4000, "reconnect requested");
    } else if (payload.op === 9) {
      this.#sessionId = null;
      setTimeout(() => this.#connect(), 1000);
    } else if (payload.op === 0) {
      if (payload.t === "READY") {
        this.#sessionId = payload.d.session_id;
        const u = payload.d.user;
        this.#onReady?.(`${u.username}#${u.discriminator === "0" ? "" : u.discriminator}`);
      } else if (payload.t === "MESSAGE_CREATE") {
        this.#handleMessage(payload.d);
      }
    }
  }

  #sendHeartbeat(): void {
    if (!this.#heartbeatAcked) {
      this.#ws?.close(4000, "heartbeat timeout");
      return;
    }
    this.#heartbeatAcked = false;
    this.#send(1, this.#sequence);
  }

  #send(op: number, d: any): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ op, d }));
    }
  }

  async #handleMessage(msg: any): Promise<void> {
    if (msg.author?.bot || msg.webhook_id) return;
    const authorId = String(msg.author.id);
    const channelId = String(msg.channel_id);
    const guildId = msg.guild_id ? String(msg.guild_id) : null;

    let inputContent: string;
    let policyName: string | undefined;

    if (!guildId) {
      policyName = this.#config.users[authorId];
      inputContent = msg.content || "";
    } else {
      const stripped = stripBotMention(msg.content || "", this.#config.discord.bot);
      if (stripped === null) return;
      inputContent = stripped;
      policyName = this.#config.channels[channelId] || this.#config.guilds[guildId];
    }

    if (!policyName || !this.#config.policies[policyName]) return;
    const policy = this.#config.policies[policyName];

    try {
      const response = await this.#queue.run(() => runAgent(policy, authorId, inputContent));
      await this.#sendMessage(channelId, msg.id, response);
    } catch (err: any) {
      if (err.message === "Agent Connector is busy.") {
        await this.#sendMessage(channelId, msg.id, "Agent Connector is busy.");
      } else {
        console.error("Execution error:", err);
      }
    }
  }

  async #sendMessage(channelId: string, replyToMessageId: string, text: string): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.#token}`,
        "Content-Type": "application/json",
        "User-Agent": "AgentConnector/0.2",
      },
      body: JSON.stringify({
        content: text,
        message_reference: { message_id: replyToMessageId },
        allowed_mentions: { parse: [] },
      }),
    });
  }
}
