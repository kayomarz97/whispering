# Project Playbook

## External service & API notes

### Groq API — Speech-to-Text (Whisper) and Chat Completions (Llama) — as of 2026-07-25

**Bottom line: Groq's STT is batch-only. There is no live/streaming/websocket transcription
endpoint from Groq.** If the product needs true progressive live captions, either (a) chunk
client-side against Groq's batch endpoint (adds latency + word-boundary risk, see below), or
(b) use a different provider for the live leg (e.g. Deepgram, AssemblyAI, OpenAI Realtime,
or a browser-native Web Speech API pass) and reserve Groq for the fast, cheap Llama cleanup
step. Do not build against an assumed Groq realtime endpoint — it does not exist.

Do not confuse "Groq" (GroqCloud, console.groq.com, LPU inference) with "Grok"/xAI
(docs.x.ai, `wss://api.x.ai/v1/stt`). xAI's Grok STT API does have a real-time websocket
(launched ~April 2026), but that is a different company/product and is not what this
project is integrating with.

#### 1. Audio transcription/translation — batch only, no streaming

- Endpoint (transcription): `POST https://api.groq.com/openai/v1/audio/transcriptions`
- Endpoint (translation to English): `POST https://api.groq.com/openai/v1/audio/translations`
- Request: multipart/form-data upload of a **complete** audio file. No chunked-transfer /
  websocket / SSE variant is documented for audio input or output.
- Models:
  - `whisper-large-v3-turbo` — multilingual, faster/cheaper, ~$0.04/hour audio
  - `whisper-large-v3` — multilingual, higher accuracy, ~$0.111/hour audio
- Limits: max file size 25 MB (free tier) / 100 MB (dev tier); min duration 0.01s; min
  *billed* duration 10s. Supported formats: FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, WebM.
- Useful params: `model`, `language` (ISO-639-1), `prompt` (max 224 tokens),
  `response_format` (json / verbose_json / text), `temperature`,
  `timestamp_granularities` (segment and/or word level).
- No websocket or SSE streaming exists for STT. The docs page does not mention partial or
  incremental results at all — you get the full transcript back only after the whole file
  is processed.

Source: https://console.groq.com/docs/speech-to-text (read 2026-07-25)

#### 2. Recommended near-real-time pattern (official guidance = chunking, not streaming)

Groq's own cookbook documents client-side **audio chunking** as the pattern for
longer/near-real-time use, not a native streaming mode:
- Break audio into segments, process each independently, stitch results together.
- Best practice from the cookbook: 16kHz mono audio, prefer FLAC for lossless compression;
  for long audio (>10 min) use ~10-minute chunks with ~10-second overlap to avoid cutting
  words at chunk boundaries, then de-duplicate the overlap on stitch.
- Tradeoffs to plan around for *live-caption*-style short chunks (e.g. 2-5s segments):
  - **Word-boundary cutting**: short chunks will regularly cut mid-word/mid-phrase; the
    10s-overlap pattern from the cookbook is designed for long-file chunking, not
    caption-latency chunking — expect to tune overlap/VAD for short segments yourself,
    there's no Groq-documented recipe at caption-length chunk sizes.
  - **Latency**: each chunk is a full HTTP request/response round trip (upload + Whisper
    inference), so realistic "live" latency is roughly whole-chunk-duration plus network
    and inference time, not per-word — this is fundamentally captions-with-a-delay, not
    true streaming.
  - **Cost**: min *billed* duration is 10 seconds per Groq's docs — sending many
    sub-10-second chunks means you are billed a 10s floor on each one, which can multiply
    cost significantly versus sending fewer, longer chunks.
  - **Rate limits**: whisper-large-v3-turbo ≈ 400 RPM / 400K audio-seconds-per-hour(ASH);
    whisper-large-v3 ≈ 300 RPM / 200K ASH (tier-dependent) — many small requests eat into
    the RPM budget fast.
- A Groq devrel example repo (`build-with-groq/groq-speech`, not official docs) shows a
  reference implementation of near-real-time transcription from live microphone input using
  client-side VAD + chunked calls to the batch endpoint — confirms the ecosystem consensus
  that chunking-against-batch is the pattern, since there's no native streaming API to
  target. Treat as an example, not a documented guarantee.

Sources: https://console.groq.com/docs/speech-to-text (read 2026-07-25),
https://github.com/groq/groq-api-cookbook (read 2026-07-25),
https://github.com/build-with-groq/groq-speech (read 2026-07-25, community/devrel example,
not console.groq.com docs)

#### 3. Chat completions — Llama models DO support SSE token streaming

- Endpoint: `POST https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible)
- Enable streaming: pass `stream=True` (or `stream: true` in raw JSON) on the request. The
  response becomes an iterator/stream of completion-delta chunks (standard OpenAI-style SSE),
  not one full completion.
- Current recommended Llama model: `llama-3.3-70b-versatile` (~280 tokens/sec on Groq).
  Other production models on Groq as of this read: `llama-3.1-8b-instant` (~560 tok/s,
  smaller/cheaper), `openai/gpt-oss-120b` (~500 tok/s), `openai/gpt-oss-20b` (~1000 tok/s),
  plus "Compound"/"Compound Mini" agentic systems with built-in web search/code execution.
  No Llama version newer than 3.3 was listed on Groq's models page as of 2026-07-25.

Sources: https://console.groq.com/docs/text-chat (read 2026-07-25),
https://console.groq.com/docs/models (read 2026-07-25)

#### 4. Discovering the current model list programmatically

- `GET https://api.groq.com/openai/v1/models` returns the live, authoritative model list
  (OpenAI-compatible `/models` shape). Prefer this over hardcoding model names, since Groq
  adds/deprecates models between doc reads — this project confirmed the endpoint exists via
  the API reference page but did not capture a live response body in this session.

Source: https://console.groq.com/docs/api-reference (read 2026-07-25)

**Gotcha to remember**: "Groq" (this service) and "Grok" (xAI) are unrelated companies with
confusingly similar names and both have AI audio products — double-check the domain
(`console.groq.com` / `api.groq.com` vs `docs.x.ai` / `api.x.ai`) before trusting any search
result about "real-time Gro(q/k) speech."

### Tauri v2 — system tray + hide-from-taskbar (read 2026-07-25)

Installed version in this repo: `tauri = "2.11"` with `features = ["tray-icon", ...]` in
`apps/epicenter/src-tauri/Cargo.toml`. A tray is already implemented in
`apps/epicenter/src-tauri/src/shell.rs::create_tray` (menu with Show Query / Show Whispering /
Quit) — extend that function rather than adding a second tray.

**Cargo.toml**
```toml
tauri = { version = "2.0.0", features = [ "tray-icon" ] }
```

**Rust — build the tray** (`tauri::tray::TrayIconBuilder`)
```rust
use tauri::tray::TrayIconBuilder;
let tray = TrayIconBuilder::new().build(app)?;
```

**Rust — restore window on tray left-click** (official Tauri v2 example pattern):
```rust
use tauri::{Manager, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}};

TrayIconBuilder::new()
  .on_tray_icon_event(|tray, event| match event {
    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
      let app = tray.app_handle();
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }
    _ => {}
  })
```

**Hide-to-tray on close (NOT documented on the official System Tray guide page — that page only
covers building the tray/menu/events, not close interception).** The ground-truth pattern, per
`tauri::WindowEvent::CloseRequested` and `CloseRequestApi::prevent_close()`
(https://docs.rs/tauri/latest/tauri/struct.CloseRequestApi.html — `pub fn prevent_close(&self)`,
exposed on the `CloseRequested` variant's `api` field) is:
```rust
window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
});
```
Combine with `skip_taskbar` so a hidden window disappears from the Windows taskbar:
- Rust: `window.set_skip_taskbar(true)` (permission `core:window:allow-set-skip-taskbar`)
- JS: `import { getCurrentWindow } from '@tauri-apps/api/window'; await getCurrentWindow().setSkipTaskbar(true);`
- Static config (`tauri.conf.json` → `app.windows[]`): `"skipTaskbar": true`

**tauri.conf.json window config keys** (from https://v2.tauri.app/reference/config/,
`app.windows[]` array): `label`, `width`, `height`, `x`, `y`, `resizable`, `fullscreen`, `title`,
`focus`, `visible`, `transparent`, `decorations`, `alwaysOnTop`, `shadow`, `skipTaskbar`.
Top-level `app.trayIcon` object also exists: `iconPath` (required), `tooltip`, `title`, `id`,
`showMenuOnLeftClick`, `iconAsTemplate`.

**Capabilities/permissions needed** (`src-tauri/capabilities/*.json`, permission strings verified
verbatim against https://v2.tauri.app/reference/acl/core-permissions/ as of 2026-07-25):
- `core:window:allow-hide`, `core:window:allow-show`, `core:window:allow-set-skip-taskbar`,
  `core:window:allow-set-focus`, `core:window:allow-unminimize`
- `core:tray:allow-new` / `core:tray:allow-set-icon` / `core:tray:allow-set-menu` only if the tray
  is built/mutated from JS instead of Rust (Rust-side tray building via `TrayIconBuilder` inside
  `setup()` does not need ACL permissions — ACL only gates JS→Rust IPC commands).
- `core:app:allow-app-hide` / `core:app:allow-app-show` only if also hiding the whole app
  (macOS-style), not needed for a pure single-window tray-minimize flow on Windows.

**Windows 11 caveat:** tray icon click/double-click/enter/leave events are NOT supported on Linux
(icon + right-click menu still work there) — not itself a Windows concern, but don't assume
feature parity if the fork ever also targets Linux. No Windows-specific gotcha was found in the
official tray page; the close-to-tray recipe above is standard, well-established Tauri practice
built from the documented `CloseRequestApi`, but it is **not written up as an official "recipe"
page** — flagging that gap explicitly rather than presenting the System Tray guide as covering it.

Source: https://v2.tauri.app/learn/system-tray/ (read 2026-07-25, fetched verbatim),
https://v2.tauri.app/reference/config/ (read 2026-07-25),
https://v2.tauri.app/reference/acl/core-permissions/ (read 2026-07-25),
https://docs.rs/tauri/latest/tauri/struct.CloseRequestApi.html (read 2026-07-25).

---

### Tauri v2 — global-shortcut plugin + secondary overlay window (read 2026-07-25)

Installed: `tauri-plugin-global-shortcut = "2"` in Cargo.toml, already wired in
`apps/epicenter/src-tauri/src/shell.rs` (`replace_global_shortcuts` command, dynamic
register/unregister with rollback-on-failure). `apps/epicenter/src-tauri/src/overlay.rs` already
builds a macOS-only non-activating `NSPanel` overlay via `tauri-nspanel`; there is currently no
Windows equivalent — a plain `WebviewWindow` is the right primitive to start from on Windows since
`tauri-nspanel` is macOS-only.

**npm package:** `@tauri-apps/plugin-global-shortcut`
**Cargo:** `tauri-plugin-global-shortcut = "2"` (already present)
`cargo add tauri-plugin-global-shortcut --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`

**Rust setup**
```rust
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

let ctrl_n = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyN);
app.handle().plugin(
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |_app, shortcut, event| {
            if shortcut == &ctrl_n {
                match event.state() {
                    ShortcutState::Pressed => { /* toggle overlay */ }
                    ShortcutState::Released => {}
                }
            }
        })
        .build(),
)?;
app.global_shortcut().register(ctrl_n)?;
```
This registers a truly system-wide hotkey — it fires even when the app/window is unfocused; that
is the plugin's whole purpose (no extra config is needed to make it "work while unfocused").

**JS API**
```javascript
import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
await register('CommandOrControl+Shift+C', () => { /* ... */ });
```

**Capabilities** (verbatim from the plugin's own docs page, https://v2.tauri.app/plugin/global-shortcut/,
read 2026-07-25): no permission is enabled by default ("we believe the shortcuts can be inherently
dangerous"). Required identifiers: `global-shortcut:allow-register`,
`global-shortcut:allow-unregister`, `global-shortcut:allow-is-registered`, plus `-all` variants
(`global-shortcut:allow-register-all`, `global-shortcut:allow-unregister-all`) if bulk
(un)registering. Deny variants exist for every allow (`global-shortcut:deny-*`).

**Secondary overlay `WebviewWindow` — borderless, always-on-top, transparent, non-activating,
skip-taskbar, positioned at a monitor corner.**

Rust builder (`tauri::WebviewWindowBuilder`) mirrors the JS `WindowOptions`/`WebviewOptions`
fields documented at https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/
(read 2026-07-25):
```rust
use tauri::{WebviewUrl, WebviewWindowBuilder};

let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)          // do not steal focus on creation
    .visible(false)          // start hidden; show() on hotkey
    .inner_size(320.0, 80.0)
    .build()?;
```
JS equivalent (`@tauri-apps/api/webviewWindow`):
```javascript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
const overlay = new WebviewWindow('overlay', {
  url: 'overlay.html',
  decorations: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focus: false,
  visible: false,
  width: 320,
  height: 80,
});
```

**Non-focusable / non-activating gap (important, flagged explicitly):** the official Tauri v2 JS/
Rust window API has `setFocusable(bool)` / `.focusable(false)`, which blocks *keyboard* focus, and
`focus: false` at creation, which avoids activating it at creation time — but per this repo's own
code comment in `overlay.rs`, a plain `WebviewWindow`/`focusable(false)` still **activates the
whole app** on click (it only blocks keyboard focus, not app activation). On macOS this repo works
around it with `tauri-nspanel` (`can_become_key_window: false`, `nonactivating_panel` style mask) —
that crate is macOS-only. **No official Tauri v2 doc page addresses a true non-activating window on
Windows**; this is a documentation gap, not a confirmed capability. If true non-activating behavior
is required on Windows 11, it will likely need a Win32-level workaround (e.g. `WS_EX_NOACTIVATE`
extended window style applied to the HWND via `raw-window-handle`/`windows-rs`, both already a
dependency of this repo on the Windows target) — re-run docs-researcher on that specific point
before implementing; do not assume `.focusable(false)` alone suffices on Windows.

**Positioning at a monitor corner** — JS monitor API
(https://v2.tauri.app/reference/javascript/api/namespacewindow/, read 2026-07-25):
```typescript
currentMonitor(): Promise<Monitor | null>
primaryMonitor(): Promise<Monitor | null>
availableMonitors(): Promise<Monitor[]>
```
`Monitor` exposes `.size` (`PhysicalSize`) and `.position` (`PhysicalPosition`). The docs surfaced
in this session did not distinguish a separate "work area" (taskbar-excluded) rect from `.size` —
if precise taskbar-avoidance is required, verify whether the installed `@tauri-apps/api` version's
`.d.ts` exposes a work-area field before relying on `.size` alone (flagged gap; do not assume
`.size` already excludes the Windows taskbar strip).
```javascript
import { getCurrentWindow, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
const monitor = await currentMonitor();
const win = getCurrentWindow();
await win.setPosition(new PhysicalPosition(
  monitor.position.x + monitor.size.width - overlayWidth,
  monitor.position.y + monitor.size.height - overlayHeight,
)); // bottom-right corner example
```
Rust side: `window.current_monitor()?`, `.set_position(...)` are the analogous calls
(`core:window:allow-current-monitor`, `core:window:allow-set-position` permissions).

**Show/hide programmatically:** `window.show()` / `window.hide()` (Rust) or
`getCurrentWindow().show()/.hide()` (JS); requires `core:window:allow-show` /
`core:window:allow-hide` in the relevant capability file for that window label (this repo scopes
capabilities per-window — e.g. `trusted-whispering-overlay-production.json` already restricts
`windows: ["recording-overlay"]` — add the new overlay's label there or to a sibling file, not to a
global capability).

Source: https://v2.tauri.app/plugin/global-shortcut/ (read 2026-07-25),
https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/ (read 2026-07-25),
https://v2.tauri.app/reference/javascript/api/namespacewindow/ (read 2026-07-25),
https://v2.tauri.app/reference/config/ (read 2026-07-25),
`apps/epicenter/src-tauri/src/overlay.rs` (this repo, read 2026-07-25) for the documented
non-activating-window gap on non-macOS platforms.

---

### Tauri v2 — tauri-plugin-updater with GitHub Releases (read 2026-07-25)

Not yet in this repo's Cargo.toml — would be a new dependency.

**npm:** `@tauri-apps/plugin-updater` (and `@tauri-apps/plugin-process` for `relaunch()`)
**Cargo:** `cargo add tauri-plugin-updater --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`
(mobile has no support indicator in the docs — treat updater as desktop-only.)

**tauri.conf.json**
```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://releases.myapp.com/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```
`{{target}}` = `linux`/`windows`/`darwin`, `{{arch}}` = `x86_64`/`i686`/`aarch64`/`armv7`,
`{{current_version}}` = installed app version. `createUpdaterArtifacts: true` is v2 mode; on
Windows it produces **both MSI and NSIS** installers, each with its own `.sig` file. (Use
`"v1Compatible"` only when migrating an existing v1 install base — it zips the installers instead.)

**Signing (mandatory — cannot be disabled):**
```bash
tauri signer generate -w ~/.tauri/myapp.key
```
Public key content → `pubkey` in `tauri.conf.json`. Private key is supplied at **build time** via
env var, never committed:
- macOS/Linux: `export TAURI_SIGNING_PRIVATE_KEY="..."` (+ optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
- Windows PowerShell: `$env:TAURI_SIGNING_PRIVATE_KEY="..."`
Losing the private key means you can never publish an update the existing install base will accept.

**GitHub Releases as the update source — static JSON (`latest.json`) format:**
```json
{
  "version": "1.0.0",
  "notes": "Release notes",
  "pub_date": "2024-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<contents of the .sig file>", "url": "<asset download URL>" },
    "linux-x86_64":   { "signature": "...", "url": "..." },
    "darwin-x86_64":  { "signature": "...", "url": "..." }
  }
}
```
Platform keys are `OS-ARCH`. Host this JSON as a GitHub Release asset (commonly named
`latest.json`) and point one `endpoints` URL straight at its raw asset URL — Tauri validates the
**entire** file before reading `version`, so every platform entry must be well-formed even if only
one platform is being shipped right now.

**Check-and-install on launch (Rust, spawned from `setup()`):**
```rust
use tauri_plugin_updater::UpdaterExt;

tauri::Builder::default()
  .setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
      if let Ok(Some(update)) = app_updater_check(&handle).await {
        let mut downloaded = 0;
        let _ = update.download_and_install(
          |chunk_length, _content_length| { downloaded += chunk_length; },
          || { /* download finished */ },
        ).await;
        handle.restart();
      }
    });
    Ok(())
  })

async fn app_updater_check(app: &tauri::AppHandle) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    app.updater()?.check().await
}
```
JS equivalent:
```javascript
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
const update = await check();
if (update) {
  await update.downloadAndInstall((event) => { /* Started/Progress/Finished */ });
  await relaunch();
}
```

**Permissions:** `updater:default` (bundles `allow-check`, `allow-download`, `allow-install`,
`allow-download-and-install`) in the relevant `capabilities/*.json`.

**Windows-specific behavior (official page, load-bearing quote):** "On Windows the application is
automatically exited when the install step is executed due to a limitation of Windows
installers" — so `app.restart()`/`relaunch()` after `download_and_install()` is effectively
racing/redundant with that auto-exit on Windows; use `on_before_exit()` if cleanup must run first.
Three `installMode` values for the Windows install step: `passive` (default, progress bar, no
interaction), `basicUi` (user must click through), `quiet` (silent, but requires admin/system-wide
install).

**Does user data/localStorage survive an update? — flagged gap, not stated in official docs.** The
updater plugin page does **not** explicitly confirm this either way (confirmed absent after a full
verbatim read of the page). What the docs do confirm: the update artifact is a normal MSI/NSIS
installer performing an in-place upgrade install of the program files. Per general Windows
installer and WebView2 architecture (not a Tauri-specific citation): app config
(`app_config_dir`/`app_data_dir`, typically under `%APPDATA%\<identifier>` or
`%LOCALAPPDATA%\<identifier>`) and the WebView2 user-data folder (where `localStorage`/IndexedDB
live) are **separate from the install directory** an MSI/NSIS upgrade replaces, so they are
expected to survive — but this is an inference, not a documented Tauri guarantee. Recommend
verifying empirically (install v1, write a setting, run an update, confirm the setting is intact)
before relying on it, and re-run docs-researcher if the fork moves away from NSIS/MSI defaults.

Source: https://v2.tauri.app/plugin/updater/ (read 2026-07-25, fetched verbatim in full).

### Tauri v2 — moving a window from its own webview (verified 2026-07-28)

Verified against Tauri 2.11.5 / WebView2 on Windows 11 by building it and driving the
installed app, not read from docs.

**Permission.** `getCurrentWindow().startDragging()` needs exactly
`core:window:allow-start-dragging` in that window's capability. It does not need
`core:window:default`, `allow-set-position`, or `allow-outer-size`, so a display-only
overlay can be allowed to move itself and nothing else.

**It swallows the pointer.** `startDragging` calls the Windows modal move loop
(`ReleaseCapture` + `WM_NCLBUTTONDOWN`/`HTCAPTION`). From that moment the webview document
receives no further pointer events for the gesture — no `pointermove`, no `pointerup`, no
`click`. Two consequences:

- Calling it on `pointerdown` silently deletes any click gesture on the same element. To
  keep both, watch the press and only call `startDragging` once it has travelled a few
  pixels; treat anything shorter as a click.
- A drag cannot be ended by a pointer event. Bound it by the `tauri://move` reports
  instead: they stream while the user drags and stop when they let go, so hold the drag
  open for a few hundred ms past the last one.

**A non-focusable window still drags.** `.focusable(false)` (`WS_EX_NOACTIVATE`) does not
block it.

**`tauri://move` fires for programmatic moves too.** `Window.onMoved` cannot distinguish
the user dragging from another window's `setPosition`. Do not try to tell them apart by
comparing coordinates against the last position you commanded: if the window is also being
resized and repositioned on a timer or an event stream, a report can arrive after a newer
position was commanded, fail the comparison, and be misread as a drag. Filter on the side
that called `startDragging` — that side knows for certain.

**Listening to `tauri://move` needs only `core:event:allow-listen`.** `Window.onMoved`
routes through the ordinary event listener with a window target; there is no separate
permission for it. Its payload is a physical position.

**`core:window:default` already grants the monitor getters** — `allow-current-monitor`,
`allow-primary-monitor`, `allow-available-monitors`, `allow-scale-factor` — so a surface
holding `core:default` can enumerate monitors with no extra grant.

### Chromium fake media flags — the looping gotcha (verified 2026-07-28)

`--use-file-for-fake-audio-capture=<wav>` **loops the file forever**. A speech clip
therefore never goes silent, so anything that waits on silence (a VAD idle timeout, an
end-of-speech timer) will never fire under it. Generate a silent WAV — 44-byte header plus
zeroed PCM — and point the flag at that to test those paths.

### Svelte 5 — `$state` proxies break identity checks (verified 2026-07-28)

`$state` **deep-proxies** plain objects and arrays assigned to it. A value read back out of
a `$state` variable is the proxy, not the object that was stored, so:

```ts
let outcome = $state<Outcome>({ kind: 'none' });
const held = { kind: 'failed' } as const;
outcome = held;
outcome === held;   // false — `outcome` is a proxy of `held`
```

This bites hardest in "retire this after N ms unless something newer replaced it" guards,
which look correct, typecheck, and silently never fire. Use a generation counter (or compare
a discriminant field) instead of identity.

Not affected: values that never pass through `$state`, and `$derived`, which returns the
computed value rather than a proxy — a module-level `let latest = derivedValue` can still be
compared by identity against the same object.

### Biome in this monorepo (verified 2026-07-28)

`lint:check` is what CI gates, and it passes on code that `biome check` rejects: `check`
additionally runs the formatter and the `assist/source/organizeImports` rule. An autofix
workflow runs the fuller command afterwards and commits the rewrite, so run
`bunx --bun biome check --write <the files you changed>` before committing to avoid a bot
commit rewriting every line.

`**/*.svelte` and `**/*.md` are excluded from Biome by the root `biome.jsonc`; TOML and Rust
are not handled at all.

Beware a false positive on Windows: `biome check` reads the **working copy**, and with
`core.autocrlf=true` Git checks files out with CRLF while storing LF. Biome then reports
every such file as needing reformatting even though the committed blob is already correct.
`git ls-files --eol` is the authority — `i/lf` means the commit is fine. Do not "fix"
files you did not otherwise change; you would only be rewriting your own working copy.

### Diagnosing bad "Polish" output — read the raw transcript first (2026-07-28)

Whispering stores both the raw transcript and the polished text on every recording row
(`transcript` and `polishedTranscript`), and the row's "Original" button toggles between
them. When output is wrong, that toggle decides in one step whether the transcription
model or the AI prompt is at fault — no guessing, no re-recording.

Confirmed useful: a report that "cool cool cool" came out as "Cool" looked like Whisper
collapsing repeats (which it is genuinely known for). The raw transcript read
"Cool, cool, cool." — the transcription was perfect and the Polish prompt was deleting
the words. Investigating Whisper first would have been wasted effort.

`scratchpad/raw-vs-polished.js` does it over CDP: for each row, read the field, click
"Original", read it again, click back.

Two prompt lessons from the same investigation, both about a model's idea of "cleaning up":

- **A repeated word reads as a stutter.** Any instruction resembling "drop the retracted
  words when the speaker corrects themselves" licenses deleting "no no no" and
  "cool cool cool" entirely. Scope self-correction to a restatement in *different* words
  and say explicitly that repeating the same word is not one.
- **"Fix grammar" licenses completing sentences.** The fragment "very very very tired"
  came back as "I am very very very tired." If verbatim fidelity matters, say that fixing
  grammar means punctuation and capitalisation only, and that a fragment stays a fragment.

Both rules have to live in the part of the prompt that outranks the user's own directive;
a user directive saying "never eat up words" did not survive an invariant block that said
otherwise.

### Windows 11 — getting a tray icon out of the overflow flyout (verified 2026-08-02)

Windows 11 files **every** newly registered notification icon behind the `^` chevron and
offers no API to opt out. The only switch is Settings → Personalization → Taskbar →
"Other system tray icons", and what it writes is:

```
HKCU\Control Panel\NotifyIconSettings\<hash>\IsPromoted = 1   (REG_DWORD)
```

Each subkey carries `ExecutablePath`, `UID`, `InitialTooltip` and an `IconSnapshot`.
Explorer reads `IsPromoted` **live** — setting it moved Whispering's microphone icon out of
the flyout and next to the battery with no explorer restart and no relaunch. Verified by
screenshotting the notification area before and after.

Three things to know before automating it:

- **The record does not exist until Explorer has published the icon**, which on a fresh
  install is a second or two after `TrayIconBuilder::build`. Poll for it rather than
  reading once at startup and giving up (`shell.rs::promote_tray_icon_once`, 20 × 500 ms).
- **`ExecutablePath` is not always a plain path.** Explorer rewrites paths under a known
  folder as its GUID (`{6D809377-6AF0-444B-8957-A3773F02200E}\App\app.exe` for Program
  Files), so a whole-string comparison silently never matches a machine-wide install.
  Compare the trailing directory + file name as well.
- **It is the user's preference.** Do it once, behind a marker, or you override someone who
  deliberately hid the icon on every launch.

`winreg` is already a dependency on the Windows target.

### Tauri v2 — minimize is not a close (verified 2026-08-02)

`WindowEvent::CloseRequested` fires only for the X button. Minimizing keeps
`WS_EX_APPWINDOW` and its taskbar button, so a "closes to tray" app still eats taskbar space
the moment the user hits `–` instead. Intercept it separately:

```rust
WindowEvent::Resized(_) => {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
        let _ = window.hide();
    }
}
```

`unminimize()` **before** `hide()`: a window that is hidden *and* minimized comes back
minimized, so restoring it from the tray looks like the tray icon did nothing.

Confirm with Win32 rather than by eye — `GetWindowLongPtr(GWL_STYLE)` must lose `WS_VISIBLE`
(0x10000000) and never hold `WS_MINIMIZE` (0x20000000), and the taskbar button must be gone
from a screenshot of the strip.

### Windows topmost windows are ordered by activation (2026-08-02)

`always_on_top` is not "stays in front". Windows keeps one topmost band and orders windows
*within* it by activation, and the overlay is `focusable(false)` / `WS_EX_NOACTIVATE`, so it
never activates and never rises. Any other always-on-top window raised later in the session
sits above it for good. Re-issue `setAlwaysOnTop(true)` whenever the overlay is shown; it is
a `SetWindowPos(HWND_TOPMOST)` that puts it back at the front of the band.

### A window cannot be dragged from its own webview without pointer capture (2026-08-02)

The press has to be followed until it has travelled far enough to be a drag rather than a
click (see the `startDragging` entry above). But the overlay window is barely bigger than the
element being pressed — a vertical bar is 20 logical px wide — so a quick flick leaves the
window between two pointer samples. Those moves go to whatever window is now under the
cursor, the threshold is never crossed, `startDragging` is never called, and the bar simply
refuses to move. Reproduced reliably on the 20px vertical handle and not at all on the 96px
horizontal one.

`setPointerCapture` on `pointerdown` fixes it, with two rules:

- **Release it before calling `startDragging`.** From that call on the document receives no
  pointer events at all, so a capture held across it is never released by a `pointerup` that
  never arrives.
- **Nested action buttons must `stopPropagation` on `pointerdown`.** A captured pointer
  retargets the compatibility `click` to the capturing element, so capturing on the pill body
  from a press that landed on Stop would break Stop.

### This app's Tauri IPC cannot be monkey-patched from the console (2026-08-02)

`window.__TAURI_INTERNALS__.invoke`, `.postMessage`, `.ipc`, `.runCallback` and `.callbacks`
are all defined `writable: false, configurable: false`. Assigning over them fails silently —
the assignment appears to work (new own properties like `__origInvoke` stick) while every
real call still goes to the original. Check with `Object.getOwnPropertyDescriptor` before
concluding an injected fault "did not reproduce".

To fault-inject a window command anyway, **use the ACL**: drop the permission from
`capabilities/trusted-whispering-native-production.json`, `cargo clean -p epicenter --release`,
and build. The command then rejects with `Command plugin:window|<name> not allowed by ACL` on
every call — a real, repeatable failure at exactly the layer under test. That is how the
"the bar sometimes never appears" fix was proven: with `set_position` denied, the bar still
appeared (in the wrong place), and the log named the failing step.

## Mistakes ledger

> Repo-specific traps, one bullet each: rule first, then what happened, then the fix.
> Entries reaching (seen 2x) get promoted to a one-line rule in this project's CLAUDE.md.

- **2026-08 · Fault-injecting a window command via console monkey-patch will silently not
  reproduce in this app.** Patching `window.__TAURI_INTERNALS__.invoke` over CDP looked like
  it worked (new own properties stuck) but every real call still hit the original, since
  `writable: false, configurable: false`; the empty fault log was misread as "the code path
  never ran." **Fix/prevention:** check `Object.getOwnPropertyDescriptor` before concluding an
  injected fault "did not reproduce"; fault-inject via the ACL instead — see "This app's Tauri
  IPC cannot be monkey-patched from the console" above for the drop-permission/clean/rebuild
  recipe. (seen 1x)

- **2026-08 · `cargo` commands for this app run from `apps/epicenter/src-tauri`, not from
  `apps/epicenter`.** Ran `cargo clean -p epicenter --release` in `apps/epicenter`, which has no
  Cargo.toml; it errored and was nearly treated as a completed clean (i.e. as if the ACL had
  been rebaked before rebuilding). **Fix/prevention:** `cd` into `src-tauri` for cargo commands
  in this repo, and check the exit status of a clean/build before assuming it took effect. (seen 1x)
