use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4568;

#[derive(Clone)]
struct ServiceRuntime {
    base_url: String,
    host: String,
    port: u16,
    data_dir: PathBuf,
}

#[derive(Default)]
struct ServiceState {
    runtime: Mutex<Option<ServiceRuntime>>,
    child: Mutex<Option<Child>>,
    exiting: AtomicBool,
    exit_prompt_open: AtomicBool,
}

#[derive(Deserialize, Default)]
struct StoredConfig {
    #[serde(rename = "HOST")]
    host: Option<String>,
    #[serde(rename = "PORT")]
    port: Option<u16>,
}

#[derive(Clone, Serialize)]
struct ServiceAddressPayload {
    host: String,
    port: u16,
}

#[derive(Clone, Serialize)]
struct DesktopServiceStatusPayload {
    running: bool,
    configured: ServiceAddressPayload,
    runtime: Option<ServiceAddressPayload>,
    #[serde(rename = "dataDir")]
    data_dir: String,
    #[serde(rename = "settingsPath")]
    settings_path: String,
    #[serde(rename = "databasePath")]
    database_path: String,
}

impl Drop for ServiceState {
    fn drop(&mut self) {
        stop_embedded_service(self);
    }
}

#[tauri::command]
fn service_base_url(state: State<'_, ServiceState>) -> Result<String, String> {
    current_runtime(state.inner()).map(|runtime| runtime.base_url)
}

#[tauri::command]
fn desktop_service_status(
    state: State<'_, ServiceState>,
) -> Result<DesktopServiceStatusPayload, String> {
    read_service_status(state.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_bootstrap_config(
    state: State<'_, ServiceState>,
    host: String,
    port: u16,
) -> Result<DesktopServiceStatusPayload, String> {
    write_bootstrap_config(host, port)
        .and_then(|_| read_service_status(state.inner()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_embedded_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<DesktopServiceStatusPayload, String> {
    ensure_embedded_service_running(&app, state.inner())
        .and_then(|_| read_service_status(state.inner()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_embedded_service_command(
    state: State<'_, ServiceState>,
) -> Result<DesktopServiceStatusPayload, String> {
    stop_embedded_service(state.inner());
    read_service_status(state.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
fn export_config_file(
    state: State<'_, ServiceState>,
    content: String,
    file_name: Option<String>,
) -> Result<Option<String>, String> {
    let default_file_name = file_name.unwrap_or_else(|| String::from("settings.json"));
    let default_directory = current_runtime(state.inner())
        .map(|runtime| runtime.data_dir)
        .or_else(|_| desktop_data_dir().map_err(|error| error.to_string()))?;

    let Some(path) = FileDialog::new()
        .set_directory(default_directory)
        .set_file_name(&default_file_name)
        .save_file()
    else {
        return Ok(None);
    };

    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn open_config_dir(state: State<'_, ServiceState>) -> Result<String, String> {
    let data_dir = current_runtime(state.inner())
        .map(|runtime| runtime.data_dir)
        .or_else(|_| desktop_data_dir().map_err(|error| error.to_string()))?;

    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    open_path(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir.display().to_string())
}

#[tauri::command]
fn restart_embedded_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<String, String> {
    restart_service(&app, state.inner())
        .map(|runtime| runtime.base_url)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServiceState::default())
        .on_window_event(handle_window_event)
        .invoke_handler(tauri::generate_handler![
            service_base_url,
            desktop_service_status,
            save_bootstrap_config,
            start_embedded_service,
            stop_embedded_service_command,
            export_config_file,
            open_config_dir,
            restart_embedded_service
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    let state = window.state::<ServiceState>();
    if state.exiting.load(Ordering::SeqCst) {
        return;
    }

    api.prevent_close();
    request_exit_confirmation(&window.app_handle(), state.inner());
}

fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        let state = app.state::<ServiceState>();
        if state.exiting.load(Ordering::SeqCst) {
            stop_embedded_service(state.inner());
            return;
        }

        api.prevent_exit();
        request_exit_confirmation(app, state.inner());
    }
}

fn shutdown_and_exit(app: &AppHandle) {
    let state = app.state::<ServiceState>();
    state.exiting.store(true, Ordering::SeqCst);
    state.exit_prompt_open.store(false, Ordering::SeqCst);
    stop_embedded_service(state.inner());
    app.exit(0);
}

fn request_exit_confirmation(app: &AppHandle, state: &ServiceState) {
    if state.exiting.load(Ordering::SeqCst) {
        return;
    }

    if state.exit_prompt_open.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app.clone();
    app.dialog()
        .message("退出后将关闭本地服务和内嵌 Node 进程，确认现在退出吗？")
        .title("确认退出")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            String::from("退出"),
            String::from("取消"),
        ))
        .show(move |confirmed| {
            let state = app_handle.state::<ServiceState>();
            state.exit_prompt_open.store(false, Ordering::SeqCst);

            if confirmed {
                shutdown_and_exit(&app_handle);
            }
        });
}

fn ensure_embedded_service_running(
    app: &AppHandle,
    state: &ServiceState,
) -> Result<ServiceRuntime, Box<dyn std::error::Error>> {
    if let Ok(runtime_guard) = state.runtime.lock() {
        if let Some(runtime) = runtime_guard.clone() {
            return Ok(runtime);
        }
    }

    let data_dir = desktop_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let runtime = load_runtime(&data_dir)?;
    spawn_service_with_runtime(app, state, runtime)
}

fn restart_service(
    app: &AppHandle,
    state: &ServiceState,
) -> Result<ServiceRuntime, Box<dyn std::error::Error>> {
    let previous_runtime = state
        .runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.clone());
    let data_dir = desktop_data_dir()?;
    let next_runtime = load_runtime(&data_dir)?;

    stop_embedded_service(state);

    match spawn_service_with_runtime(app, state, next_runtime.clone()) {
        Ok(runtime) => Ok(runtime),
        Err(error) => {
            if let Some(previous_runtime) = previous_runtime {
                if spawn_service_with_runtime(app, state, previous_runtime.clone()).is_ok() {
                    return Err(format!(
                        "failed to apply new Host/Port, rolled back to {}: {error}",
                        previous_runtime.base_url
                    )
                    .into());
                }
            }

            Err(error)
        }
    }
}

fn spawn_service_with_runtime(
    app: &AppHandle,
    state: &ServiceState,
    runtime: ServiceRuntime,
) -> Result<ServiceRuntime, Box<dyn std::error::Error>> {
    fs::create_dir_all(&runtime.data_dir)?;

    let mut child = spawn_service_process(app, &runtime)?;

    if let Some(stdout) = child.stdout.take() {
        pipe_logs(stdout, "stdout");
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_logs(stderr, "stderr");
    }

    wait_for_service(&mut child, &runtime, Duration::from_secs(20))?;

    {
        let mut runtime_guard = state
            .runtime
            .lock()
            .map_err(|_| String::from("failed to store desktop service runtime"))?;
        *runtime_guard = Some(runtime.clone());
    }
    {
        let mut child_guard = state
            .child
            .lock()
            .map_err(|_| String::from("failed to store desktop service process"))?;
        *child_guard = Some(child);
    }

    Ok(runtime)
}

fn spawn_service_process(
    app: &AppHandle,
    runtime: &ServiceRuntime,
) -> Result<Child, Box<dyn std::error::Error>> {
    let node_path = embedded_node_path(app)?;
    let runtime_root = embedded_runtime_root(app)?;
    let server_entry = runtime_root.join("server.cjs");

    ensure_executable(&node_path)?;

    Ok(Command::new(&node_path)
        .arg(&server_entry)
        .current_dir(&runtime_root)
        .env("DATA_DIR", &runtime.data_dir)
        .env("HOST", &runtime.host)
        .env("PORT", runtime.port.to_string())
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?)
}

fn stop_embedded_service(state: &ServiceState) {
    if let Ok(mut child_guard) = state.child.lock() {
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    if let Ok(mut runtime_guard) = state.runtime.lock() {
        *runtime_guard = None;
    }
}

fn read_service_status(
    state: &ServiceState,
) -> Result<DesktopServiceStatusPayload, Box<dyn std::error::Error>> {
    let data_dir = desktop_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let configured_runtime = load_runtime(&data_dir)?;
    let runtime = state
        .runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.clone());

    Ok(DesktopServiceStatusPayload {
        running: runtime.is_some(),
        configured: ServiceAddressPayload {
            host: configured_runtime.host,
            port: configured_runtime.port,
        },
        runtime: runtime.map(|runtime| ServiceAddressPayload {
            host: runtime.host,
            port: runtime.port,
        }),
        data_dir: configured_runtime.data_dir.display().to_string(),
        settings_path: settings_path(&configured_runtime.data_dir)
            .display()
            .to_string(),
        database_path: database_path(&configured_runtime.data_dir)
            .display()
            .to_string(),
    })
}

fn write_bootstrap_config(host: String, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let trimmed_host = host.trim();
    if trimmed_host.is_empty() {
        return Err("HOST 不能为空".into());
    }

    let data_dir = desktop_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let settings_path = settings_path(&data_dir);

    let mut payload = if settings_path.exists() {
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&settings_path)?)?
    } else {
        serde_json::json!({})
    };

    let object = payload
        .as_object_mut()
        .ok_or("settings.json 必须是 JSON 对象")?;

    object.insert(
        String::from("HOST"),
        serde_json::Value::String(String::from(trimmed_host)),
    );
    object.insert(
        String::from("PORT"),
        serde_json::Value::Number(serde_json::Number::from(port)),
    );

    fs::write(
        settings_path,
        format!("{}\n", serde_json::to_string_pretty(&payload)?),
    )?;
    Ok(())
}

fn current_runtime(state: &ServiceState) -> Result<ServiceRuntime, String> {
    let runtime_guard = state
        .runtime
        .lock()
        .map_err(|_| String::from("failed to access desktop service state"))?;

    runtime_guard
        .clone()
        .ok_or_else(|| String::from("desktop service is not ready"))
}

fn load_runtime(data_dir: &Path) -> Result<ServiceRuntime, Box<dyn std::error::Error>> {
    let settings_path = data_dir.join("settings.json");
    let stored = if settings_path.exists() {
        serde_json::from_str::<StoredConfig>(&fs::read_to_string(settings_path)?)?
    } else {
        StoredConfig::default()
    };

    let host = stored
        .host
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| String::from(DEFAULT_HOST));
    let port = stored.port.unwrap_or(DEFAULT_PORT);

    Ok(ServiceRuntime {
        base_url: format!("http://{host}:{port}"),
        host,
        port,
        data_dir: data_dir.to_path_buf(),
    })
}

fn wait_for_service(
    child: &mut Child,
    runtime: &ServiceRuntime,
    timeout: Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if can_connect(&runtime.host, runtime.port) {
            return Ok(());
        }

        if let Some(status) = child.try_wait()? {
            return Err(format!("embedded service exited early with status {status}").into());
        }

        thread::sleep(Duration::from_millis(200));
    }

    Err(format!(
        "timed out waiting for desktop service on {}",
        runtime.base_url
    )
    .into())
}

fn can_connect(host: &str, port: u16) -> bool {
    let timeout = Duration::from_millis(200);
    let address = format!("{host}:{port}");

    address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .is_some_and(|socket_addr| TcpStream::connect_timeout(&socket_addr, timeout).is_ok())
}

fn embedded_runtime_root(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("app");
    if source_path.exists() {
        return Ok(source_path);
    }

    Ok(app.path().resource_dir()?.join("app"))
}

fn embedded_node_path(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("bin")
        .join(executable_name);

    if source_path.exists() {
        return Ok(source_path);
    }

    Ok(app.path().resource_dir()?.join("bin").join(executable_name))
}

fn desktop_data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        return Ok(PathBuf::from(home).join(".node-claude-code"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(std::env::current_dir()?.join("data"))
    }
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join("node-claude-code.db")
}

fn ensure_executable(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }

    Ok(())
}

fn open_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open").arg(path).status()?;
        if status.success() {
            return Ok(());
        }
        return Err("failed to open path".into());
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer").arg(path).status()?;
        if status.success() {
            return Ok(());
        }
        return Err("failed to open path".into());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open").arg(path).status()?;
        if status.success() {
            return Ok(());
        }
        return Err("failed to open path".into());
    }
}

fn pipe_logs<T>(stream: T, channel: &'static str)
where
    T: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(content) => println!("[embedded-service:{channel}] {content}"),
                Err(error) => {
                    eprintln!("[embedded-service:{channel}] failed to read log line: {error}");
                    break;
                }
            }
        }
    });
}
