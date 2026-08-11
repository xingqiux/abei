use std::io::IsTerminal;
use std::process::Command;

use crate::client::Client;
use crate::config::Settings;

pub fn pairing_url(web_url: &str) -> String {
    format!("{}/settings?pair=1", web_url.trim_end_matches('/'))
}

pub async fn resolve_web_url(settings: &Settings) -> Option<String> {
    if let Some(url) = std::env::var("ABEI_WEB_URL")
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
    {
        return Some(url);
    }

    Client::new(&settings.api_url, None)
        .ok()?
        .request(abei_core::Method::Get, "/health", &[], None)
        .await
        .ok()?
        .get("web_url")?
        .as_str()
        .map(str::to_owned)
        .filter(|url| !url.is_empty())
}

pub fn can_open() -> bool {
    std::io::stdout().is_terminal()
        && std::io::stderr().is_terminal()
        && std::env::var_os("ABEI_NO_BROWSER").is_none()
        && std::env::var_os("CI").is_none()
}

pub async fn open_pairing(settings: &Settings) -> Option<String> {
    let url = pairing_url(&resolve_web_url(settings).await?);
    open(&url).ok()?;
    Some(url)
}

fn open(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let child = Command::new("open").arg(url).spawn()?;
    #[cfg(target_os = "linux")]
    let child = Command::new("xdg-open").arg(url).spawn()?;
    #[cfg(target_os = "windows")]
    let child = Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "当前平台不支持自动打开浏览器",
    ));

    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_url_handles_trailing_slashes() {
        assert_eq!(
            pairing_url("http://127.0.0.1:18004"),
            "http://127.0.0.1:18004/settings?pair=1"
        );
        assert_eq!(
            pairing_url("http://127.0.0.1:18004/"),
            "http://127.0.0.1:18004/settings?pair=1"
        );
    }

    #[test]
    fn no_browser_environment_disables_opening() {
        let previous = std::env::var_os("ABEI_NO_BROWSER");
        // SAFETY: no other unit test reads or writes ABEI_NO_BROWSER.
        unsafe { std::env::set_var("ABEI_NO_BROWSER", "1") };
        assert!(!can_open());
        // SAFETY: restore the process environment before this test returns.
        unsafe {
            match previous {
                Some(value) => std::env::set_var("ABEI_NO_BROWSER", value),
                None => std::env::remove_var("ABEI_NO_BROWSER"),
            }
        };
    }
}
