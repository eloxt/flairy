//! Per-resource audience model shared by mcp / skill / service config.
//!
//! A resource is either delivered to everyone (`all`, the migration default,
//! preserving today's global behavior) or only to an explicit set of users
//! (`specific`, an empty set therefore meaning "nobody"). Mirrors the
//! `Audience` / `ResourceAssignment` types in `packages/shared/src/config.ts`.

use serde::{Deserialize, Serialize};

/// Delivery scope of a single config resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    /// Delivered to every user.
    All,
    /// Delivered only to the users listed in `resource_assignments`.
    Specific,
}

impl Audience {
    /// The text stored in the resource table's `audience` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Audience::All => "all",
            Audience::Specific => "specific",
        }
    }

    /// Map the DB text column to the enum (defaults to `All` on anything
    /// unknown — the CHECK constraint should already prevent that).
    pub fn from_db(s: &str) -> Self {
        match s {
            "specific" => Audience::Specific,
            _ => Audience::All,
        }
    }
}

/// Assignment payload: the audience mode plus the explicit user list.
///
/// Used ONLY as the `PUT /api/{resource}/{id}/assignment` request body.
/// `user_ids` is ignored when `audience == All`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAssignment {
    pub audience: Audience,
    #[serde(default)]
    pub user_ids: Vec<String>,
}
