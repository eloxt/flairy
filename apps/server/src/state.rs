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

    /// Best-effort: re-push each connected user their OWN audience-filtered
    /// config snapshot as `config:updated`. Resources can now be delivered to a
    /// subset of users, so the broadcast fans out per user (a resource a user
    /// can't see is simply absent from their payload). Failures are logged but
    /// never fail the originating request.
    pub async fn broadcast_config(&self) {
        let Some(pool) = &self.pool else { return };

        // Distinct connected user ids, derived from the `user:{id}` room each
        // connection joins (multiple devices of one user collapse to one load).
        let mut user_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for socket in self.io.sockets() {
            for room in socket.rooms() {
                if let Some(uid) = room.strip_prefix(crate::socket::USER_ROOM_PREFIX) {
                    user_ids.insert(uid.to_string());
                }
            }
        }

        for user_id in user_ids {
            let snapshot = match crate::db::config::load_client_snapshot(pool, &user_id).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("config broadcast: snapshot load failed for {user_id}: {e}");
                    continue;
                }
            };
            let update = ConfigUpdate::from(&snapshot);
            let room = crate::socket::user_room(&user_id);
            if let Err(e) = self.io.to(room).emit(events::CONFIG_UPDATED, &update).await {
                tracing::warn!("config broadcast: emit failed for {user_id}: {e}");
            }
        }
    }
}
