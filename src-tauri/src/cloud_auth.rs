use std::{io::{Read, Write}, net::{Ipv4Addr, TcpListener}, time::{Duration, Instant}};
use tauri::Url;

fn valid_value(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn callback(request: &str, state: &str) -> Option<String> {
    let line = request.lines().next()?;
    let mut parts = line.split_ascii_whitespace();
    if parts.next()? != "GET" { return None; }
    let query = parts.next()?.strip_prefix("/atlas-callback?")?;
    let mut code = None;
    let mut received_state = None;
    for param in query.split('&') {
        let (key, value) = param.split_once('=')?;
        if !valid_value(value) { return None; }
        match key {
            "state" if received_state.is_none() => received_state = Some(value),
            "code" if code.is_none() => code = Some(value),
            _ => return None,
        }
    }
    (received_state == Some(state)).then(|| code.map(str::to_owned)).flatten()
}

fn pair(challenge: String, state: String) -> Result<String, String> {
    if !valid_value(&challenge) || !valid_value(&state) { return Err("Invalid sign-in request.".into()); }
    let configured_origin = option_env!("NEXT_PUBLIC_ATLAS_ORIGIN").ok_or("Cloud sign-in is unavailable in this build.")?;
    let mut url = Url::parse(configured_origin).map_err(|_| "Invalid Finance Atlas origin.")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() ||
        url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Invalid Finance Atlas origin.".into());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| "Could not start the local sign-in callback.")?;
    listener.set_nonblocking(true).map_err(|_| "Could not prepare sign-in callback.")?;
    let port = listener.local_addr().map_err(|_| "Could not find sign-in port.")?.port().to_string();
    url.set_path("/connect/");
    url.set_fragment(Some(&format!("challenge={challenge}&state={state}&port={port}")));
    #[cfg(windows)]
    std::process::Command::new("explorer.exe").arg(url.as_str()).spawn().map_err(|_| "Could not open the browser.")?;
    let expires = Instant::now() + Duration::from_secs(120);
    while Instant::now() < expires {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
                let mut data = [0; 2048];
                let mut length = 0;
                while length < data.len() && Instant::now() < expires {
                    let Ok(count) = stream.read(&mut data[length..]) else { break; };
                    if count == 0 { break; }
                    length += count;
                    if data[..length].windows(4).any(|part| part == b"\r\n\r\n") { break; }
                }
                if let Some(code) = std::str::from_utf8(&data[..length]).ok().and_then(|request| callback(request, &state)) {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\nReturn to Finance Atlas to finish signing in.");
                    return Ok(code);
                }
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("The sign-in callback failed.".into()),
        }
    }
    Err("Sign-in timed out. Try again from Finance Atlas.".into())
}

#[tauri::command]
pub async fn desktop_pair(challenge: String, state: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pair(challenge, state)).await.map_err(|_| "Sign-in could not finish.")?
}

#[cfg(test)]
mod tests {
    use super::callback;
    #[test]
    fn loopback_requires_expected_state_and_single_code() {
        let expected = "A".repeat(43);
        let code = "B".repeat(43);
        assert_eq!(callback(&format!("GET /atlas-callback?code={code}&state={expected} HTTP/1.1"), &expected), Some(code.clone()));
        assert!(callback(&format!("GET /atlas-callback?code={code}&state={code} HTTP/1.1"), &expected).is_none());
        assert!(callback(&format!("GET /atlas-callback?code={code}&code={code}&state={expected} HTTP/1.1"), &expected).is_none());
    }
}
