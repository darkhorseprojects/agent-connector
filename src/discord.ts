import type { ConnectorConfig } from "./config.ts";
import { RequestQueue } from "./queue.ts";
import { runAgent } from "./invoke.ts";
import { splitDiscordMessage, deriveThreadTitle } from "./format.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_BASE = "https://discord.com/api/v10";
// GUILDS (1) | GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096) = 4609
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12);

export interface DiscordGatewayOptions {
  token: string;
  config: ConnectorConfig;
  agentName?: string;
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

enum GatewayOp {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  PresenceUpdate = 3,
  VoiceStateUpdate = 4,
  Resume = 6,
  Reconnect = 7,
  RequestGuildMembers = 8,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatACK = 11,
}

export class DiscordConnector {
  readonly #token: string;
  readonly #config: ConnectorConfig;
  readonly #agentName: string;
  readonly #queue = new RequestQueue(4, 32);
  readonly #activeThreads = new Map<string, string>(); // threadId -> policyName
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatAcked = true;
  #sessionId: string | null = null;
  #sequence: number | null = null;
  #reconnectAttempts = 0;
  #signal?: AbortSignal;
  #onReady?: (user: string) => void;

  constructor(options: DiscordGatewayOptions) {
    this.#token = options.token;
    this.#config = options.config;
    this.#agentName = options.agentName || "Agent";
    this.#signal = options.signal;
    this.#onReady = options.onReady;
  }

  async start(): Promise<void> {
    this.#connect();
    if (this.#signal) {
      this.#signal.addEventListener("abort", () => this.stop());
    }
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
        const payload = JSON.parse(String(event.data));
        this.#handlePayload(payload);
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
        const delay = Math.min(30000, 1000 * Math.pow(2, this.#reconnectAttempts)) + Math.floor(Math.random() * 1000);
        this.#reconnectAttempts++;
        console.warn(`Gateway closed (${event.code}). Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        setTimeout(() => this.#connect(), delay);
      }
    };

    ws.onerror = (err) => console.error("Gateway WebSocket error:", err);
  }

  #handlePayload(payload: { op: number; d: any; s?: number; t?: string }): void {
    if (payload.s != null) this.#sequence = payload.s;

    switch (payload.op) {
      case GatewayOp.Hello: {
        const interval = payload.d.heartbeat_interval;
        this.#heartbeatAcked = true;
        setTimeout(() => {
          this.#sendHeartbeat();
          this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), interval);
        }, Math.floor(interval * Math.random()));

        if (this.#sessionId && this.#sequence !== null) {
          this.#send(GatewayOp.Resume, { token: this.#token, session_id: this.#sessionId, seq: this.#sequence });
        } else {
          this.#send(GatewayOp.Identify, {
            token: this.#token,
            intents: INTENTS,
            properties: { os: Deno.build.os, browser: "AgentConnector", device: "AgentConnector" },
            presence: {
              status: "online",
              activities: [{ name: this.#agentName, type: 0 }],
              afk: false,
              since: null,
            },
          });
        }
        break;
      }

      case GatewayOp.HeartbeatACK:
        this.#heartbeatAcked = true;
        break;

      case GatewayOp.Heartbeat:
        this.#sendHeartbeat();
        break;

      case GatewayOp.Reconnect:
        this.#ws?.close(4000, "reconnect requested");
        break;

      case GatewayOp.InvalidSession:
        this.#sessionId = null;
        setTimeout(() => this.#connect(), 1000);
        break;

      case GatewayOp.Dispatch:
        if (payload.t === "READY") {
          this.#sessionId = payload.d.session_id;
          this.#reconnectAttempts = 0;
          const u = payload.d.user;
          const tag = `${u.username}${u.discriminator === "0" ? "" : `#${u.discriminator}`}`;
          this.#onReady?.(tag);
        } else if (payload.t === "MESSAGE_CREATE") {
          this.#handleMessage(payload.d);
        }
        break;
    }
  }

  #sendHeartbeat(): void {
    if (!this.#heartbeatAcked) {
      this.#ws?.close(4000, "heartbeat timeout");
      return;
    }
    this.#heartbeatAcked = false;
    this.#send(GatewayOp.Heartbeat, this.#sequence);
  }

  #send(op: GatewayOp, d: any): void {
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
    let createThreadForMessage = false;

    if (!guildId) {
      // Direct Message
      policyName = this.#config.users[authorId];
      inputContent = msg.content || "";
    } else if (this.#activeThreads.has(channelId)) {
      // Seamless conversation continuation inside active thread
      policyName = this.#activeThreads.get(channelId);
      inputContent = msg.content || "";
      createThreadForMessage = false;
    } else {
      // Guild Channel
      const stripped = stripBotMention(msg.content || "", this.#config.discord.bot);

      if (stripped !== null) {
        inputContent = stripped;
        policyName = this.#config.channels[channelId] || this.#config.guilds[guildId];
        if (msg.thread !== undefined || msg.type === 11 || msg.type === 12) {
          if (policyName) this.#activeThreads.set(channelId, policyName);
        }
      } else if (this.#config.channels[channelId]) {
        inputContent = msg.content || "";
        policyName = this.#config.channels[channelId];
        const isAlreadyThread = msg.thread !== undefined || msg.type === 11 || msg.type === 12;
        createThreadForMessage = !isAlreadyThread;
      } else {
        return;
      }
    }

    if (!policyName || !this.#config.policies[policyName]) return;
    const policy = this.#config.policies[policyName];

    try {
      const response = await this.#queue.run(() => runAgent(policy, authorId, inputContent));
      const chunks = splitDiscordMessage(response, 2000);

      if (createThreadForMessage) {
        const initialTitle = deriveThreadTitle(inputContent);
        const threadId = await this.#createThread(channelId, msg.id, initialTitle);
        const targetChannel = threadId || channelId;
        if (threadId) {
          this.#activeThreads.set(threadId, policyName);
        }
        for (let i = 0; i < chunks.length; i++) {
          await this.#sendMessage(targetChannel, i === 0 && !threadId ? msg.id : undefined, chunks[i]);
        }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          await this.#sendMessage(channelId, i === 0 ? msg.id : undefined, chunks[i]);
        }
      }
    } catch (err: any) {
      const isBusy = err.message === "Agent Connector is busy.";
      const errorText = isBusy
        ? "Agent Connector is busy."
        : `⚠️ ${this.#agentName} encountered an error:\n> ${err.message || "Unknown error"}`;
      await this.#sendMessage(channelId, msg.id, errorText);
      if (!isBusy) {
        console.error(`[${this.#agentName}] Execution error:`, err);
      }
    }
  }

  async #createThread(channelId: string, messageId: string, name: string): Promise<string | null> {
    try {
      const url = `${API_BASE}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.#token}`,
          "Content-Type": "application/json",
          "User-Agent": "AgentConnector/0.2",
        },
        body: JSON.stringify({
          name: name.slice(0, 100),
          auto_archive_duration: 60,
        }),
      });
      if (res.ok) {
        const thread = await res.json();
        return String(thread.id);
      }
    } catch (_e) {}
    return null;
  }

  async #sendMessage(channelId: string, replyToMessageId: string | undefined, text: string): Promise<void> {
    const url = `${API_BASE}/channels/${encodeURIComponent(channelId)}/messages`;
    const payload: Record<string, unknown> = {
      content: text,
      allowed_mentions: { parse: [] },
    };
    if (replyToMessageId) {
      payload.message_reference = { message_id: replyToMessageId };
    }

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.#token}`,
        "Content-Type": "application/json",
        "User-Agent": "AgentConnector/0.2",
      },
      body: JSON.stringify(payload),
    });
  }
}
