#[cfg(not(target_arch = "wasm32"))]
mod native;

#[cfg(not(target_arch = "wasm32"))]
#[tokio::main]
async fn main() {
    if native::serve().await.is_err() {
        // Upstream errors can contain credentials/URLs. Never format them.
        eprintln!("Gateway stopped: configuration or listener failure");
        std::process::exit(1);
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
