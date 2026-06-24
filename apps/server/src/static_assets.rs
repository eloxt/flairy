//! Serve the admin SPA bundled into the binary.
//!
//! When built with `--features embed-admin`, the contents of `apps/admin/dist`
//! are embedded at compile time and served from the same origin as the REST API
//! (so the admin can call `/api/...` relative paths). Without the feature this
//! is a no-op and the server runs API-only — handy for dev builds that haven't
//! built the frontend.

use axum::Router;

use crate::state::AppState;

#[cfg(feature = "embed-admin")]
pub fn attach(router: Router<AppState>) -> Router<AppState> {
    use axum::http::{header, StatusCode, Uri};
    use axum::response::{IntoResponse, Response};
    use rust_embed::RustEmbed;

    #[derive(RustEmbed)]
    #[folder = "../admin/dist"]
    struct AdminAssets;

    /// Fallback for any request the API/socket routers didn't handle. Serves the
    /// matching embedded asset, or `index.html` so client-side routes resolve.
    async fn serve(uri: Uri) -> Response {
        let path = uri.path();
        // API / socket.io misses must 404 rather than return the SPA shell.
        if path.starts_with("/api") || path.starts_with("/socket.io") {
            return StatusCode::NOT_FOUND.into_response();
        }

        let rel = path.trim_start_matches('/');
        let rel = if rel.is_empty() { "index.html" } else { rel };

        if let Some(asset) = AdminAssets::get(rel) {
            let mime = mime_guess::from_path(rel).first_or_octet_stream();
            return (
                [(header::CONTENT_TYPE, mime.as_ref())],
                asset.data.into_owned(),
            )
                .into_response();
        }

        // Unknown path with no extension → SPA client route; serve the shell.
        match AdminAssets::get("index.html") {
            Some(asset) => (
                [(header::CONTENT_TYPE, "text/html")],
                asset.data.into_owned(),
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    router.fallback(serve)
}

#[cfg(not(feature = "embed-admin"))]
pub fn attach(router: Router<AppState>) -> Router<AppState> {
    router
}
