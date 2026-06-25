//! LLM catalog CRUD over two levels: provider connections and their models.
//! Every mutation bumps the global config version.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, parse_uuid};
use crate::error::{AppError, AppResult};
use crate::models::llm::{
    ActiveLlm, LlmModelConfig, LlmModelInput, LlmProviderConfig, LlmProviderInput, LlmRole,
    LlmRoleAssignment, ModelCost, ProviderApi, RoleModels, ThinkingLevel,
};

/// Parse the nullable `thinking_level` TEXT column into the enum. An unknown
/// non-null value (shouldn't happen given the CHECK constraint) degrades to
/// `None` rather than failing the whole read.
fn parse_thinking_level(raw: Option<String>) -> Option<ThinkingLevel> {
    raw.as_deref().and_then(ThinkingLevel::from_str)
}

/// Assemble the four nullable `cost_*` columns into a [`ModelCost`]. Returns
/// `None` only when every column is NULL (the model carries no price); a partial
/// row coalesces missing components to 0.0.
fn build_cost(
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
) -> Option<ModelCost> {
    if input.is_none() && output.is_none() && cache_read.is_none() && cache_write.is_none() {
        return None;
    }
    Some(ModelCost {
        input: input.unwrap_or(0.0),
        output: output.unwrap_or(0.0),
        cache_read: cache_read.unwrap_or(0.0),
        cache_write: cache_write.unwrap_or(0.0),
    })
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

fn map_provider(row: &PgRow) -> AppResult<LlmProviderConfig> {
    let api_str: String = row.get("api");
    let api = ProviderApi::from_str(&api_str)
        .ok_or_else(|| AppError::Internal(format!("unknown provider api in db: {api_str}")))?;
    Ok(LlmProviderConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        api,
        credential: row.get("credential"),
        base_url: row.get("base_url"),
    })
}

const PROVIDER_SELECT: &str = "SELECT id, name, api, credential, base_url FROM llm_providers";

/// All provider connections, oldest first.
pub async fn list_providers(pool: &PgPool) -> AppResult<Vec<LlmProviderConfig>> {
    let rows = sqlx::query(&format!("{PROVIDER_SELECT} ORDER BY created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_provider).collect()
}

/// Insert a new provider connection.
pub async fn create_provider(
    pool: &PgPool,
    input: &LlmProviderInput,
) -> AppResult<(LlmProviderConfig, i64)> {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO llm_providers (id, name, api, credential, base_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, api, credential, base_url",
    )
    .bind(id)
    .bind(&input.name)
    .bind(input.api.as_str())
    .bind(&input.credential)
    .bind(&input.base_url)
    .fetch_one(&mut *tx)
    .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok((map_provider(&row)?, version))
}

/// Update a provider connection. Returns `None` if id is unknown.
pub async fn update_provider(
    pool: &PgPool,
    id: &str,
    input: &LlmProviderInput,
) -> AppResult<Option<(LlmProviderConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE llm_providers
         SET name = $2, api = $3, credential = $4, base_url = $5, updated_at = now()
         WHERE id = $1
         RETURNING id, name, api, credential, base_url",
    )
    .bind(uid)
    .bind(&input.name)
    .bind(input.api.as_str())
    .bind(&input.credential)
    .bind(&input.base_url)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some((map_provider(&row)?, version)))
}

/// Delete a provider (cascades to its models). Returns the new version, or
/// `None` if id is unknown.
pub async fn delete_provider(pool: &PgPool, id: &str) -> AppResult<Option<i64>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let deleted = sqlx::query("DELETE FROM llm_providers WHERE id = $1 RETURNING id")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?;

    if deleted.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

fn map_model(row: &PgRow) -> LlmModelConfig {
    LlmModelConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        provider_id: row.get::<Uuid, _>("provider_id").to_string(),
        name: row.get("name"),
        model: row.get("model"),
        thinking_level: parse_thinking_level(row.get("thinking_level")),
        context_window: row.get("context_window"),
        max_tokens: row.get("max_tokens"),
        cost: build_cost(
            row.get("cost_input"),
            row.get("cost_output"),
            row.get("cost_cache_read"),
            row.get("cost_cache_write"),
        ),
    }
}

const MODEL_SELECT: &str = "SELECT id, provider_id, name, model, thinking_level, \
     context_window, max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write \
     FROM llm_models";

/// The column list every model write returns, kept in sync with [`map_model`].
const MODEL_RETURNING: &str = "id, provider_id, name, model, thinking_level, \
     context_window, max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write";

/// All models across every provider, oldest first.
pub async fn list_models(pool: &PgPool) -> AppResult<Vec<LlmModelConfig>> {
    let rows = sqlx::query(&format!("{MODEL_SELECT} ORDER BY created_at ASC"))
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(map_model).collect())
}

/// Insert a new model under a provider. If no model is currently bound to the
/// `main` role, the new model self-heals into it (e.g. after the bound model was
/// deleted by cascade). Returns an error if the referenced provider does not exist.
pub async fn create_model(
    pool: &PgPool,
    input: &LlmModelInput,
) -> AppResult<(LlmModelConfig, i64)> {
    let id = Uuid::new_v4();
    let provider_uid = parse_uuid(&input.provider_id)?;
    let mut tx = pool.begin().await?;

    let provider_exists: bool =
        sqlx::query("SELECT exists(SELECT 1 FROM llm_providers WHERE id = $1) AS e")
            .bind(provider_uid)
            .fetch_one(&mut *tx)
            .await?
            .get("e");
    if !provider_exists {
        tx.rollback().await?;
        return Err(AppError::NotFound);
    }

    let row = sqlx::query(&format!(
        "INSERT INTO llm_models
            (id, provider_id, name, model, thinking_level, context_window,
             max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING {MODEL_RETURNING}"
    ))
    .bind(id)
    .bind(provider_uid)
    .bind(&input.name)
    .bind(&input.model)
    .bind(input.thinking_level.map(ThinkingLevel::as_str))
    .bind(input.context_window)
    .bind(input.max_tokens)
    .bind(input.cost.as_ref().map(|c| c.input))
    .bind(input.cost.as_ref().map(|c| c.output))
    .bind(input.cost.as_ref().map(|c| c.cache_read))
    .bind(input.cost.as_ref().map(|c| c.cache_write))
    .fetch_one(&mut *tx)
    .await?;

    let has_main: bool =
        sqlx::query("SELECT exists(SELECT 1 FROM llm_role_assignments WHERE role = 'main') AS e")
            .fetch_one(&mut *tx)
            .await?
            .get("e");
    if !has_main {
        sqlx::query("INSERT INTO llm_role_assignments (role, model_id) VALUES ('main', $1)")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok((map_model(&row), version))
}

/// Update a model. Returns `None` if id is unknown.
pub async fn update_model(
    pool: &PgPool,
    id: &str,
    input: &LlmModelInput,
) -> AppResult<Option<(LlmModelConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let provider_uid = parse_uuid(&input.provider_id)?;
    let mut tx = pool.begin().await?;

    let provider_exists: bool =
        sqlx::query("SELECT exists(SELECT 1 FROM llm_providers WHERE id = $1) AS e")
            .bind(provider_uid)
            .fetch_one(&mut *tx)
            .await?
            .get("e");
    if !provider_exists {
        tx.rollback().await?;
        return Err(AppError::NotFound);
    }

    let row = sqlx::query(&format!(
        "UPDATE llm_models
         SET provider_id = $2, name = $3, model = $4, thinking_level = $5,
             context_window = $6, max_tokens = $7, cost_input = $8, cost_output = $9,
             cost_cache_read = $10, cost_cache_write = $11, updated_at = now()
         WHERE id = $1
         RETURNING {MODEL_RETURNING}"
    ))
    .bind(uid)
    .bind(provider_uid)
    .bind(&input.name)
    .bind(&input.model)
    .bind(input.thinking_level.map(ThinkingLevel::as_str))
    .bind(input.context_window)
    .bind(input.max_tokens)
    .bind(input.cost.as_ref().map(|c| c.input))
    .bind(input.cost.as_ref().map(|c| c.output))
    .bind(input.cost.as_ref().map(|c| c.cache_read))
    .bind(input.cost.as_ref().map(|c| c.cache_write))
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some((map_model(&row), version)))
}

/// Delete a model. Returns the new version, or `None` if id is unknown.
pub async fn delete_model(pool: &PgPool, id: &str) -> AppResult<Option<i64>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let deleted = sqlx::query("DELETE FROM llm_models WHERE id = $1 RETURNING id")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?;

    if deleted.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}

// ---------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------

/// Build an [`ActiveLlm`] from a joined role/model/provider row using the
/// `m_*` / `p_*` aliases.
fn map_active(row: &PgRow) -> AppResult<ActiveLlm> {
    let api_str: String = row.get("p_api");
    let api = ProviderApi::from_str(&api_str)
        .ok_or_else(|| AppError::Internal(format!("unknown provider api in db: {api_str}")))?;

    Ok(ActiveLlm {
        provider: LlmProviderConfig {
            id: row.get::<Uuid, _>("p_id").to_string(),
            name: row.get("p_name"),
            api,
            credential: row.get("p_credential"),
            base_url: row.get("p_base_url"),
        },
        model: LlmModelConfig {
            id: row.get::<Uuid, _>("m_id").to_string(),
            provider_id: row.get::<Uuid, _>("m_provider_id").to_string(),
            name: row.get("m_name"),
            model: row.get("m_model"),
            thinking_level: parse_thinking_level(row.get("m_thinking_level")),
            context_window: row.get("m_context_window"),
            max_tokens: row.get("m_max_tokens"),
            cost: build_cost(
                row.get("m_cost_input"),
                row.get("m_cost_output"),
                row.get("m_cost_cache_read"),
                row.get("m_cost_cache_write"),
            ),
        },
    })
}

/// The model (joined with its provider) bound to each role, for the client snapshot.
pub async fn role_models(pool: &PgPool) -> AppResult<RoleModels> {
    let rows = sqlx::query(
        "SELECT
            r.role        AS r_role,
            m.id             AS m_id,
            m.provider_id    AS m_provider_id,
            m.name           AS m_name,
            m.model          AS m_model,
            m.thinking_level AS m_thinking_level,
            m.context_window   AS m_context_window,
            m.max_tokens       AS m_max_tokens,
            m.cost_input       AS m_cost_input,
            m.cost_output      AS m_cost_output,
            m.cost_cache_read  AS m_cost_cache_read,
            m.cost_cache_write AS m_cost_cache_write,
            p.id          AS p_id,
            p.name        AS p_name,
            p.api         AS p_api,
            p.credential  AS p_credential,
            p.base_url    AS p_base_url
         FROM llm_role_assignments r
         JOIN llm_models m ON m.id = r.model_id
         JOIN llm_providers p ON p.id = m.provider_id",
    )
    .fetch_all(pool)
    .await?;

    let mut roles = RoleModels {
        main: None,
        tool: None,
    };
    for row in &rows {
        let role_str: String = row.get("r_role");
        match LlmRole::from_str(&role_str) {
            Some(LlmRole::Main) => roles.main = Some(map_active(row)?),
            Some(LlmRole::Tool) => roles.tool = Some(map_active(row)?),
            None => {}
        }
    }
    Ok(roles)
}

/// All role→model bindings, for the admin read model.
pub async fn list_role_assignments(pool: &PgPool) -> AppResult<Vec<LlmRoleAssignment>> {
    let rows = sqlx::query("SELECT role, model_id FROM llm_role_assignments")
        .fetch_all(pool)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let role_str: String = row.get("role");
        let role = LlmRole::from_str(&role_str)
            .ok_or_else(|| AppError::Internal(format!("unknown role in db: {role_str}")))?;
        out.push(LlmRoleAssignment {
            role,
            model_id: row.get::<Uuid, _>("model_id").to_string(),
        });
    }
    Ok(out)
}

/// Bind `model_id` to `role` (upsert). Returns the new version, or `None` if the
/// model does not exist.
pub async fn assign_role(pool: &PgPool, role: &str, model_id: &str) -> AppResult<Option<i64>> {
    let model_uid = parse_uuid(model_id)?;
    let mut tx = pool.begin().await?;

    let model_exists: bool =
        sqlx::query("SELECT exists(SELECT 1 FROM llm_models WHERE id = $1) AS e")
            .bind(model_uid)
            .fetch_one(&mut *tx)
            .await?
            .get("e");
    if !model_exists {
        tx.rollback().await?;
        return Ok(None);
    }

    sqlx::query(
        "INSERT INTO llm_role_assignments (role, model_id) VALUES ($1, $2)
         ON CONFLICT (role) DO UPDATE SET model_id = excluded.model_id, updated_at = now()",
    )
    .bind(role)
    .bind(model_uid)
    .execute(&mut *tx)
    .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}

/// Clear the binding for `role`. Returns the new version.
pub async fn clear_role(pool: &PgPool, role: &str) -> AppResult<i64> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM llm_role_assignments WHERE role = $1")
        .bind(role)
        .execute(&mut *tx)
        .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(version)
}
