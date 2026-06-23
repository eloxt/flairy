//! Flairy server entrypoint: REST (Axum) + socket.io (socketioxide) + CORS.

mod auth;
mod db;
mod error;
mod models;
mod routes;
mod socket;
mod state;

use socketioxide::SocketIo;
use tower_http::cors::CorsLayer;

use crate::state::AppState;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            // `socketioxide=debug` surfaces the crate's per-event/packet logs
            // (every inbound socket.io event + payload). engineioxide is left at
            // info so low-level transport ping/pong/poll noise stays out.
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,flairy_server=debug,socketioxide=debug".into()),
        )
        .init();

    // Subcommand dispatch: `create-admin` provisions an administrator then exits.
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("create-admin") {
        run_create_admin(&argv[2..]).await;
        return;
    }

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        tracing::warn!("JWT_SECRET not set; using an insecure development default");
        "dev-insecure-secret-change-me".to_string()
    });

    // DB is optional: the server runs without it so it can build/start anywhere.
    let pool = db::connect().await;
    if let Some(p) = &pool {
        if let Err(e) = db::migrate(p).await {
            tracing::warn!("migrations not applied: {e}");
        }
    }

    // socket.io layer. Built before AppState so the state can hold the `io`
    // handle and broadcast config changes from REST handlers.
    let (socket_layer, io) = SocketIo::new_layer();

    let app_state = AppState::new(pool, jwt_secret, io.clone());
    socket::register(&io, app_state.clone());

    // REST + socket.io + permissive CORS (dev).
    let app = routes::router(app_state)
        .layer(socket_layer)
        .layer(CorsLayer::very_permissive());

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind");
    tracing::info!("listening on {bind_addr}");

    axum::serve(listener, app)
        .await
        .expect("server error");
}

/// `create-admin <email> <password> [display_name]` — bootstrap the first
/// administrator (or promote/reset an existing user). Requires `DATABASE_URL`.
async fn run_create_admin(args: &[String]) {
    let (email, password) = match (args.first(), args.get(1)) {
        (Some(e), Some(p)) => (e.as_str(), p.as_str()),
        _ => {
            eprintln!("usage: flairy-server create-admin <email> <password> [display_name]");
            std::process::exit(2);
        }
    };
    let display_name = args.get(2).map(String::as_str).unwrap_or("Administrator");

    let Some(pool) = db::connect().await else {
        eprintln!("error: DATABASE_URL is not set or the database is unreachable");
        std::process::exit(1);
    };
    if let Err(e) = db::migrate(&pool).await {
        eprintln!("error: migrations failed: {e}");
        std::process::exit(1);
    }

    let hash = match auth::hash_password(password) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("error: failed to hash password: {e}");
            std::process::exit(1);
        }
    };

    match db::upsert_admin(&pool, email, display_name, &hash).await {
        Ok(user) => {
            println!("admin ready: {} (id {}, role {})", user.email, user.id, user.role);
        }
        Err(e) => {
            eprintln!("error: failed to create admin: {e}");
            std::process::exit(1);
        }
    }
}
