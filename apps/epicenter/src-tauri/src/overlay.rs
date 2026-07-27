//! The recording overlay window, created natively so it is a first-class
//! Whispering webview.
//!
//! Every webview that loads the Whispering SPA must receive the same bootstrap
//! initialization script, because the built `index.html` deliberately gates
//! SvelteKit's module graph on a global that script defines
//! (`__EPICENTER_WHISPERING_AUTH_READY__`, see `scripts/prepare-whispering-index.ts`).
//! A webview created from JavaScript with `new WebviewWindow(...)` never gets
//! that script: the gate reads `undefined`, the bootstrap throws, SvelteKit
//! never mounts, and the window paints as a blank white rectangle. Creating the
//! overlay here — through the same builder path every other surface uses — makes
//! that invariant hold by construction rather than by convention, and it applies
//! the same navigation and new-window guards as the main surfaces.
//!
//! The window is created hidden at startup and registered under the
//! `recording-overlay` label the JS window manager looks up, so the frontend
//! drives show/hide/size/position/levels through `getByLabel` and never creates
//! a webview itself.
//!
//! macOS uses an `NSPanel` rather than a plain window: a plain always-on-top
//! `WebviewWindow` still activates the app when clicked (`focusable: false` only
//! blocks keyboard focus, not application activation), which would yank
//! Whispering forward every time the user hits stop while dictating into another
//! app. An `NSPanel` with `can_become_key_window: false` never activates the app.

use tauri::webview::NewWindowResponse;
use tauri::AppHandle;

// Must stay in sync with `RECORDING_OVERLAY_WINDOW_LABEL` and the pill's sizes in
// Whispering's `recording-overlay/window-manager.tauri.ts`. The frontend resizes
// the window to fit what the pill is actually rendering, so these are only the
// initial (resting pill) dimensions.
pub const WINDOW_LABEL: &str = "recording-overlay";
const OVERLAY_WIDTH: f64 = 224.0;
const OVERLAY_HEIGHT: f64 = 40.0;

#[cfg(not(target_os = "macos"))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Create the recording overlay, hidden. The frontend resizes, repositions and
/// shows it once recording starts, so the initial geometry here is unused.
#[cfg(not(target_os = "macos"))]
pub fn create_recording_overlay(
    app: &AppHandle,
    url: tauri::Url,
    initialization_script: String,
    port: u16,
) -> tauri::Result<()> {
    use tauri::Manager;

    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }

    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("Recording")
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        // Never take focus: the overlay is display-first and the user is
        // dictating into another application while it is up.
        .focused(false)
        .focusable(false)
        .visible(false)
        .initialization_script(initialization_script)
        .on_navigation(move |url| crate::is_allowed_navigation(url, port))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;

    Ok(())
}

// `Manager` is needed in scope because the `tauri_panel!` macro expands to code
// that calls `.app_handle()` on the window.
#[cfg(target_os = "macos")]
use tauri::{Manager, WebviewUrl};
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(RecordingOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

/// Create the recording overlay panel, hidden. The frontend repositions and
/// shows it once recording starts, so the initial position here is unused.
#[cfg(target_os = "macos")]
pub fn create_recording_overlay(
    app: &AppHandle,
    url: tauri::Url,
    initialization_script: String,
    port: u16,
) -> tauri::Result<()> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let panel = PanelBuilder::<_, RecordingOverlayPanel>::new(app, WINDOW_LABEL)
        .url(WebviewUrl::External(url))
        .title("Recording")
        .position(tauri::Position::Logical(tauri::LogicalPosition {
            x: 0.0,
            y: 0.0,
        }))
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }))
        .level(PanelLevel::Status)
        // Borderless + non-activating: clicking the panel (e.g. the stop button)
        // must never activate Epicenter or raise its Whispering window while the
        // user is dictating into another app. `no_activate` only covers window
        // creation; this style bit is what makes clicks non-activating.
        .style_mask(StyleMask::empty().nonactivating_panel())
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        // Round the panel itself to the pill shape (radius = half the resting
        // height) so there is no square window backing peeking past the CSS
        // pill's rounded corners. Note this radius is fixed at creation while the
        // frontend resizes the window to fit a live transcript, so a tall overlay
        // keeps the pill's radius; unverifiable from Windows, so it is left as
        // shipped rather than retuned blind.
        .corner_radius(OVERLAY_HEIGHT / 2.0)
        // accept_first_mouse so a click lands on the stop/cancel button even
        // when the panel is not the active window (it never activates).
        .with_window(move |w| {
            w.decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
                .initialization_script(initialization_script)
                .on_navigation(move |url| crate::is_allowed_navigation(url, port))
                .on_new_window(|_, _| NewWindowResponse::Deny)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()?;
    panel.hide();
    Ok(())
}
