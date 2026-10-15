// Hue Deck: Philips Hue lights from the PC. The window is the page in dist/; it reaches the bridge through
// the `hue` command (the bridge's HTTPS certificate is self-signed, and a web page can't skip that check).
//
// Started with arguments (from a shortcut) it does that one thing and quits, no window:
//   hue-deck --scene <scene id> [--off-group <grouped_light id>]   (with --off-group: a second click turns the room off)
//   hue-deck --room <grouped_light id> on|off|toggle
//   hue-deck --light <light id> on|off|toggle
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, sync::Arc, time::Duration};

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

/* ---------------- Settings: the bridge's address and the key it gave us ---------------- */
#[derive(Serialize, Deserialize, Clone, Default)]
struct Config {
    ip: String,
    key: String,
    #[serde(default)]
    clientkey: String,
}

fn app_dir() -> PathBuf {
    dirs::config_local_dir().unwrap_or_else(std::env::temp_dir).join("HueDeck")
}

fn read_config(p: PathBuf) -> Option<Config> {
    let t = fs::read_to_string(p).ok()?;
    let c: Config = serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()?;
    (!c.ip.is_empty() && !c.key.is_empty()).then_some(c)
}

fn load_config() -> Option<Config> {
    if let Some(c) = read_config(app_dir().join("config.json")) {
        return Some(c);
    }
    // the older Hue Scenes scripts on this PC keep the same address and key: use them, no pairing needed
    let c = read_config(dirs::data_local_dir()?.join("HueScenes").join("config.json"))?;
    save_config(&c).ok();
    Some(c)
}

fn save_config(c: &Config) -> Result<(), String> {
    fs::create_dir_all(app_dir()).map_err(err)?;
    fs::write(app_dir().join("config.json"), serde_json::to_string_pretty(c).map_err(err)?).map_err(err)
}

// an address typed by the user goes into a URL, so only plain host characters
fn clean_host(ip: &str) -> Result<String, String> {
    let ip = ip.trim();
    if ip.is_empty() || !ip.chars().all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c)) {
        return Err("that isn't a bridge address".into());
    }
    Ok(ip.to_string())
}

/* ---------------- Talking to the bridge ---------------- */
fn agent() -> Result<ureq::Agent, String> {
    // the bridge signs its own certificate; it's on the home network, found by its address
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(err)?;
    Ok(ureq::AgentBuilder::new().tls_connector(Arc::new(tls)).timeout(Duration::from_secs(8)).build())
}

fn send(c: &Config, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let url = format!("https://{}{}", c.ip, path);
    let req = agent()?.request(method, &url).set("hue-application-key", &c.key);
    let res = match body {
        Some(b) => req.set("content-type", "application/json").send_string(b),
        None => req.call(),
    };
    match res {
        Ok(r) => r.into_string().map_err(err),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let why = serde_json::from_str::<Value>(&text).ok()
                .and_then(|v| v["errors"][0]["description"].as_str().map(String::from))
                .unwrap_or(text);
            Err(format!("the bridge said {code}: {why}"))
        }
        Err(e) => Err(format!("can't reach the bridge at {} ({e})", c.ip)),
    }
}

#[derive(Serialize)]
struct Setup {
    ip: String,
    paired: bool,
}

#[tauri::command]
fn get_setup() -> Setup {
    match load_config() {
        Some(c) => Setup { ip: c.ip, paired: true },
        None => Setup { ip: String::new(), paired: false },
    }
}

// the page's only way to the bridge: the resource API (lights, rooms, scenes …)
#[tauri::command]
async fn hue(method: String, path: String, body: Option<String>) -> Result<String, String> {
    if !path.starts_with("/clip/v2/resource") || path.contains("..") || !["GET", "PUT"].contains(&method.as_str()) {
        return Err("not a bridge request".into());
    }
    let c = load_config().ok_or("not connected to a bridge yet")?;
    tauri::async_runtime::spawn_blocking(move || send(&c, &method, &path, body.as_deref())).await.map_err(err)?
}

// Philips' own lookup of bridges on this network (they report in from the home's internet address)
#[tauri::command]
async fn discover() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        agent()?.get("https://discovery.meethue.com/").call().map_err(err)?.into_string().map_err(err)
    })
    .await
    .map_err(err)?
}

// Ok(true) = paired and saved; Ok(false) = the bridge's round link button hasn't been pressed yet
#[tauri::command]
async fn pair(ip: String) -> Result<bool, String> {
    let ip = clean_host(&ip)?;
    tauri::async_runtime::spawn_blocking(move || {
        let body = r#"{"devicetype":"hue_deck#pc","generateclientkey":true}"#;
        let text = match agent()?.post(&format!("https://{ip}/api")).send_string(body) {
            Ok(r) => r.into_string().map_err(err)?,
            Err(e) => return Err(format!("can't reach a bridge at {ip} ({e})")),
        };
        let v: Value = serde_json::from_str(&text).map_err(err)?;
        if let Some(ok) = v[0].get("success") {
            let c = Config {
                ip,
                key: ok["username"].as_str().unwrap_or_default().to_string(),
                clientkey: ok["clientkey"].as_str().unwrap_or_default().to_string(),
            };
            save_config(&c)?;
            return Ok(true);
        }
        if v[0]["error"]["type"].as_i64() == Some(101) {
            return Ok(false);
        }
        Err(v[0]["error"]["description"].as_str().unwrap_or("the bridge said no").to_string())
    })
    .await
    .map_err(err)?
}

/* ---------------- Shortcuts ---------------- */
fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// only the shortcut actions above, with ids and actions checked
fn check_args(a: &[String]) -> Result<(), String> {
    let ok = match a.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--scene", id] => is_id(id),
        ["--scene", id, "--off-group", g] => is_id(id) && is_id(g),
        ["--room" | "--light", id, act] => is_id(id) && ["on", "off", "toggle"].contains(act),
        _ => false,
    };
    if ok { Ok(()) } else { Err("that isn't a Hue Deck shortcut".into()) }
}

fn safe_name(n: &str) -> String {
    let s: String = n.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "Hue".into() } else { s }
}

// the program a shortcut starts: on Linux the AppImage itself when that's how Hue Deck runs
fn exe_path() -> Result<String, String> {
    if let Ok(p) = std::env::var("APPIMAGE") {
        return Ok(p);
    }
    Ok(std::env::current_exe().map_err(err)?.to_string_lossy().to_string())
}

fn shortcut_dir(place: &str, folder: Option<String>) -> Result<PathBuf, String> {
    let d = match place {
        "desktop" => dirs::desktop_dir().ok_or("no Desktop folder")?,
        #[cfg(windows)]
        "start" => dirs::data_dir().ok_or("no Start menu folder")?.join("Microsoft\\Windows\\Start Menu\\Programs\\Hue Deck"),
        #[cfg(not(windows))]
        "start" => dirs::data_dir().ok_or("no applications folder")?.join("applications"),
        "folder" => PathBuf::from(folder.ok_or("no folder picked")?),
        _ => return Err("where should the shortcut go?".into()),
    };
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

// one PNG inside an .ico (Windows has read those since Vista)
#[cfg(windows)]
fn ico(png: &[u8]) -> Vec<u8> {
    let mut v = vec![0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0];
    v.extend((png.len() as u32).to_le_bytes());
    v.extend(22u32.to_le_bytes());
    v.extend(png);
    v
}

// → the full path of the new shortcut
#[tauri::command]
fn make_shortcut(name: String, args: Vec<String>, icon_png: String, place: String, folder: Option<String>) -> Result<String, String> {
    check_args(&args)?;
    let png = base64::engine::general_purpose::STANDARD.decode(icon_png).map_err(err)?;
    let dir = shortcut_dir(&place, folder)?;
    let name = safe_name(&name);
    // a fresh icon file each time: Windows remembers icons by file name and would keep showing an old one
    let icons = app_dir().join("icons");
    fs::create_dir_all(&icons).map_err(err)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let exe = exe_path()?;
    #[cfg(windows)]
    {
        let icon = icons.join(format!("{name} {stamp}.ico"));
        fs::write(&icon, ico(&png)).map_err(err)?;
        let path = dir.join(format!("{name}.lnk"));
        let mut l = mslnk::ShellLink::new(&exe).map_err(|e| format!("{e:?}"))?;
        l.set_arguments(Some(args.join(" ")));
        l.set_icon_location(Some(icon.to_string_lossy().to_string()));
        l.set_name(Some(format!("Hue Deck: {name}")));
        l.create_lnk(&path).map_err(err)?;
        Ok(path.to_string_lossy().to_string())
    }
    #[cfg(not(windows))]
    {
        let icon = icons.join(format!("{name} {stamp}.png"));
        fs::write(&icon, &png).map_err(err)?;
        let path = dir.join(format!("hue-deck-{}.desktop", name.replace(' ', "-")));
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName={name}\nComment=Hue Deck shortcut\nExec=\"{exe}\" {}\nIcon={}\nTerminal=false\n",
            args.join(" "),
            icon.to_string_lossy()
        );
        fs::write(&path, entry).map_err(err)?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(err)?;
        Ok(path.to_string_lossy().to_string())
    }
}

// does what a shortcut says, then the program ends (no window)
fn run_shortcut(a: &[String]) -> Result<(), String> {
    check_args(a)?;
    let c = load_config().ok_or("Hue Deck isn't connected to a bridge yet. Open Hue Deck once to connect it.")?;
    let is_on = |kind: &str, id: &str| -> Result<bool, String> {
        let v: Value = serde_json::from_str(&send(&c, "GET", &format!("/clip/v2/resource/{kind}/{id}"), None)?).map_err(err)?;
        Ok(v["data"][0]["on"]["on"].as_bool().unwrap_or(false))
    };
    let switch = |kind: &str, id: &str, on: bool| send(&c, "PUT", &format!("/clip/v2/resource/{kind}/{id}"), Some(&format!(r#"{{"on":{{"on":{on}}}}}"#))).map(|_| ());
    match a[0].as_str() {
        "--scene" => {
            if a.len() == 4 {
                // second click: the scene is already showing and the room is on → room off
                let v: Value = serde_json::from_str(&send(&c, "GET", &format!("/clip/v2/resource/scene/{}", a[1]), None)?).map_err(err)?;
                let showing = v["data"][0]["status"]["active"].as_str().unwrap_or("inactive") != "inactive";
                if showing && is_on("grouped_light", &a[3])? {
                    return switch("grouped_light", &a[3], false);
                }
            }
            send(&c, "PUT", &format!("/clip/v2/resource/scene/{}", a[1]), Some(r#"{"recall":{"action":"active"}}"#)).map(|_| ())
        }
        flag => {
            let kind = if flag == "--room" { "grouped_light" } else { "light" };
            let on = match a[2].as_str() {
                "on" => true,
                "off" => false,
                _ => !is_on(kind, &a[1])?,
            };
            switch(kind, &a[1], on)
        }
    }
}

// a shortcut has no window, so a problem gets a small message box
fn complain(msg: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, title) = (w(msg), w("Hue Deck"));
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONWARNING) };
    }
    #[cfg(not(windows))]
    eprintln!("Hue Deck: {msg}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a.starts_with("--")) {
        if let Err(e) = run_shortcut(&args) {
            complain(&e);
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_setup, hue, discover, pair, make_shortcut])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Hue Deck")
                .inner_size(1000.0, 720.0)
                .min_inner_size(380.0, 420.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hue Deck");
}
