use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as NativeShortcutState};
use tauri_specta::Event;

use crate::{request_surface, DesktopAppHandle, Surface};

const TRAY_ID: &str = "epicenter-tray";
const WHISPERING_WINDOW: &str = "whispering";

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutRegistration {
    pub command_id: String,
    pub accelerator: String,
}

#[derive(Clone, Copy, Debug, Serialize, specta::Type)]
pub enum GlobalShortcutState {
    Pressed,
    Released,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutTriggered {
    pub command_id: String,
    pub state: GlobalShortcutState,
}

#[derive(Default)]
pub struct GlobalShortcutRegistry(Mutex<Vec<GlobalShortcutRegistration>>);

pub fn create_tray(app: &DesktopAppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show-whispering", "Open Whispering")
        .separator()
        .text("quit", "Quit Whispering")
        .build()?;
    let icon = tray_icon(false)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Whispering")
        .menu(&menu)
        // The tray icon is the app's only permanent surface once the window goes
        // away on both close and minimize, so the cheap gesture — a left click —
        // opens Whispering, and the menu stays on right click. With the default
        // (menu on left click) every trip back to the window costs two clicks.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                request_surface(tray.app_handle(), Surface::Whispering);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-whispering" => request_surface(app, Surface::Whispering),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    #[cfg(windows)]
    promote_tray_icon_once(app);

    Ok(())
}

/// Ask Windows 11 to keep our tray icon beside the clock instead of filing it in
/// the overflow flyout.
///
/// Windows 11 hides every newly registered notification icon behind the `^`
/// chevron and offers no API to opt out — the only switch is
/// Settings → Personalization → Taskbar → "Other system tray icons", which writes
/// `IsPromoted` under `HKCU\Control Panel\NotifyIconSettings\<hash>`. Explorer
/// reads that value live, so writing it moves the icon out immediately.
///
/// This app earns the exception: with the window going to the tray on both close
/// and minimize, an icon the user cannot see is an app with no visible surface at
/// all. It is still their preference, so this runs **once ever** — a marker file
/// records that we have asked, and anyone who afterwards drags the icon back into
/// the overflow keeps it there.
#[cfg(windows)]
fn promote_tray_icon_once(app: &DesktopAppHandle) {
    use tauri::Manager;

    let Ok(marker) = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join("tray-icon-promoted"))
    else {
        return;
    };
    if marker.exists() {
        return;
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };

    // The registry record is created by Explorer when the icon is first
    // published, which on a fresh install happens moments after this call. Poll
    // briefly rather than give up on the launch that mattered most.
    tauri::async_runtime::spawn(async move {
        for _ in 0..20 {
            match promote_notify_icon(&exe) {
                Ok(true) => {
                    if let Some(parent) = marker.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Err(error) = std::fs::write(&marker, b"1") {
                        log::warn!("record the tray icon promotion: {error}");
                    }
                    return;
                }
                Ok(false) => {}
                Err(error) => {
                    log::warn!("promote the Whispering tray icon: {error}");
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        log::warn!("the Whispering tray icon never appeared in NotifyIconSettings");
    });
}

/// Set `IsPromoted` on every notification-icon record belonging to `exe`.
/// `Ok(false)` means no record exists yet, which is the expected answer in the
/// seconds before Explorer publishes the icon on a fresh install.
#[cfg(windows)]
fn promote_notify_icon(exe: &std::path::Path) -> std::io::Result<bool> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const SETTINGS: &str = r"Control Panel\NotifyIconSettings";

    let root = RegKey::predef(HKEY_CURRENT_USER).open_subkey(SETTINGS)?;
    let mut promoted = false;
    for name in root.enum_keys().filter_map(Result::ok) {
        let Ok(entry) = root.open_subkey_with_flags(&name, KEY_READ | KEY_SET_VALUE) else {
            continue;
        };
        let Ok(recorded) = entry.get_value::<String, _>("ExecutablePath") else {
            continue;
        };
        if !is_same_executable(&recorded, exe) {
            continue;
        }
        entry.set_value("IsPromoted", &1u32)?;
        promoted = true;
    }
    Ok(promoted)
}

/// Whether a recorded `ExecutablePath` names our executable.
///
/// Compared case-insensitively, and by the trailing directory plus file name as
/// well as the whole path: Explorer rewrites paths under a known folder as a
/// GUID (`{6D809377-…}\App\app.exe` for Program Files), so a full-path match
/// alone would silently never fire for a machine-wide install.
#[cfg(windows)]
fn is_same_executable(recorded: &str, exe: &std::path::Path) -> bool {
    fn tail(path: &str) -> Option<String> {
        let parts: Vec<&str> = path
            .rsplit(['\\', '/'])
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        (parts.len() == 2).then(|| parts.join("\\").to_ascii_lowercase())
    }

    let exe = exe.to_string_lossy();
    if recorded.eq_ignore_ascii_case(&exe) {
        return true;
    }
    match (tail(recorded), tail(&exe)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

pub fn set_tray_recording_state(app: &AppHandle, recording: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match tray_icon(recording).and_then(|icon| tray.set_icon(Some(icon))) {
        Ok(()) => {}
        Err(error) => log::warn!("update Epicenter tray recording state: {error}"),
    }
}

fn tray_icon(recording: bool) -> tauri::Result<Image<'static>> {
    let bytes = if recording {
        include_bytes!("../recorder-state-icons/red_large_square.png").as_slice()
    } else {
        include_bytes!("../recorder-state-icons/studio_microphone.png").as_slice()
    };
    Image::from_bytes(bytes)
}

#[tauri::command]
#[specta::specta]
pub fn replace_global_shortcuts(
    app: AppHandle<Wry>,
    registry: tauri::State<'_, GlobalShortcutRegistry>,
    registrations: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
    validate_registrations(&registrations)?;
    let mut current = registry
        .0
        .lock()
        .map_err(|_| "global shortcut registry lock poisoned".to_string())?;
    let previous = current.clone();

    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    if let Err(error) = register_all(&app, &registrations) {
        let _ = app.global_shortcut().unregister_all();
        if let Err(rollback_error) = register_all(&app, &previous) {
            log::error!(
                "restore Epicenter global shortcuts after failed replacement: {rollback_error}"
            );
        }
        return Err(error);
    }

    *current = registrations;
    Ok(())
}

fn validate_registrations(registrations: &[GlobalShortcutRegistration]) -> Result<(), String> {
    let mut command_ids = HashSet::new();
    let mut accelerators = HashSet::new();
    for registration in registrations {
        if registration.command_id.is_empty() || registration.accelerator.is_empty() {
            return Err("global shortcut command ids and accelerators must not be empty".into());
        }
        if !command_ids.insert(&registration.command_id) {
            return Err(format!(
                "duplicate global shortcut command id: {}",
                registration.command_id
            ));
        }
        if !accelerators.insert(&registration.accelerator) {
            return Err(format!(
                "duplicate global shortcut accelerator: {}",
                registration.accelerator
            ));
        }
    }
    Ok(())
}

fn register_all(
    app: &AppHandle<Wry>,
    registrations: &[GlobalShortcutRegistration],
) -> Result<(), String> {
    for registration in registrations {
        let command_id = registration.command_id.clone();
        app.global_shortcut()
            .on_shortcut(registration.accelerator.as_str(), move |app, _, event| {
                let state = match event.state() {
                    NativeShortcutState::Pressed => GlobalShortcutState::Pressed,
                    NativeShortcutState::Released => GlobalShortcutState::Released,
                };
                let _ = GlobalShortcutTriggered {
                    command_id: command_id.clone(),
                    state,
                }
                .emit_to(app, WHISPERING_WINDOW);
            })
            // Name the chord that failed. Registration is replace-all, so one
            // refusal fails the batch and rolls everything back; without the
            // accelerator in the message the user is told only that "registering
            // shortcuts" failed, with no way to tell which key to change. The
            // plugin's own error spells the chord as a Rust debug struct
            // (`HotKey { mods: Modifiers(CONTROL | SUPER), key: KeyD, .. }`),
            // which is worse than useless to read, so the caller reformats from
            // this accelerator instead.
            .map_err(|error| format!("{}: {error}", registration.accelerator))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_autostart_enabled(app: AppHandle<Wry>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_autostart_enabled(app: AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(command_id: &str, accelerator: &str) -> GlobalShortcutRegistration {
        GlobalShortcutRegistration {
            command_id: command_id.into(),
            accelerator: accelerator.into(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn tray_icon_records_are_matched_through_known_folder_guids() {
        use std::path::Path;

        let exe = Path::new(r"C:\Users\me\AppData\Local\Whispering\epicenter.exe");
        // The plain path Explorer records for a per-user install, any casing.
        assert!(is_same_executable(
            r"c:\users\me\appdata\local\whispering\epicenter.exe",
            exe
        ));
        // A machine-wide install is recorded under a known-folder GUID, so a
        // whole-path comparison would never match and the icon would stay in the
        // overflow forever.
        assert!(is_same_executable(
            r"{6D809377-6AF0-444B-8957-A3773F02200E}\Whispering\epicenter.exe",
            exe
        ));
        // Another app's icon must never be promoted on our behalf.
        assert!(!is_same_executable(
            r"C:\Users\me\AppData\Local\Other\epicenter.exe",
            exe
        ));
        assert!(!is_same_executable(
            r"C:\Users\me\AppData\Local\Whispering\other.exe",
            exe
        ));
    }

    #[test]
    fn shortcut_replacement_rejects_duplicate_owners() {
        let duplicate_command = [
            registration("record", "Cmd+R"),
            registration("record", "Cmd+T"),
        ];
        assert!(validate_registrations(&duplicate_command).is_err());

        let duplicate_accelerator = [
            registration("record", "Cmd+R"),
            registration("cancel", "Cmd+R"),
        ];
        assert!(validate_registrations(&duplicate_accelerator).is_err());
    }
}
