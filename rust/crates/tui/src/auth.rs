//! Token_Store: the TUI's saved Session_Token (Req 33.4, 48.11, 48.12, 48.13, 48.14).
//!
//! The token lives in `<config dir>/haunted-terminal/session.json` as
//! `{ server, token, address, account_id, exp }`. It is used only for the server it was issued
//! by: [`TokenStore::load`] returns it only when the stored `server` equals the `--server` URL
//! exactly. An expired token is deleted on load. Writes are atomic (a temporary file, then a
//! rename) and the file is created with mode 0600 on Unix.
//!
//! The token is a secret: [`StoredSession`]'s `Debug` redacts it, and nothing here logs it.
//!
//! `exp` is epoch seconds, as in the server's `/auth/verify` response.

// Pairing (Task 21.2) calls `save`.
#![allow(dead_code)]

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Directory under the config dir.
pub const APP_DIR: &str = "haunted-terminal";
/// The token file name.
pub const FILE_NAME: &str = "session.json";

/// What the saved file holds.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSession {
    /// The `--server` URL the token was issued by.
    pub server: String,
    pub token: String,
    pub address: String,
    pub account_id: String,
    /// Expiry, epoch seconds.
    pub exp: u64,
}

impl fmt::Debug for StoredSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredSession")
            .field("server", &self.server)
            .field("token", &"<redacted>")
            .field("address", &self.address)
            .field("account_id", &self.account_id)
            .field("exp", &self.exp)
            .finish()
    }
}

/// The operating systems whose config directory conventions differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Other
        }
    }
}

/// The per-user config directory, from an injected environment lookup. Windows: `%APPDATA%`.
/// macOS: `$HOME/Library/Application Support`. Otherwise `$XDG_CONFIG_HOME` (when absolute and
/// non-empty) or `$HOME/.config`. `None` when the needed variable is missing or empty.
pub fn config_dir_for(platform: Platform, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let get = |name: &str| env(name).filter(|v| !v.is_empty());
    match platform {
        Platform::Windows => get("APPDATA").map(PathBuf::from),
        Platform::MacOs => {
            get("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
        }
        Platform::Other => get("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| get("HOME").map(|h| PathBuf::from(h).join(".config"))),
    }
}

/// The config directory of the running OS and process environment.
pub fn config_dir() -> Option<PathBuf> {
    config_dir_for(Platform::current(), &|name| std::env::var(name).ok())
}

/// Now, in epoch seconds.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The saved-token file inside one directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenStore {
    dir: PathBuf,
}

impl TokenStore {
    /// A store whose file is `dir/session.json`.
    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The store at `config_dir()/haunted-terminal`, or `None` without a config directory.
    pub fn default_location() -> Option<Self> {
        config_dir().map(|dir| Self::in_dir(dir.join(APP_DIR)))
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn tmp_path(&self) -> PathBuf {
        self.dir.join(format!("{FILE_NAME}.tmp"))
    }

    /// Reads the file without checking server or expiry. `None` if missing or unparsable.
    pub fn read(&self) -> Option<StoredSession> {
        let bytes = fs::read(self.path()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// The saved session for `server`, if it was issued by exactly that server and has not
    /// expired at `now` (epoch seconds). An expired session for `server` is deleted.
    pub fn load(&self, server: &str, now: u64) -> Option<StoredSession> {
        let stored = self.read()?;
        if stored.server != server {
            return None;
        }
        if stored.exp <= now {
            let _ = self.delete();
            return None;
        }
        Some(stored)
    }

    /// Writes the session atomically: `session.json.tmp` (0600 on Unix), then a rename.
    pub fn save(&self, session: &StoredSession) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_vec(session).map_err(io::Error::other)?;
        let tmp = self.tmp_path();
        let written = write_private(&tmp, &json).and_then(|()| fs::rename(&tmp, self.path()));
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written
    }

    /// Deletes the file. A missing file is not an error.
    pub fn delete(&self) -> io::Result<()> {
        match fs::remove_file(self.path()) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The token to send after `hello` (Req 33.4, 48.12): `None` in `--guest` mode (the file is
/// not read and not touched), without a store, or without an unexpired token for `server`.
pub fn session_token(
    guest: bool,
    store: Option<&TokenStore>,
    server: &str,
    now: u64,
) -> Option<String> {
    if guest {
        return None;
    }
    store?.load(server, now).map(|s| s.token)
}

/// A short form of a wallet address for the status line: first 4, `…`, last 4. Addresses of 8
/// characters or fewer are shown whole.
pub fn short_address(address: &str) -> String {
    let chars: Vec<char> = address.chars().collect();
    if chars.len() <= 8 {
        return address.to_owned();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}…{tail}")
}

/// Test helpers shared with other modules' tests.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique directory path under the OS temp dir (not created), removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.subsec_nanos());
            let dir = std::env::temp_dir()
                .join(format!("ht-tui-test-{}-{n}-{nanos}", std::process::id()));
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TempDir;
    use super::*;

    const SERVER: &str = "wss://example.com/ws";
    const ADDRESS: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    fn session(server: &str, exp: u64) -> StoredSession {
        StoredSession {
            server: server.to_owned(),
            token: "v1.payload.mac".to_owned(),
            address: ADDRESS.to_owned(),
            account_id: format!("w_{ADDRESS}"),
            exp,
        }
    }

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn config_dir_follows_each_platform() {
        let env = env_of(&[
            ("APPDATA", "C:\\Users\\a\\AppData\\Roaming"),
            ("HOME", "/home/a"),
            ("XDG_CONFIG_HOME", "/xdg"),
        ]);
        assert_eq!(
            config_dir_for(Platform::Windows, &env),
            Some(PathBuf::from("C:\\Users\\a\\AppData\\Roaming"))
        );
        assert_eq!(
            config_dir_for(Platform::MacOs, &env),
            Some(PathBuf::from("/home/a/Library/Application Support"))
        );
        assert_eq!(
            config_dir_for(Platform::Other, &env),
            Some(PathBuf::from("/xdg"))
        );
    }

    #[test]
    fn config_dir_fallbacks_and_missing_variables() {
        let home_only = env_of(&[("HOME", "/home/a")]);
        assert_eq!(
            config_dir_for(Platform::Other, &home_only),
            Some(PathBuf::from("/home/a/.config"))
        );
        // A relative or empty XDG_CONFIG_HOME is ignored.
        let relative = env_of(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "rel")]);
        assert_eq!(
            config_dir_for(Platform::Other, &relative),
            Some(PathBuf::from("/home/a/.config"))
        );
        let empty = env_of(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "")]);
        assert_eq!(
            config_dir_for(Platform::Other, &empty),
            Some(PathBuf::from("/home/a/.config"))
        );
        let none = env_of(&[]);
        for platform in [Platform::Windows, Platform::MacOs, Platform::Other] {
            assert_eq!(config_dir_for(platform, &none), None);
        }
        // Windows does not fall back to HOME.
        assert_eq!(config_dir_for(Platform::Windows, &home_only), None);
    }

    #[test]
    fn save_then_load_round_trips() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(tmp.0.join(APP_DIR));
        let saved = session(SERVER, 2_000);
        store.save(&saved).unwrap();
        assert_eq!(store.load(SERVER, 1_000), Some(saved.clone()));
        // Saving again replaces the file.
        let newer = StoredSession {
            exp: 3_000,
            ..saved
        };
        store.save(&newer).unwrap();
        assert_eq!(store.load(SERVER, 1_000), Some(newer));
    }

    #[test]
    fn save_leaves_no_temporary_file() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&session(SERVER, 2_000)).unwrap();
        store.save(&session(SERVER, 2_001)).unwrap();
        let names: Vec<String> = fs::read_dir(&tmp.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&session(SERVER, 2_000)).unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // Req 48.11: a token is used only for the server that issued it.
    #[test]
    fn a_different_server_gets_no_token_and_the_file_stays() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&session(SERVER, 2_000)).unwrap();
        assert_eq!(store.load("wss://example.com/ws/", 1_000), None);
        assert_eq!(store.load("wss://other.com/ws", 1_000), None);
        assert_eq!(store.load("WSS://example.com/ws", 1_000), None);
        assert!(store.path().exists());
    }

    #[test]
    fn an_expired_token_is_not_returned_and_the_file_is_deleted() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&session(SERVER, 2_000)).unwrap();
        assert!(store.load(SERVER, 1_999).is_some());
        assert_eq!(store.load(SERVER, 2_000), None);
        assert!(!store.path().exists());
    }

    #[test]
    fn missing_or_corrupt_files_load_as_none_and_delete_is_idempotent() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        assert_eq!(store.load(SERVER, 0), None);
        store.delete().unwrap();
        fs::create_dir_all(&tmp.0).unwrap();
        fs::write(store.path(), b"not json").unwrap();
        assert_eq!(store.load(SERVER, 0), None);
        store.delete().unwrap();
        assert!(!store.path().exists());
    }

    // Req 48.12
    #[test]
    fn guest_mode_sends_no_token_and_leaves_the_file() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&session(SERVER, 2_000)).unwrap();
        assert_eq!(session_token(true, Some(&store), SERVER, 1_000), None);
        assert!(store.path().exists());
        assert_eq!(
            session_token(false, Some(&store), SERVER, 1_000).as_deref(),
            Some("v1.payload.mac")
        );
        assert_eq!(
            session_token(false, Some(&store), "wss://x/ws", 1_000),
            None
        );
        assert_eq!(session_token(false, None, SERVER, 1_000), None);
        // Expired: no token, and the file goes away.
        assert_eq!(session_token(false, Some(&store), SERVER, 2_000), None);
        assert!(!store.path().exists());
    }

    #[test]
    fn debug_output_never_contains_the_token() {
        let s = session(SERVER, 2_000);
        let text = format!("{s:?} {:#?}", Some(&s));
        assert!(!text.contains("v1.payload.mac"), "{text}");
        assert!(text.contains("<redacted>"));
    }

    #[test]
    fn short_address_keeps_four_and_four() {
        assert_eq!(short_address(ADDRESS), "9WzD…AWWM");
        assert_eq!(short_address("abcd"), "abcd");
        assert_eq!(short_address("abcdefgh"), "abcdefgh");
        assert_eq!(short_address("abcdefghi"), "abcd…fghi");
    }
}
