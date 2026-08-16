use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 4174;
pub const STARTUP_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const STARTUP_RUN_VALUE_NAME: &str = "OpenTokenIsland";

pub fn opentoken_bin_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        // 官方新版客户端优先（.opentoken\bin），旧版 .local\bin 仅作回落
        home.join(".opentoken").join("bin").join("opentoken.exe"),
        home.join(".local").join("bin").join("opentoken.exe"),
    ]
}

pub fn opentoken_bin(home: &Path) -> PathBuf {
    let candidates = opentoken_bin_candidates(home);
    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }
    candidates[0].clone()
}

pub fn server_resource_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("server.js")
}

pub fn server_command_context(server: &Path) -> (PathBuf, OsString) {
    let working_dir = server
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let argument = server
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| OsString::from("server.js"));
    (working_dir, argument)
}

pub fn local_url(path: &str) -> String {
    let clean = path.trim_start_matches('/');
    format!("http://127.0.0.1:{DEFAULT_PORT}/{clean}")
}

pub fn startup_run_value(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

pub fn startup_registry_args(exe: &Path) -> Vec<String> {
    vec![
        "add".to_string(),
        STARTUP_RUN_KEY.to_string(),
        "/v".to_string(),
        STARTUP_RUN_VALUE_NAME.to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        startup_run_value(exe),
        "/f".to_string(),
    ]
}

pub fn should_show_panel_on_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == "--show-panel")
}

pub fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

pub fn health_response_matches(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let status_ok = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        == Some("200");
    if !status_ok {
        return false;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    json.get("ok").and_then(|value| value.as_bool()) == Some(true)
        && json.get("appId").and_then(|value| value.as_str()) == Some("opentoken-island")
        && json.get("appVersion").and_then(|value| value.as_str())
            == Some(env!("CARGO_PKG_VERSION"))
        && json.get("protocolVersion").and_then(|value| value.as_u64()) == Some(3)
        && json
            .get("stateSchemaVersion")
            .and_then(|value| value.as_u64())
            == Some(3)
}

pub fn is_opentoken_server(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(
            format!(
                "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && health_response_matches(&response)
}

/// 请求占用端口的旧版本/unmanaged 代理优雅退出（0.1.5+ 的 server.js 提供 /api/shutdown）。
/// 仅供本机 GUI 版本接管使用；失败静默，由调用方按端口是否释放决定后续。
pub fn request_server_shutdown(port: u16) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(
        format!("POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    );
    let _ = stream.flush();
    let mut buffer = [0u8; 256];
    let _ = stream.read(&mut buffer);
}

#[cfg(test)]
pub fn floating_window_origin(
    tray_x: i32,
    tray_y: i32,
    tray_width: i32,
    tray_height: i32,
    window_width: i32,
    window_height: i32,
    margin: i32,
) -> (i32, i32) {
    let x = (tray_x + tray_width / 2 - window_width / 2).max(margin);
    let y = if tray_y > window_height + margin {
        tray_y - window_height - margin
    } else {
        tray_y + tray_height + margin
    };

    (x, y.max(margin))
}

#[cfg(test)]
pub fn floating_window_origin_bounded(
    tray_x: i32,
    tray_y: i32,
    tray_width: i32,
    tray_height: i32,
    window_width: i32,
    window_height: i32,
    margin: i32,
    work_x: i32,
    work_y: i32,
    work_width: i32,
    work_height: i32,
) -> (i32, i32) {
    floating_window_origin_bounded_with_anchor_gap(
        tray_x,
        tray_y,
        tray_width,
        tray_height,
        window_width,
        window_height,
        margin,
        margin,
        work_x,
        work_y,
        work_width,
        work_height,
    )
}

pub fn floating_window_origin_bounded_with_anchor_gap(
    tray_x: i32,
    tray_y: i32,
    tray_width: i32,
    tray_height: i32,
    window_width: i32,
    window_height: i32,
    edge_margin: i32,
    anchor_gap: i32,
    work_x: i32,
    work_y: i32,
    work_width: i32,
    work_height: i32,
) -> (i32, i32) {
    let x = tray_x + tray_width / 2 - window_width / 2;
    let tray_center_y = tray_y + tray_height / 2;
    let work_center_y = work_y + work_height / 2;
    let y = if tray_center_y >= work_center_y {
        tray_y - window_height - anchor_gap
    } else {
        tray_y + tray_height + anchor_gap
    };

    let min_x = work_x + edge_margin;
    let min_y = work_y + edge_margin;
    let max_x = work_x + work_width - window_width - edge_margin;
    let max_y = work_y + work_height - window_height - edge_margin;

    let x = if max_x >= min_x {
        x.clamp(min_x, max_x)
    } else {
        min_x
    };
    let y = if max_y >= min_y {
        y.clamp(min_y, max_y)
    } else {
        min_y
    };

    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_default_opentoken_path() {
        let path = opentoken_bin(Path::new(r"C:\Users\ty"));
        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\ty\.opentoken\bin\opentoken.exe")
        );
    }

    #[test]
    fn builds_server_resource_path() {
        let path = server_resource_path(Path::new(r"C:\App\resources"));
        assert_eq!(path, PathBuf::from(r"C:\App\resources\server.js"));
    }

    #[test]
    fn starts_server_from_working_directory_when_install_path_has_spaces() {
        let server = Path::new(r"C:\Users\ty\AppData\Local\OpenToken Island\server.js");
        let (working_dir, argument) = server_command_context(server);
        assert_eq!(
            working_dir,
            PathBuf::from(r"C:\Users\ty\AppData\Local\OpenToken Island")
        );
        assert_eq!(argument, OsString::from("server.js"));
    }

    #[test]
    fn builds_local_urls() {
        assert_eq!(
            local_url("popover.html"),
            "http://127.0.0.1:4174/popover.html"
        );
        assert_eq!(
            local_url("/island.html"),
            "http://127.0.0.1:4174/island.html"
        );
    }

    #[test]
    fn builds_startup_registry_args() {
        let exe = Path::new(r"C:\Program Files\OpenToken Island\opentoken-island.exe");
        let args = startup_registry_args(exe);
        assert_eq!(args[0], "add");
        assert_eq!(args[1], STARTUP_RUN_KEY);
        assert_eq!(args[3], STARTUP_RUN_VALUE_NAME);
        assert_eq!(
            args[7],
            r#""C:\Program Files\OpenToken Island\opentoken-island.exe""#
        );
        assert_eq!(args[8], "/f");
    }

    #[test]
    fn show_panel_arg_requests_panel_on_launch() {
        let args = vec![
            "opentoken-island.exe".to_string(),
            "--show-panel".to_string(),
        ];
        assert!(should_show_panel_on_launch(args));
    }

    #[test]
    fn default_launch_stays_tray_only() {
        let args = vec!["opentoken-island.exe".to_string()];
        assert!(!should_show_panel_on_launch(args));
    }

    #[test]
    fn detects_closed_local_port() {
        assert!(!is_port_open(9));
    }

    #[test]
    fn accepts_only_matching_health_contract() {
        let good = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"ok\":true,\"stateSchemaVersion\":3,\"appId\":\"opentoken-island\",\"appVersion\":\"{}\",\"protocolVersion\":3}}",
            env!("CARGO_PKG_VERSION")
        );
        assert!(health_response_matches(&good));
        assert!(!health_response_matches(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"stateSchemaVersion\":3,\"appId\":\"opentoken-island\",\"appVersion\":\"0.0.0\",\"protocolVersion\":3}"
        ));
        assert!(!health_response_matches(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"appId\":\"another-app\",\"protocolVersion\":3,\"stateSchemaVersion\":3}"
        ));
        assert!(!health_response_matches(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"appId\":\"opentoken-island\",\"protocolVersion\":1,\"stateSchemaVersion\":3}"
        ));
        assert!(!health_response_matches(
            "HTTP/1.1 500 Error\r\n\r\n{\"ok\":true,\"appId\":\"opentoken-island\",\"protocolVersion\":3,\"stateSchemaVersion\":3}"
        ));
        assert!(!health_response_matches(
            "HTTP/1.1 200 OK\r\n\r\n{\"message\":\"\\\"appId\\\":\\\"opentoken-island\\\",\\\"protocolVersion\\\":3\"}"
        ));
    }

    #[test]
    fn positions_floating_window_above_bottom_taskbar_icon() {
        let origin = floating_window_origin(1780, 1032, 32, 32, 560, 118, 12);
        assert_eq!(origin, (1516, 902));
    }

    #[test]
    fn positions_floating_window_below_top_taskbar_icon() {
        let origin = floating_window_origin(420, 0, 32, 32, 560, 118, 12);
        assert_eq!(origin, (156, 44));
    }

    #[test]
    fn clamps_floating_window_to_left_edge() {
        let origin = floating_window_origin(8, 1032, 32, 32, 560, 118, 12);
        assert_eq!(origin.0, 12);
    }

    #[test]
    fn positions_detail_panel_above_bottom_taskbar_icon() {
        let origin = floating_window_origin(1780, 1032, 32, 32, 430, 700, 12);
        assert_eq!(origin, (1581, 320));
    }

    #[test]
    fn clamps_detail_panel_inside_right_edge() {
        let origin =
            floating_window_origin_bounded(1888, 1000, 32, 32, 466, 736, 18, 0, 0, 1920, 1040);
        assert_eq!(origin.0 + 466, 1902);
    }

    #[test]
    fn clamps_detail_panel_inside_bottom_edge_when_below_icon() {
        let origin = floating_window_origin_bounded(24, 24, 32, 32, 466, 736, 18, 0, 0, 1920, 1040);
        assert_eq!(origin.1, 74);
        assert!(origin.1 + 736 <= 1040 - 18);
    }

    #[test]
    fn lifts_detail_panel_to_top_edge_when_hidden_icons_need_more_clearance() {
        let origin = floating_window_origin_bounded_with_anchor_gap(
            1600, 1019, 32, 32, 466, 736, 12, 430, 0, 0, 1707, 1019,
        );
        assert_eq!(origin.1, 12);
        assert_eq!(origin.1 + 736, 748);
        assert_eq!(origin.0 + 466, 1695);
    }
}
