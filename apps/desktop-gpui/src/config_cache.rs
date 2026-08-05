//! Encrypted on-disk cache of the last config snapshot, so models/prompts/MCP
//! work offline and at startup before the socket connects (mirrors the
//! Electron client's safeStorage-encrypted config_cache).
//!
//! The snapshot carries provider credentials, which must never be written to
//! disk in plaintext — the cache is ChaCha20-Poly1305 encrypted with a random
//! key held in the macOS Keychain (the same trust anchor as login credentials).

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

fn cache_path() -> std::path::PathBuf {
    // Tests must never touch (or clear) the real user cache.
    if cfg!(test) {
        return std::env::temp_dir().join(format!("flairy-config-cache-test-{}", std::process::id()));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = std::path::PathBuf::from(home).join("Library/Application Support/Flairy");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("config-cache.bin")
}

/// The cache key from the Keychain, created on first use. None → no keychain
/// access → we simply don't cache (never fall back to plaintext).
fn cache_key() -> Option<Key> {
    use base64::Engine as _;
    let entry = keyring::Entry::new("Flairy", "config-cache-key").ok()?;
    let engine = base64::engine::general_purpose::STANDARD;
    if let Ok(stored) = entry.get_password() {
        if let Ok(bytes) = engine.decode(stored) {
            if bytes.len() == 32 {
                return Some(*Key::from_slice(&bytes));
            }
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    entry.set_password(&engine.encode(bytes)).ok()?;
    Some(*Key::from_slice(&bytes))
}

fn encrypt(key: &Key, plaintext: &str) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(key);
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).ok()?;
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes()).ok()?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend(ciphertext);
    Some(blob)
}

fn decrypt(key: &Key, blob: &[u8]) -> Option<String> {
    if blob.len() < 13 {
        return None;
    }
    let cipher = ChaCha20Poly1305::new(key);
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce_bytes), ciphertext).ok()?;
    String::from_utf8(plaintext).ok()
}

/// Persist the raw snapshot JSON (encrypted). Failures are silent — the cache
/// is best-effort and the live socket remains the source of truth.
pub fn save(raw_json: &str) {
    let Some(key) = cache_key() else { return };
    let Some(blob) = encrypt(&key, raw_json) else { return };
    let _ = std::fs::write(cache_path(), blob);
}

/// Load and decrypt the cached snapshot JSON, if present and intact.
pub fn load() -> Option<String> {
    let blob = std::fs::read(cache_path()).ok()?;
    let key = cache_key()?;
    decrypt(&key, &blob)
}

/// Drop the cache (sign-out).
pub fn clear() {
    let _ = std::fs::remove_file(cache_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    // The crypto core only — save()/load() would hit the real Keychain, which
    // can block on an authorization prompt during tests.
    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = Key::from_slice(&[7u8; 32]);
        let blob = encrypt(key, "{\"llm\":{}}").unwrap();
        assert_eq!(decrypt(key, &blob).as_deref(), Some("{\"llm\":{}}"));
        // Tampering fails closed.
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        assert!(decrypt(key, &bad).is_none());
        assert!(decrypt(Key::from_slice(&[8u8; 32]), &blob).is_none());
    }
}
