//! Skill repository CRUD (rich Agent-Skills model, no versioning).
//!
//! File bytes live in `skill_file_blobs`, deduped by sha256. File rows
//! (`skill_files`) belong directly to a skill. Every mutation bumps the global
//! config version inside its transaction and sweeps orphaned blobs.

use std::collections::BTreeMap;

use base64::Engine;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use super::{config::bump_version, json_err, parse_uuid};
use crate::error::{AppError, AppResult};
use crate::models::skill::{
    SkillConfig, SkillFile, SkillFileEntry, SkillInput, SkillListItem, SkillSummary,
    UploadFileResponse, SOURCE_TYPE_DATAURL, SOURCE_TYPE_TEXT, SOURCE_TYPE_UPLOAD, SOURCE_TYPE_URL,
};

/// Hard limit on uploaded / embedded file bytes (50 MB).
pub const MAX_SKILL_FILE_SIZE: usize = 50 * 1024 * 1024;

/// Parameters for the paginated, searchable, sortable list query.
#[derive(Debug, Clone)]
pub struct SkillListParams {
    pub limit: i64,
    pub offset: i64,
    pub search: Option<String>,
    /// One of `name` | `updated_at` | `created_at` (validated by the caller).
    pub sort_by: String,
    /// `asc` | `desc` (validated by the caller).
    pub order: String,
}

/* ---------- row mappers ---------- */

fn map_list_item(row: &PgRow) -> AppResult<SkillListItem> {
    let metadata: BTreeMap<String, String> =
        serde_json::from_value(row.get("metadata")).map_err(json_err)?;
    Ok(SkillListItem {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        description: row.get("description"),
        license: row.get("license"),
        compatibility: row.get("compatibility"),
        metadata,
        extra_frontmatter: row.get("extra_frontmatter"),
        allowed_tools: row.get("allowed_tools"),
        enabled: row.get("enabled"),
        file_count: row.get("file_count"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

const LIST_SELECT: &str = "SELECT s.id, s.name, s.description, s.license, s.compatibility, \
    s.metadata, s.extra_frontmatter, s.allowed_tools, s.enabled, s.created_at, s.updated_at, \
    COALESCE(c.cnt, 0) AS file_count \
    FROM skills s \
    LEFT JOIN (SELECT skill_id, COUNT(*) AS cnt FROM skill_files GROUP BY skill_id) c \
    ON c.skill_id = s.id";

/// Map a `sort_by` value to its qualified column (defaults to `created_at`).
fn sort_column(sort_by: &str) -> &'static str {
    match sort_by {
        "name" => "s.name",
        "updated_at" => "s.updated_at",
        _ => "s.created_at",
    }
}

fn order_dir(order: &str) -> &'static str {
    if order.eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    }
}

/// Paginated/searchable list for the admin. Returns `(items, total)`.
pub async fn list(pool: &PgPool, params: &SkillListParams) -> AppResult<(Vec<SkillListItem>, i64)> {
    let order_clause = format!(
        "ORDER BY {} {}",
        sort_column(&params.sort_by),
        order_dir(&params.order)
    );

    let (where_clause, search_like) = match &params.search {
        Some(s) if !s.trim().is_empty() => (
            "WHERE s.name ILIKE $1 OR s.description ILIKE $1".to_string(),
            Some(format!("%{}%", s.trim())),
        ),
        _ => (String::new(), None),
    };

    if let Some(like) = search_like {
        let sql = format!(
            "{LIST_SELECT} {where_clause} {order_clause} LIMIT $2 OFFSET $3"
        );
        let rows = sqlx::query(&sql)
            .bind(&like)
            .bind(params.limit)
            .bind(params.offset)
            .fetch_all(pool)
            .await?;
        let items = rows
            .iter()
            .map(map_list_item)
            .collect::<AppResult<Vec<_>>>()?;

        let total: i64 =
            sqlx::query("SELECT COUNT(*) AS n FROM skills s WHERE s.name ILIKE $1 OR s.description ILIKE $1")
                .bind(&like)
                .fetch_one(pool)
                .await?
                .get("n");
        Ok((items, total))
    } else {
        let sql = format!("{LIST_SELECT} {order_clause} LIMIT $1 OFFSET $2");
        let rows = sqlx::query(&sql)
            .bind(params.limit)
            .bind(params.offset)
            .fetch_all(pool)
            .await?;
        let items = rows
            .iter()
            .map(map_list_item)
            .collect::<AppResult<Vec<_>>>()?;

        let total: i64 = sqlx::query("SELECT COUNT(*) AS n FROM skills")
            .fetch_one(pool)
            .await?
            .get("n");
        Ok((items, total))
    }
}

/// All skills as lightweight summaries for the client config snapshot.
pub async fn list_summaries(pool: &PgPool) -> AppResult<Vec<SkillSummary>> {
    let rows = sqlx::query(
        "SELECT s.id, s.name, s.description, s.enabled, s.updated_at, \
         COALESCE(c.cnt, 0) AS file_count \
         FROM skills s \
         LEFT JOIN (SELECT skill_id, COUNT(*) AS cnt FROM skill_files GROUP BY skill_id) c \
         ON c.skill_id = s.id \
         ORDER BY s.sort_order, s.created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|row| SkillSummary {
            id: row.get::<Uuid, _>("id").to_string(),
            name: row.get("name"),
            description: row.get("description"),
            enabled: row.get("enabled"),
            file_count: row.get("file_count"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

/// All skills as admin list items (used by the admin snapshot).
pub async fn list_items(pool: &PgPool) -> AppResult<Vec<SkillListItem>> {
    let sql = format!("{LIST_SELECT} ORDER BY s.sort_order, s.created_at ASC");
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    rows.iter().map(map_list_item).collect()
}

/// Full skill + files. Hydrates `content` for text and `dataurl` for dataurl.
pub async fn get(pool: &PgPool, id: &str) -> AppResult<Option<SkillConfig>> {
    let uid = parse_uuid(id)?;

    let Some(srow) = sqlx::query(
        "SELECT id, name, description, license, compatibility, metadata, extra_frontmatter, \
         allowed_tools, skill_md_body, enabled, created_at, updated_at \
         FROM skills WHERE id = $1",
    )
    .bind(uid)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let file_rows = sqlx::query(
        "SELECT f.id, f.skill_id, f.path, f.source_type, f.source_url, f.blob_id, \
         f.mime_type, f.file_size_bytes, f.created_at, f.updated_at, b.data AS blob_data \
         FROM skill_files f \
         LEFT JOIN skill_file_blobs b ON b.id = f.blob_id \
         WHERE f.skill_id = $1 \
         ORDER BY f.path ASC",
    )
    .bind(uid)
    .fetch_all(pool)
    .await?;

    let mut files = Vec::with_capacity(file_rows.len());
    for row in &file_rows {
        let source_type: String = row.get("source_type");
        let blob_data: Option<Vec<u8>> = row.try_get("blob_data").ok().flatten();
        let mime_type: String = row.get("mime_type");

        let (content, dataurl) = match source_type.as_str() {
            SOURCE_TYPE_TEXT => {
                let text = blob_data
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned());
                (text, None)
            }
            SOURCE_TYPE_DATAURL => {
                let durl = blob_data.as_ref().map(|b| {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(b);
                    format!("data:{mime_type};base64,{encoded}")
                });
                (None, durl)
            }
            _ => (None, None),
        };

        files.push(SkillFile {
            id: row.get::<Uuid, _>("id").to_string(),
            skill_id: row.get::<Uuid, _>("skill_id").to_string(),
            path: row.get("path"),
            source_type,
            content,
            source_url: row.get("source_url"),
            dataurl,
            mime_type,
            file_size_bytes: row.get("file_size_bytes"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        });
    }

    let metadata: BTreeMap<String, String> =
        serde_json::from_value(srow.get("metadata")).map_err(json_err)?;

    Ok(Some(SkillConfig {
        id: srow.get::<Uuid, _>("id").to_string(),
        name: srow.get("name"),
        description: srow.get("description"),
        license: srow.get("license"),
        compatibility: srow.get("compatibility"),
        metadata,
        extra_frontmatter: srow.get("extra_frontmatter"),
        allowed_tools: srow.get("allowed_tools"),
        skill_md_body: srow.get("skill_md_body"),
        enabled: srow.get("enabled"),
        file_count: files.len() as i64,
        created_at: srow.get("created_at"),
        updated_at: srow.get("updated_at"),
        files,
    }))
}

/* ---------- blob helpers ---------- */

/// Insert a blob (or reuse an existing one with the same sha256). Returns the
/// blob id and the byte length.
async fn upsert_blob(
    tx: &mut Transaction<'_, Postgres>,
    data: &[u8],
) -> AppResult<(Uuid, i64)> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut sha = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(sha, "{byte:02x}");
    }

    if let Some(row) = sqlx::query("SELECT id FROM skill_file_blobs WHERE sha256 = $1")
        .bind(&sha)
        .fetch_optional(&mut **tx)
        .await?
    {
        return Ok((row.get::<Uuid, _>("id"), data.len() as i64));
    }

    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO skill_file_blobs (id, sha256, data) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&sha)
        .bind(data)
        .execute(&mut **tx)
        .await?;
    Ok((id, data.len() as i64))
}

/// Decode the bytes a file entry contributes to a blob, if any. Returns
/// `Ok(None)` for sources that carry no inline bytes (url).
fn entry_bytes(entry: &SkillFileEntry) -> AppResult<Option<Vec<u8>>> {
    match entry.source_type.as_str() {
        // text + upload entries carry their bytes inline as `content`; an upload
        // is materialized into a deduped blob just like text (the upload endpoint
        // returns the blob id for display, but the save resends the bytes).
        SOURCE_TYPE_TEXT | SOURCE_TYPE_UPLOAD => {
            if let Some(c) = &entry.content {
                return Ok(Some(c.as_bytes().to_vec()));
            }
            decode_dataurl(entry.dataurl.as_deref())
        }
        SOURCE_TYPE_DATAURL => decode_dataurl(entry.dataurl.as_deref()),
        // url carries no bytes (fetched live by the client).
        _ => Ok(None),
    }
}

/// Decode the base64 payload of a `data:...;base64,...` URL, if present.
fn decode_dataurl(dataurl: Option<&str>) -> AppResult<Option<Vec<u8>>> {
    let Some(durl) = dataurl else { return Ok(None) };
    let b64 = durl
        .split(";base64,")
        .nth(1)
        .ok_or_else(|| AppError::BadRequest("invalid dataurl".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| AppError::BadRequest(format!("invalid dataurl base64: {e}")))?;
    Ok(Some(bytes))
}

/// Delete blob rows no longer referenced by any `skill_files`.
async fn sweep_orphan_blobs(tx: &mut Transaction<'_, Postgres>) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM skill_file_blobs b \
         WHERE NOT EXISTS (SELECT 1 FROM skill_files f WHERE f.blob_id = b.id)",
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Insert the file rows for a skill within a transaction, deduping blobs.
async fn insert_files(
    tx: &mut Transaction<'_, Postgres>,
    skill_id: Uuid,
    files: &[SkillFileEntry],
) -> AppResult<()> {
    for entry in files {
        if entry.path.trim().is_empty() {
            return Err(AppError::BadRequest("file path is required".into()));
        }
        if entry.source_type.trim().is_empty() {
            return Err(AppError::BadRequest("file source_type is required".into()));
        }

        let mime_type = entry
            .mime_type
            .clone()
            .unwrap_or_else(|| "text/plain".to_string());

        let (blob_id, source_url, file_size_bytes): (Option<Uuid>, Option<String>, i64) =
            match entry.source_type.as_str() {
                SOURCE_TYPE_URL => (None, entry.source_url.clone(), 0),
                _ => match entry_bytes(entry)? {
                    Some(bytes) => {
                        if bytes.len() > MAX_SKILL_FILE_SIZE {
                            return Err(AppError::BadRequest(
                                "file exceeds 50 MB limit".into(),
                            ));
                        }
                        let (id, len) = upsert_blob(tx, &bytes).await?;
                        (Some(id), None, len)
                    }
                    None => (None, None, entry.file_size_bytes.unwrap_or(0)),
                },
            };

        sqlx::query(
            "INSERT INTO skill_files \
             (id, skill_id, path, source_type, source_url, blob_id, mime_type, file_size_bytes) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::new_v4())
        .bind(skill_id)
        .bind(entry.path.trim())
        .bind(&entry.source_type)
        .bind(&source_url)
        .bind(blob_id)
        .bind(&mime_type)
        .bind(file_size_bytes)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/* ---------- mutations ---------- */

pub async fn create(pool: &PgPool, input: &SkillInput) -> AppResult<(SkillConfig, i64)> {
    let id = Uuid::new_v4();
    let metadata = serde_json::to_value(&input.metadata).map_err(json_err)?;

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO skills \
         (id, name, description, license, compatibility, metadata, extra_frontmatter, \
          allowed_tools, skill_md_body, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.license)
    .bind(&input.compatibility)
    .bind(&metadata)
    .bind(&input.extra_frontmatter)
    .bind(&input.allowed_tools)
    .bind(&input.skill_md_body)
    .bind(input.enabled)
    .execute(&mut *tx)
    .await?;

    insert_files(&mut tx, id, &input.files).await?;

    let version = bump_version(&mut tx).await?;
    sweep_orphan_blobs(&mut tx).await?;
    tx.commit().await?;

    let skill = get(pool, &id.to_string())
        .await?
        .ok_or(AppError::NotFound)?;
    Ok((skill, version))
}

pub async fn update(
    pool: &PgPool,
    id: &str,
    input: &SkillInput,
) -> AppResult<Option<(SkillConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let metadata = serde_json::to_value(&input.metadata).map_err(json_err)?;

    let mut tx = pool.begin().await?;

    // Name is immutable: update everything except `name`.
    let updated = sqlx::query(
        "UPDATE skills SET description = $2, license = $3, compatibility = $4, metadata = $5, \
         extra_frontmatter = $6, allowed_tools = $7, skill_md_body = $8, enabled = $9, \
         updated_at = now() \
         WHERE id = $1 RETURNING id",
    )
    .bind(uid)
    .bind(&input.description)
    .bind(&input.license)
    .bind(&input.compatibility)
    .bind(&metadata)
    .bind(&input.extra_frontmatter)
    .bind(&input.allowed_tools)
    .bind(&input.skill_md_body)
    .bind(input.enabled)
    .fetch_optional(&mut *tx)
    .await?;

    if updated.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }

    // Replace the file set wholesale: delete then re-insert (blob dedupe in
    // insert_files reuses unchanged content; orphan sweep reclaims the rest).
    sqlx::query("DELETE FROM skill_files WHERE skill_id = $1")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    insert_files(&mut tx, uid, &input.files).await?;

    let version = bump_version(&mut tx).await?;
    sweep_orphan_blobs(&mut tx).await?;
    tx.commit().await?;

    let skill = get(pool, id).await?.ok_or(AppError::NotFound)?;
    Ok(Some((skill, version)))
}

pub async fn delete(pool: &PgPool, id: &str) -> AppResult<Option<i64>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let deleted = sqlx::query("DELETE FROM skills WHERE id = $1 RETURNING id")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?;

    if deleted.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }

    let version = bump_version(&mut tx).await?;
    sweep_orphan_blobs(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}

/// Store an uploaded file as a deduped blob and return its references.
pub async fn upload_file(
    pool: &PgPool,
    bytes: &[u8],
    filename: &str,
    mime_type: &str,
) -> AppResult<UploadFileResponse> {
    if bytes.len() > MAX_SKILL_FILE_SIZE {
        return Err(AppError::BadRequest("file exceeds 50 MB limit".into()));
    }
    let mut tx = pool.begin().await?;
    let (blob_id, len) = upsert_blob(&mut tx, bytes).await?;
    tx.commit().await?;

    Ok(UploadFileResponse {
        upload_id: Uuid::new_v4().to_string(),
        blob_id: blob_id.to_string(),
        filename: filename.to_string(),
        mime_type: mime_type.to_string(),
        file_size_bytes: len,
    })
}

/// Load the raw bytes + mime type for a skill file by path (client file fetch).
pub async fn read_file(
    pool: &PgPool,
    skill_id: &str,
    path: &str,
) -> AppResult<Option<(Vec<u8>, String)>> {
    let uid = parse_uuid(skill_id)?;
    let row = sqlx::query(
        "SELECT f.mime_type, b.data AS blob_data \
         FROM skill_files f \
         LEFT JOIN skill_file_blobs b ON b.id = f.blob_id \
         WHERE f.skill_id = $1 AND f.path = $2",
    )
    .bind(uid)
    .bind(path)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let mime_type: String = row.get("mime_type");
    let data: Option<Vec<u8>> = row.try_get("blob_data").ok().flatten();
    match data {
        Some(bytes) => Ok(Some((bytes, mime_type))),
        None => Ok(None),
    }
}
