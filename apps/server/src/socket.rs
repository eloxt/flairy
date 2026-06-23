//! socket.io server (socketioxide) wiring.
//!
//! On connect: validate the JWT from the handshake `auth` field, join a room
//! keyed by the user id, and emit `config:snapshot`. Per-connection event
//! handlers for session sync are registered with the user id captured in scope,
//! and `session:remote` is broadcast to the user's other devices.

use socketioxide::extract::{AckSender, Data, SocketRef};
use socketioxide::socket::DisconnectReason;
use socketioxide::SocketIo;

use crate::db;
use crate::models::auth::SocketAuth;
use crate::models::config::ConfigSnapshot;
use crate::models::events;
use crate::models::session::{
    SessionDeletePayload, SessionPatchPayload, SessionPullPayload, SessionRemoteDeletePayload,
    SessionUpsertPayload, SessionWithMessages,
};
use crate::state::AppState;

/// Room name for a user's devices.
fn user_room(user_id: &str) -> String {
    format!("user:{user_id}")
}

/// Register the default-namespace connect handler.
pub fn register(io: &SocketIo, state: AppState) {
    io.ns("/", move |socket: SocketRef, auth: Data<Option<SocketAuth>>| {
        on_connect(socket, auth, state.clone())
    });
}

async fn on_connect(socket: SocketRef, Data(auth): Data<Option<SocketAuth>>, state: AppState) {
    // Validate the handshake JWT.
    let token = match auth.as_ref() {
        Some(a) => a.token.clone(),
        None => {
            tracing::warn!("socket connect without auth; disconnecting");
            let _ = socket.disconnect();
            return;
        }
    };

    let claims = match crate::auth::validate_token(&token, &state.jwt_secret) {
        Ok(c) => c,
        Err(_) => {
            tracing::warn!("socket connect with invalid token; disconnecting");
            let _ = socket.disconnect();
            return;
        }
    };

    let user_id = claims.sub.clone();
    let room = user_room(&user_id);
    socket.join(room.clone());
    tracing::info!(%user_id, "socket connected");

    // Register the per-connection event handlers FIRST — before any `.await`.
    // The client fires `session:pull` the instant it sees `connect`; if we awaited
    // (e.g. load_snapshot's DB round-trip) before registering, that event would
    // arrive with no handler and be dropped silently (no ack → client hangs).
    // Synchronous `socket.on(...)` registration up front closes that race window.

    // ---- session:upsert ----
    {
        let state = state.clone();
        let uid = user_id.clone();
        socket.on(
            events::SESSION_UPSERT,
            move |s: SocketRef, Data(payload): Data<SessionUpsertPayload>, ack: AckSender| {
                let state = state.clone();
                let uid = uid.clone();
                async move {
                    let ok = handle_upsert(&state, &uid, &s, payload).await;
                    let _ = ack.send(&ok);
                }
            },
        );
    }

    // ---- session:patch ----
    {
        let state = state.clone();
        let uid = user_id.clone();
        socket.on(
            events::SESSION_PATCH,
            move |s: SocketRef, Data(payload): Data<SessionPatchPayload>, ack: AckSender| {
                let state = state.clone();
                let uid = uid.clone();
                async move {
                    let ok = handle_patch(&state, &uid, &s, payload).await;
                    let _ = ack.send(&ok);
                }
            },
        );
    }

    // ---- session:delete ----
    {
        let state = state.clone();
        let uid = user_id.clone();
        socket.on(
            events::SESSION_DELETE,
            move |s: SocketRef, Data(payload): Data<SessionDeletePayload>, ack: AckSender| {
                let state = state.clone();
                let uid = uid.clone();
                async move {
                    let ok = handle_delete(&state, &uid, &s, payload).await;
                    let _ = ack.send(&ok);
                }
            },
        );
    }

    // ---- session:pull ----
    {
        let state = state.clone();
        let uid = user_id.clone();
        socket.on(
            events::SESSION_PULL,
            move |Data(payload): Data<SessionPullPayload>, ack: AckSender| {
                let state = state.clone();
                let uid = uid.clone();
                async move {
                    let sessions = handle_pull(&state, &uid, payload).await;
                    let _ = ack.send(&sessions);
                }
            },
        );
    }

    // ---- disconnect ----
    {
        let uid = user_id.clone();
        socket.on_disconnect(move |reason: DisconnectReason| {
            let uid = uid.clone();
            async move {
                tracing::debug!(%uid, ?reason, "socket disconnected");
            }
        });
    }

    // Handlers are registered; now do the awaiting work. Emit the initial config
    // snapshot (global, same for every client). Any client event that arrived
    // during this await already has a handler waiting.
    let snapshot = load_snapshot(&state).await;
    if let Err(e) = socket.emit(events::CONFIG_SNAPSHOT, &snapshot) {
        tracing::warn!("failed to emit config snapshot: {e}");
    }
}

/// Load the global client config snapshot, falling back to an empty one.
async fn load_snapshot(state: &AppState) -> ConfigSnapshot {
    match &state.pool {
        Some(pool) => match db::config::load_client_snapshot(pool).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("config load failed: {e}");
                ConfigSnapshot::default_empty()
            }
        },
        None => ConfigSnapshot::default_empty(),
    }
}

async fn handle_upsert(
    state: &AppState,
    user_id: &str,
    socket: &SocketRef,
    payload: SessionUpsertPayload,
) -> bool {
    tracing::debug!(
        event = events::SESSION_UPSERT,
        %user_id,
        session_id = %payload.session.id,
        messages = payload.messages.len(),
        "recv socket event"
    );
    let Some(pool) = &state.pool else {
        tracing::warn!("session:upsert with no DB");
        return false;
    };
    if let Err(e) =
        db::upsert_session(pool, user_id, &payload.session, &payload.messages).await
    {
        tracing::warn!("session:upsert failed: {e}");
        return false;
    }
    broadcast_remote(
        socket,
        user_id,
        SessionWithMessages {
            session: payload.session,
            messages: payload.messages,
        },
    )
    .await;
    true
}

async fn handle_patch(
    state: &AppState,
    user_id: &str,
    socket: &SocketRef,
    payload: SessionPatchPayload,
) -> bool {
    tracing::debug!(
        event = events::SESSION_PATCH,
        %user_id,
        session_id = %payload.session_id,
        append = payload.append_messages.len(),
        title = payload.title.is_some(),
        "recv socket event"
    );
    let Some(pool) = &state.pool else {
        tracing::warn!("session:patch with no DB");
        return false;
    };
    if let Err(e) = db::patch_session(
        pool,
        &payload.session_id,
        &payload.append_messages,
        payload.updated_at,
        payload.title,
    )
    .await
    {
        tracing::warn!("session:patch failed: {e}");
        return false;
    }

    // Push the full updated session to the user's other devices.
    if let Ok(Some(full)) = db::fetch_session(pool, &payload.session_id).await {
        broadcast_remote(socket, user_id, full).await;
    }
    true
}

async fn handle_delete(
    state: &AppState,
    user_id: &str,
    socket: &SocketRef,
    payload: SessionDeletePayload,
) -> bool {
    tracing::debug!(
        event = events::SESSION_DELETE,
        %user_id,
        session_id = %payload.session_id,
        "recv socket event"
    );
    let Some(pool) = &state.pool else {
        tracing::warn!("session:delete with no DB");
        return false;
    };
    match db::delete_session(pool, user_id, &payload.session_id).await {
        Ok(removed) => {
            // Tell the user's other devices to drop it too. Emit even when the
            // row was already gone — the sender's ack still reports the result.
            broadcast_remote_delete(socket, user_id, &payload.session_id).await;
            removed
        }
        Err(e) => {
            tracing::warn!("session:delete failed: {e}");
            false
        }
    }
}

async fn handle_pull(
    state: &AppState,
    user_id: &str,
    payload: SessionPullPayload,
) -> Vec<SessionWithMessages> {
    tracing::debug!(
        event = events::SESSION_PULL,
        %user_id,
        since = ?payload.since,
        "recv socket event"
    );
    let Some(pool) = &state.pool else {
        return Vec::new();
    };
    match db::pull_sessions(pool, user_id, payload.since).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("session:pull failed: {e}");
            Vec::new()
        }
    }
}

/// Emit `session:remote` to every device in the user's room EXCEPT the sender.
async fn broadcast_remote(socket: &SocketRef, user_id: &str, payload: SessionWithMessages) {
    let room = user_room(user_id);
    if let Err(e) = socket
        .to(room)
        .emit(events::SESSION_REMOTE, &payload)
        .await
    {
        tracing::warn!("session:remote broadcast failed: {e}");
    }
}

/// Emit `session:remote-delete` to the user's other devices (not the sender).
async fn broadcast_remote_delete(socket: &SocketRef, user_id: &str, session_id: &str) {
    let room = user_room(user_id);
    let payload = SessionRemoteDeletePayload {
        session_id: session_id.to_string(),
    };
    if let Err(e) = socket
        .to(room)
        .emit(events::SESSION_REMOTE_DELETE, &payload)
        .await
    {
        tracing::warn!("session:remote-delete broadcast failed: {e}");
    }
}
