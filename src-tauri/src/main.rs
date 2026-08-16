#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod windows_support;

use std::{
    env,
    io::{Error as IoError, ErrorKind},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Position, Rect, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
#[cfg(all(target_os = "windows", not(debug_assertions)))]
use windows_support::startup_registry_args;
use windows_support::{
    floating_window_origin_bounded_with_anchor_gap, is_opentoken_server, is_port_open, local_url,
    opentoken_bin, request_server_shutdown, server_command_context, server_resource_path,
    should_show_panel_on_launch, DEFAULT_PORT,
};

const PANEL_LABEL: &str = "panel";
const ISLAND_LABEL: &str = "island";
const QUOTA_BAR_LABEL: &str = "quota-bar";
const PANEL_WIDTH: i32 = 430;
const PANEL_HEIGHT: i32 = 700;
const PANEL_SHADOW_PAD: i32 = 18;
const PANEL_WINDOW_WIDTH: i32 = PANEL_WIDTH + PANEL_SHADOW_PAD * 2;
const PANEL_WINDOW_HEIGHT: i32 = PANEL_HEIGHT + PANEL_SHADOW_PAD * 2;
const ISLAND_WIDTH: i32 = 560;
const ISLAND_HEIGHT: i32 = 118;
const QUOTA_BAR_WIDTH: i32 = 560;
const QUOTA_BAR_HEIGHT: i32 = 118;
const FLOATING_MARGIN: i32 = 12;
const PANEL_ANCHOR_GAP: i32 = 430;

struct ServerProcess(Mutex<Option<Child>>);
struct PanelState {
    epoch: AtomicU64,
    pinned: AtomicBool,
}

impl PanelState {
    fn new() -> Self {
        Self {
            epoch: AtomicU64::new(0),
            pinned: AtomicBool::new(false),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .manage(PanelState::new())
        .setup(|app| {
            let show_panel_on_launch = should_show_panel_on_launch(env::args());
            ensure_startup_registration()?;
            start_server_if_needed(app.handle())?;
            prewarm_windows(app.handle())?;
            setup_tray(app.handle())?;
            if show_panel_on_launch {
                show_panel(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == PANEL_LABEL {
                    set_panel_pinned(&window.app_handle(), false);
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == ISLAND_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == QUOTA_BAR_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(false) if window.label() == PANEL_LABEL => {
                let _ = hide_pinned_panel_on_blur(&window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build OpenToken Island")
        .run(|app, event| {
            // 代理以 detached 方式常驻后台：GUI 退出不再杀 node server.js（否则 GUI 一退，
            // 依赖 4174 的自动上传/榜单刷新全部落空）。这里只把 Child 句柄取空释放，
            // 进程本身继续服务 4174，下次启动经健康检查复用。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ServerProcess>() {
                    if let Ok(mut slot) = state.0.lock() {
                        let _ = slot.take();
                    }
                }
            }
        });
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_panel = MenuItem::with_id(app, "open-panel", "Open Panel", true, None::<&str>)?;
    let show_island_item =
        MenuItem::with_id(app, "show-island", "Show Island", true, None::<&str>)?;
    let show_quota_bar_item =
        MenuItem::with_id(app, "show-quota-bar", "Show Quota Bar", true, None::<&str>)?;
    let hide_quota_bar_item =
        MenuItem::with_id(app, "hide-quota-bar", "Hide Quota Bar", true, None::<&str>)?;
    let open_browser =
        MenuItem::with_id(app, "open-browser", "Open Browser UI", true, None::<&str>)?;
    let open_logs = MenuItem::with_id(app, "open-logs", "Open Logs", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit OpenToken Island", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_panel,
            &show_island_item,
            &show_quota_bar_item,
            &hide_quota_bar_item,
            &open_browser,
            &open_logs,
            &separator,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("opentoken-island")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("OpenToken Island - hover for today's quota")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-panel" => {
                let _ = show_panel(app);
            }
            "show-island" => {
                let _ = show_island(app);
            }
            "show-quota-bar" => {
                let _ = show_quota_bar(app);
            }
            "hide-quota-bar" => {
                let _ = hide_quota_bar(app);
            }
            "open-browser" => {
                let _ = open_external(&local_url("popover.html"));
            }
            "open-logs" => {
                let _ = open_logs_file();
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Enter { position, rect, .. }
                | TrayIconEvent::Move { position, rect, .. } => {
                    let _ = show_hover_panel(&app, position, rect);
                }
                TrayIconEvent::Leave { .. } => {
                    schedule_hide_panel(&app, Duration::from_millis(250));
                }
                TrayIconEvent::Click {
                    position,
                    rect,
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let _ = hide_island(&app);
                    let _ = pin_panel(&app, position, rect);
                }
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn ensure_startup_registration() -> tauri::Result<()> {
    let exe = env::current_exe().map_err(|error| {
        tauri::Error::Io(IoError::new(
            error.kind(),
            format!("failed to resolve current executable for startup registration: {error}"),
        ))
    })?;
    let args = startup_registry_args(&exe);
    let mut command = Command::new("reg");
    command.args(&args);

    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);

    let output = command.output().map_err(|error| {
        tauri::Error::Io(IoError::new(
            error.kind(),
            format!("failed to register startup command: {error}"),
        ))
    })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(tauri::Error::Io(IoError::new(
            ErrorKind::Other,
            format!(
                "startup registration failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        )))
    }
}

#[cfg(any(not(target_os = "windows"), debug_assertions))]
fn ensure_startup_registration() -> tauri::Result<()> {
    Ok(())
}

fn start_server_if_needed(app: &AppHandle) -> tauri::Result<()> {
    if is_port_open(DEFAULT_PORT) {
        if is_opentoken_server(DEFAULT_PORT) {
            return Ok(());
        }
        // 端口被旧版本/unmanaged 代理占用：先请求其优雅退出（0.1.5+ 的 server.js 提供
        // /api/shutdown），等端口释放后自己接管。旧版代理没有该端点时退回原 AddrInUse 报错。
        request_server_shutdown(DEFAULT_PORT);
        if !wait_for_port_free(DEFAULT_PORT, Duration::from_secs(5)) {
            return Err(tauri::Error::Io(IoError::new(
                ErrorKind::AddrInUse,
                format!(
                    "port {DEFAULT_PORT} is occupied by a service with an incompatible OpenToken Island protocol"
                ),
            )));
        }
    }

    let server = resolve_server_path(app);
    let (server_dir, server_arg) = server_command_context(&server);
    let home = user_home();
    let opentoken = opentoken_bin(&home);
    let mut command = Command::new("node");
    command
        .arg(server_arg)
        .current_dir(server_dir)
        .env("OPENTOKEN_ISLAND_PORT", DEFAULT_PORT.to_string())
        .env("OPENTOKEN_ISLAND_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("OPENTOKEN_BIN", opentoken);

    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP 让代理脱离 GUI 进程组常驻后台
    //（DETACHED_PROCESS 与 CREATE_NO_WINDOW 互斥，只能二选一）；stdio 显式断开。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
    }

    let child = command.spawn().map_err(|error| {
        tauri::Error::Io(std::io::Error::new(
            error.kind(),
            format!(
                "failed to start OpenToken Island server at {}: {error}",
                server.display()
            ),
        ))
    })?;

    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(child);
        }
    }

    wait_for_server(DEFAULT_PORT, Duration::from_secs(3))?;
    Ok(())
}

fn wait_for_server(port: u16, timeout: Duration) -> tauri::Result<()> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if is_opentoken_server(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Err(tauri::Error::Io(IoError::new(
        ErrorKind::TimedOut,
        format!("OpenToken Island server did not become ready on port {port}"),
    )))
}

fn wait_for_port_free(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if !is_port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !is_port_open(port)
}

fn prewarm_windows(app: &AppHandle) -> tauri::Result<()> {
    let _ = ensure_panel_window(app)?;
    let _ = ensure_island_window(app)?;
    let _ = ensure_quota_bar_window(app)?;
    Ok(())
}

fn show_panel(app: &AppHandle) -> tauri::Result<()> {
    let cursor = app
        .cursor_position()
        .unwrap_or_else(|_| PhysicalPosition::new(0.0, 0.0));
    pin_panel(app, cursor, Rect::default())
}

fn pin_panel(app: &AppHandle, cursor: PhysicalPosition<f64>, rect: Rect) -> tauri::Result<()> {
    set_panel_pinned(app, true);
    bump_panel_epoch(app);
    let window = ensure_panel_window(app)?;
    let position = floating_position(
        app,
        cursor,
        rect,
        PANEL_WINDOW_WIDTH,
        PANEL_WINDOW_HEIGHT,
        FLOATING_MARGIN,
        PANEL_ANCHOR_GAP,
    );
    window.set_focusable(true)?;
    window.set_position(Position::Physical(position))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn ensure_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        return Ok(window);
    }

    let url = external_url("popover.html")?;
    WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::External(url))
        .title("OpenToken Island")
        .inner_size(PANEL_WINDOW_WIDTH as f64, PANEL_WINDOW_HEIGHT as f64)
        .decorations(false)
        .transparent(true)
        .focusable(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
}

fn show_hover_panel(
    app: &AppHandle,
    cursor: PhysicalPosition<f64>,
    rect: Rect,
) -> tauri::Result<()> {
    if is_panel_pinned(app) {
        return Ok(());
    }

    let epoch = bump_panel_epoch(app);
    let window = ensure_panel_window(app)?;
    let position = floating_position(
        app,
        cursor,
        rect,
        PANEL_WINDOW_WIDTH,
        PANEL_WINDOW_HEIGHT,
        FLOATING_MARGIN,
        PANEL_ANCHOR_GAP,
    );
    window.set_focusable(false)?;
    window.set_position(Position::Physical(position))?;
    window.show()?;
    schedule_hide_panel_at_epoch(app, Duration::from_secs(3), epoch);
    Ok(())
}

fn show_island(app: &AppHandle) -> tauri::Result<()> {
    let cursor = app
        .cursor_position()
        .unwrap_or_else(|_| PhysicalPosition::new(0.0, 0.0));
    let window = ensure_island_window(app)?;
    let position = floating_position(
        app,
        cursor,
        Rect::default(),
        ISLAND_WIDTH,
        ISLAND_HEIGHT,
        FLOATING_MARGIN,
        FLOATING_MARGIN,
    );
    window.set_position(Position::Physical(position))?;
    window.show()?;
    let _ = window.eval("window.refreshOpenTokenIsland && window.refreshOpenTokenIsland()");
    schedule_hide_island(app, Duration::from_secs(5));
    Ok(())
}

fn show_quota_bar(app: &AppHandle) -> tauri::Result<()> {
    let cursor = app
        .cursor_position()
        .unwrap_or_else(|_| PhysicalPosition::new(0.0, 0.0));
    let window = ensure_quota_bar_window(app)?;
    let position = floating_position(
        app,
        cursor,
        Rect::default(),
        QUOTA_BAR_WIDTH,
        QUOTA_BAR_HEIGHT,
        FLOATING_MARGIN,
        FLOATING_MARGIN,
    );
    window.set_position(Position::Physical(position))?;
    window.show()?;
    let _ = window.eval("window.refreshOpenTokenIsland && window.refreshOpenTokenIsland()");
    Ok(())
}

fn floating_position(
    app: &AppHandle,
    cursor: PhysicalPosition<f64>,
    rect: Rect,
    window_width: i32,
    window_height: i32,
    edge_margin: i32,
    anchor_gap: i32,
) -> PhysicalPosition<i32> {
    let rect_position = rect.position.to_physical::<i32>(1.0);
    let rect_size = rect.size.to_physical::<u32>(1.0);
    let (tray_x, tray_y, tray_width, tray_height) = if rect_size.width == 0 || rect_size.height == 0
    {
        (cursor.x.round() as i32, cursor.y.round() as i32, 32, 32)
    } else {
        (
            rect_position.x,
            rect_position.y,
            rect_size.width as i32,
            rect_size.height as i32,
        )
    };

    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let (x, y) = if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        floating_window_origin_bounded_with_anchor_gap(
            tray_x,
            tray_y,
            tray_width,
            tray_height,
            window_width,
            window_height,
            edge_margin,
            anchor_gap,
            work_area.position.x,
            work_area.position.y,
            work_area.size.width as i32,
            work_area.size.height as i32,
        )
    } else {
        floating_window_origin_bounded_with_anchor_gap(
            tray_x,
            tray_y,
            tray_width,
            tray_height,
            window_width,
            window_height,
            edge_margin,
            anchor_gap,
            0,
            0,
            window_width + edge_margin * 2,
            window_height + edge_margin * 2,
        )
    };
    PhysicalPosition::new(x, y)
}

fn ensure_quota_bar_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(QUOTA_BAR_LABEL) {
        return Ok(window);
    }

    let url = external_url("island.html")?;
    WebviewWindowBuilder::new(app, QUOTA_BAR_LABEL, WebviewUrl::External(url))
        .title("OpenToken Island Quota Bar")
        .inner_size(QUOTA_BAR_WIDTH as f64, QUOTA_BAR_HEIGHT as f64)
        .decorations(false)
        .transparent(true)
        .focusable(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
}

fn ensure_island_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        return Ok(window);
    }

    let url = external_url("island.html")?;
    WebviewWindowBuilder::new(app, ISLAND_LABEL, WebviewUrl::External(url))
        .title("OpenToken Island")
        .inner_size(560.0, 118.0)
        .decorations(false)
        .transparent(true)
        .focusable(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
}

fn schedule_hide_panel(app: &AppHandle, delay: Duration) {
    let epoch = bump_panel_epoch(app);
    schedule_hide_panel_at_epoch(app, delay, epoch);
}

fn schedule_hide_panel_at_epoch(app: &AppHandle, delay: Duration, epoch: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if current_panel_epoch(&app) == epoch && !is_panel_pinned(&app) {
            let app_for_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = hide_panel(&app_for_main);
            });
        }
    });
}

fn hide_panel(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        window.hide()?;
    }
    Ok(())
}

fn hide_pinned_panel_on_blur(app: &AppHandle) -> tauri::Result<()> {
    if is_panel_pinned(app) {
        set_panel_pinned(app, false);
        bump_panel_epoch(app);
        hide_panel(app)?;
    }
    Ok(())
}

fn schedule_hide_island(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = hide_island(&app_for_main);
        });
    });
}

fn hide_island(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        window.hide()?;
    }
    Ok(())
}

fn hide_quota_bar(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUOTA_BAR_LABEL) {
        window.hide()?;
    }
    Ok(())
}

fn set_panel_pinned(app: &AppHandle, pinned: bool) {
    if let Some(state) = app.try_state::<PanelState>() {
        state.pinned.store(pinned, Ordering::SeqCst);
        state.epoch.fetch_add(1, Ordering::SeqCst);
    }
}

fn is_panel_pinned(app: &AppHandle) -> bool {
    app.try_state::<PanelState>()
        .map(|state| state.pinned.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn bump_panel_epoch(app: &AppHandle) -> u64 {
    app.try_state::<PanelState>()
        .map(|state| state.epoch.fetch_add(1, Ordering::SeqCst) + 1)
        .unwrap_or(0)
}

fn current_panel_epoch(app: &AppHandle) -> u64 {
    app.try_state::<PanelState>()
        .map(|state| state.epoch.load(Ordering::SeqCst))
        .unwrap_or(0)
}

fn open_external(target: &str) -> std::io::Result<()> {
    Command::new("cmd")
        .args(["/C", "start", "", target])
        .spawn()
        .map(|_| ())
}

fn external_url(path: &str) -> tauri::Result<Url> {
    Url::parse(&local_url(path)).map_err(|error| {
        tauri::Error::Io(IoError::new(
            ErrorKind::InvalidInput,
            format!("invalid local OpenToken Island URL for {path}: {error}"),
        ))
    })
}

fn open_logs_file() -> std::io::Result<()> {
    let log = user_home().join(".opentoken").join("island-events.log");
    open_external(&log.to_string_lossy())
}

fn resolve_server_path(app: &AppHandle) -> PathBuf {
    let resource_server = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| server_resource_path(&dir))
        .filter(|path| path.exists());
    if let Some(path) = resource_server {
        return path;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("server.js")
}

fn user_home() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
