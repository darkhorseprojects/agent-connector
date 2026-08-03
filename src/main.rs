#[tokio::main]
async fn main() {
    if let Err(error) = agent_connector::dispatch(std::env::args_os().skip(1).collect()).await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
