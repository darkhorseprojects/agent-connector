use crate::{
    config::{Deployment, Policy},
    credentials::Token,
    invoke::{self, Invocation},
};
use anyhow::{Context as _, Result, anyhow};
use serenity::{
    Client,
    all::{ChannelId, Context, EventHandler, GatewayIntents, Message, Ready},
    async_trait,
    builder::{CreateAllowedMentions, CreateMessage},
    http::Http,
};
use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Semaphore, mpsc, watch};

const ACTIVE: usize = 4;
const WAITING: usize = 32;
const SEEN: usize = 4_096;
const BUSY: &str = "Agent Connector is busy.";
const FAILED: &str = "Agent Connector could not complete the request.";
const SHUTTING_DOWN: &str = "Agent Connector is shutting down.";

#[derive(Default)]
pub struct RuntimeState {
    pub ready: AtomicBool,
    pub active: AtomicUsize,
    pub queued: AtomicUsize,
}

struct RoutedRequest {
    channel: ChannelId,
    actor: u64,
    content: String,
    policy: Policy,
    http: Arc<Http>,
}

struct Handler {
    deployment: Arc<Deployment>,
    queue: mpsc::Sender<RoutedRequest>,
    seen: Mutex<Seen>,
    events: mpsc::UnboundedSender<Result<()>>,
    state: Arc<RuntimeState>,
}

#[derive(Default)]
struct Seen {
    order: VecDeque<u64>,
    ids: HashSet<u64>,
}

impl Seen {
    fn insert(&mut self, id: u64) -> bool {
        if !self.ids.insert(id) {
            return false;
        }
        self.order.push_back(id);
        if self.order.len() > SEEN {
            self.ids
                .remove(&self.order.pop_front().expect("seen queue is nonempty"));
        }
        true
    }
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, _context: Context, ready: Ready) {
        let result = if ready.user.id.get() == self.deployment.config.discord.bot {
            self.state.ready.store(true, Ordering::Release);
            Ok(())
        } else {
            Err(anyhow!(
                "Discord gateway connected as unexpected bot {}",
                ready.user.id
            ))
        };
        let _ = self.events.send(result);
    }

    async fn message(&self, context: Context, message: Message) {
        if message.author.bot || message.webhook_id.is_some() {
            return;
        }
        let Some((policy, content)) = route(&self.deployment, &message) else {
            return;
        };
        if !self
            .seen
            .lock()
            .expect("seen lock poisoned")
            .insert(message.id.get())
        {
            return;
        }
        let request = RoutedRequest {
            channel: message.channel_id,
            actor: message.author.id.get(),
            content,
            policy,
            http: context.http,
        };
        self.state.queued.fetch_add(1, Ordering::AcqRel);
        match self.queue.try_send(request) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(request)) => {
                self.state.queued.fetch_sub(1, Ordering::AcqRel);
                let _ = send(&request.http, request.channel, BUSY).await;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.state.queued.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}

pub async fn serve(
    deployment: Arc<Deployment>,
    token: Token,
    agent: PathBuf,
    mut shutdown: watch::Receiver<bool>,
    state: Arc<RuntimeState>,
) -> Result<()> {
    let (queue_tx, queue_rx) = mpsc::channel(WAITING);
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let handler = Handler {
        deployment: deployment.clone(),
        queue: queue_tx,
        seen: Mutex::new(Seen::default()),
        events: event_tx.clone(),
        state: state.clone(),
    };
    let intents =
        GatewayIntents::GUILDS | GatewayIntents::GUILD_MESSAGES | GatewayIntents::DIRECT_MESSAGES;
    let mut client = Client::builder(token.expose(), intents)
        .event_handler(handler)
        .await
        .context("cannot create Discord client")?;
    let shards = client.shard_manager.clone();
    let worker_shutdown = shutdown.clone();
    let worker_state = state.clone();
    let workers = tokio::spawn(async move {
        if let Err(error) =
            dispatch(queue_rx, deployment, agent, worker_shutdown, worker_state).await
        {
            let _ = event_tx.send(Err(error));
        }
    });
    let mut running = Box::pin(client.start());
    let outcome = loop {
        tokio::select! {
            result = &mut running => break result.context("Discord gateway failed"),
            event = event_rx.recv() => match event {
                Some(Ok(())) => {}
                Some(Err(error)) => break Err(error),
                None => break Err(anyhow!("Discord event handler stopped")),
            },
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    shards.shutdown_all().await;
                }
            }
        }
    };
    shards.shutdown_all().await;
    state.ready.store(false, Ordering::Release);
    drop(running);
    drop(client);
    workers.await.context("request dispatcher failed")?;
    outcome
}

async fn dispatch(
    mut queue: mpsc::Receiver<RoutedRequest>,
    deployment: Arc<Deployment>,
    agent: PathBuf,
    mut shutdown: watch::Receiver<bool>,
    state: Arc<RuntimeState>,
) -> Result<()> {
    let permits = Arc::new(Semaphore::new(ACTIVE));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while let Some(result) = tasks.try_join_next() {
            result.context("request worker panicked")?;
        }
        if *shutdown.borrow() {
            queue.close();
            while let Ok(request) = queue.try_recv() {
                state.queued.fetch_sub(1, Ordering::AcqRel);
                let _ = send(&request.http, request.channel, SHUTTING_DOWN).await;
            }
            break;
        }
        let permit = tokio::select! {
            permit = permits.clone().acquire_owned() => permit.context("worker semaphore closed")?,
            changed = shutdown.changed() => {
                if changed.is_err() { break; }
                continue;
            }
        };
        let Some(request) = queue.recv().await else {
            drop(permit);
            break;
        };
        state.queued.fetch_sub(1, Ordering::AcqRel);
        state.active.fetch_add(1, Ordering::AcqRel);
        let deployment = deployment.clone();
        let agent = agent.clone();
        let state = state.clone();
        tasks.spawn(async move {
            let result = invoke::execute(
                &agent,
                Invocation {
                    deployment: &deployment,
                    policy: &request.policy,
                    actor: request.actor,
                    input: &request.content,
                },
            )
            .await;
            if let Err(error) = &result {
                eprintln!("agent invocation failed: {error:#}");
            }
            let content = result.as_deref().unwrap_or(FAILED);
            if let Err(error) = send(&request.http, request.channel, content).await {
                eprintln!("Discord send failed: {error:#}");
            }
            state.active.fetch_sub(1, Ordering::AcqRel);
            drop(permit);
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.context("request worker panicked")?;
    }
    Ok(())
}

async fn send(http: &Http, channel: ChannelId, content: &str) -> Result<()> {
    let mentions = CreateAllowedMentions::new()
        .all_users(false)
        .all_roles(false)
        .everyone(false)
        .replied_user(false);
    let message = CreateMessage::new()
        .content(content)
        .allowed_mentions(mentions);
    channel.send_message(http, message).await?;
    Ok(())
}

fn route(deployment: &Deployment, message: &Message) -> Option<(Policy, String)> {
    select(
        deployment,
        message.guild_id.map(|id| id.get()),
        message.channel_id.get(),
        message.author.id.get(),
        message
            .mentions
            .iter()
            .any(|user| user.id.get() == deployment.config.discord.bot),
        &message.content,
    )
}

fn select(
    deployment: &Deployment,
    guild: Option<u64>,
    channel: u64,
    author: u64,
    mentioned: bool,
    content: &str,
) -> Option<(Policy, String)> {
    if let Some(guild) = guild {
        if !mentioned {
            return None;
        }
        let policy = deployment
            .config
            .channels
            .get(&channel)
            .or_else(|| deployment.config.guilds.get(&guild))?;
        let plain = format!("<@{}>", deployment.config.discord.bot);
        let nick = format!("<@!{}>", deployment.config.discord.bot);
        Some((
            deployment.config.policies.get(policy)?.clone(),
            content.replace(&plain, "").replace(&nick, ""),
        ))
    } else {
        let policy = deployment.config.users.get(&author)?;
        Some((
            deployment.config.policies.get(policy)?.clone(),
            content.to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{Seen, select};
    use crate::config::{Config, Deployment, Discord, Identity, Policy};
    use std::{collections::BTreeMap, path::PathBuf, time::Duration};

    fn deployment() -> Deployment {
        let policy = Policy {
            entry: "main.md".into(),
            authority: vec![],
            directory: PathBuf::from("/"),
            memory: "1MiB".into(),
            timeout: "1s".into(),
            timeout_value: Duration::from_secs(1),
        };
        Deployment {
            root: PathBuf::from("/agent"),
            identity: Identity("test".into()),
            config: Config {
                discord: Discord {
                    application: 1,
                    bot: 9,
                },
                policies: BTreeMap::from([
                    ("user".into(), policy.clone()),
                    ("channel".into(), policy.clone()),
                    ("guild".into(), policy),
                ]),
                users: BTreeMap::from([(2, "user".into())]),
                channels: BTreeMap::from([(3, "channel".into())]),
                guilds: BTreeMap::from([(4, "guild".into())]),
            },
        }
    }

    #[test]
    fn routes_dms_and_mentioned_guild_messages() {
        let deployment = deployment();
        assert_eq!(
            select(&deployment, None, 8, 2, false, " exact ").unwrap().1,
            " exact "
        );
        assert!(select(&deployment, None, 8, 7, false, "ignored").is_none());
        assert!(select(&deployment, Some(4), 3, 2, false, "ignored").is_none());
        assert_eq!(
            select(&deployment, Some(4), 3, 2, true, "<@9> channel")
                .unwrap()
                .1,
            " channel"
        );
        assert_eq!(
            select(&deployment, Some(4), 8, 2, true, "guild <@!9>")
                .unwrap()
                .1,
            "guild "
        );
        assert!(select(&deployment, Some(8), 8, 2, true, "ignored").is_none());
    }

    #[test]
    fn seen_is_bounded() {
        let mut seen = Seen::default();
        assert!(seen.insert(1));
        assert!(!seen.insert(1));
        for id in 2..=4097 {
            assert!(seen.insert(id));
        }
        assert!(seen.insert(1));
    }
}
