//! Tauri commands backed by the OS credential store (issue #1667).
//!
//! Every credential is its own entry under one service, keyed by an account
//! name the frontend chooses (`settings.shareToken`, `ai.<profile>.<key>`,
//! `postgres.connection.<uuid>`). Account names are stored in users' keychains,
//! so renaming one orphans existing credentials.

use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name; matches the bundle identifier.
const SERVICE: &str = "org.geolibre.desktop";
const MAX_ACCOUNT_BYTES: usize = 512;

/// Serializes every store call. keyring documents that the Windows credential
/// store does not order concurrent access to the same entry.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn validate_account(account: &str) -> Result<(), String> {
    // macOS treats an empty account as a wildcard that matches any entry.
    if account.is_empty() {
        return Err("Credential name must not be empty.".to_string());
    }
    if account.len() > MAX_ACCOUNT_BYTES {
        return Err("Credential name is too long.".to_string());
    }
    if account.chars().any(char::is_control) {
        return Err("Credential name must not contain control characters.".to_string());
    }
    Ok(())
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    validate_account(account)?;
    keyring::Entry::new(SERVICE, account).map_err(|error| error.to_string())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding the lock leaves no partial state to protect.
    STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn get_many_blocking(accounts: Vec<String>) -> Result<HashMap<String, String>, String> {
    let _guard = lock();
    let mut found = HashMap::with_capacity(accounts.len());
    for account in accounts {
        match entry(&account)?.get_password() {
            Ok(secret) => {
                found.insert(account, secret);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(found)
}

fn set_blocking(account: String, secret: String) -> Result<(), String> {
    let _guard = lock();
    entry(&account)?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

fn delete_blocking(account: String) -> Result<(), String> {
    let _guard = lock();
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Returns the secrets for the accounts that exist; absent accounts are omitted.
/// Any other store error fails the whole call.
#[tauri::command]
pub async fn secure_store_get_many(accounts: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_many_blocking(accounts))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

#[tauri::command]
pub async fn secure_store_set(account: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_blocking(account, secret))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

/// Deleting an account that does not exist succeeds.
#[tauri::command]
pub async fn secure_store_delete(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_blocking(account))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::validate_account;

    #[test]
    fn secure_store_accepts_app_account_names() {
        for account in [
            "settings.shareToken",
            "ai.3f1c2a9e-8f0b-4c55-9d1e-2b7a4c6d8e90.GEMINI_API_KEY",
            "postgres.connection.9",
        ] {
            assert_eq!(validate_account(account), Ok(()), "{account}");
        }
    }

    #[test]
    fn secure_store_rejects_empty_account() {
        assert_eq!(
            validate_account(""),
            Err("Credential name must not be empty.".to_string())
        );
    }

    #[test]
    fn secure_store_rejects_long_account() {
        assert_eq!(validate_account(&"a".repeat(512)), Ok(()));
        assert_eq!(
            validate_account(&"a".repeat(513)),
            Err("Credential name is too long.".to_string())
        );
    }

    #[test]
    fn secure_store_rejects_control_characters() {
        assert_eq!(
            validate_account("settings.share\nToken"),
            Err("Credential name must not contain control characters.".to_string())
        );
    }
}
