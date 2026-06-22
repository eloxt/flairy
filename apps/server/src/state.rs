//! Shared application state passed to REST handlers and socket.io handlers.

use socketioxide::SocketIo;
use sqlx::PgPool;
use std::sync::Arc;

use crate::models::config::ConfigUpdate;
use crate::models::events;

#[derive(Clone)]
pub struct AppState {
    /// Optional pool: `None` when no DB is configured (server still runs).
    pub pool: Option<PgPool>,
    /// HS256 secret for JWT signing/validation.
    pub jwt_secret: Arc<String>,
    /// socket.io handle, used to broadcast config changes to all clients.
    pub io: SocketIo,
}

impl AppState {
    pub fn new(pool: Option<PgPool>, jwt_secret: String, io: SocketIo) -> Self {
        AppState {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            io,
        }
    }

    /// Borrow the pool or return a 503-style error if absent.
    pub fn pool(&self) -> crate::error::AppResult<&PgPool> {
        self.pool
            .as_ref()
            .ok_or(crate::error::AppError::NoDatabase)
    }

    /// Best-effort: rebuild the client config snapshot and push it to every
    /// connected device as `config:updated`. Config is global, so this fans out
    /// to all clients. Failures are logged but never fail the originating request.
    pub async fn broadcast_config(&self) {
        let Some(pool) = &self.pool else { return };
        let snapshot = match crate::db::config::load_client_snapshot(pool).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("config broadcast: snapshot load failed: {e}");
                return;
            }
        };
        let update = ConfigUpdate::from(&snapshot);
        if let Err(e) = self.io.emit(events::CONFIG_UPDATED, &update).await {
            tracing::warn!("config broadcast: emit failed: {e}");
        }
    }
}
