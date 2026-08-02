# Recording overlay

A small floating pill that appears while Whispering is capturing audio, inspired
by Handy's recording overlay. It shows that Whispering is listening and lets the
user stop or cancel without returning to the main window.

## How it works

The overlay is driven entirely from the frontend, because Whispering's recording
lifecycle already lives in the frontend (`manualRecorder` and `vadRecorder`
state modules). This is the key difference from Handy, which drives its overlay
from Rust because Handy's recording lifecycle lives in Rust. Pushing our overlay
into Rust would split the source of truth, so we keep it in the main window.

- **Window**: a separate, transparent, undecorated, always-on-top
  `recording-overlay` window, reused (shown/hidden) and positioned against
  whichever screen edge the user last dropped it on. On macOS it is a
  non-activating `NSPanel`
  created in Rust (`../../epicenter/src-tauri/src/overlay.rs`, via
  tauri-nspanel) so clicking it never activates the app or raises the main
  window; `focusable: false` alone does not prevent app activation on click. On
  Windows and Linux it is a
  `focusable: false` + `alwaysOnTop` `WebviewWindow` created from the frontend.
  The window manager finds the macOS panel by label and only creates a window
  when none exists, so both paths share one show/hide/position code path.
- **Route**: `/recording-overlay` renders the pill. It lives in its own webview,
  so it cannot read the recorder state directly.
- **Shared pill** (`src/lib/recording-pill/`): owns the platform-free status and
  action model, lifecycle projection, presentation, direct web host, and meter
  curve. `RecordingPillHost` reads `dictationLifecycle` directly and renders the
  in-page pill on web.
- **Tauri overlay** (`src/lib/recording-overlay/`): owns only the secondary-window
  event protocol and desktop mic-level transport. On desktop,
  the Tauri implementation of `#platform/recording-overlay-owner` projects the
  lifecycle, synchronizes the separate overlay window, and listens for overlay
  actions and reveal requests. The browser implementation exports no runtime
  owner because its pill is mounted directly in the app layout.
- **Protocol** (`src/lib/recording-overlay/events.ts`): binds the shared pill
  model to Tauri event channels. The main window pushes a `status` to the overlay;
  the overlay pushes `action` (stop/cancel) and a `ready` handshake back. Actions
  are routed against the live recorder state in the main window, not the overlay's
  payload, so a click that races a state change is safe.
- **Controls**: the stop and cancel buttons are filled chips (stop is red) so
  they read as buttons in the small pill, and they stop click propagation.
  Clicking the pill body anywhere else emits `main-window:reveal`, which brings
  the main Whispering window forward (show + unminimize + setFocus); it is a
  separate gesture from stop/cancel so finishing a recording never yanks the
  window up.
- **Mic levels** (`mic-level` channel): the bars reflect real loudness, not a
  loop. Both producers send a raw RMS amplitude and the receiving pill mount
  applies the shared perceptual curve + smoothing:
  - VAD: RMS computed from the frame `@ricky0123/vad-web` already hands us via
    `onFrameProcessed` (no second audio graph), delivered through the
    `#platform/recording-mic-level` seam. The browser implementation lives with
    the pill and updates the host's reactive meter; the Tauri implementation
    lives with the overlay transport and forwards the sample to its webview.
  - Manual (CPAL/Tauri): the PCM lives only in Rust, so the consumer worker
    (`../../epicenter/src-tauri/src/recorder/recorder.rs`) computes RMS and emits
    a throttled (~20 Hz) targeted
    `emit_to("recording-overlay", "mic-level", rms)`, per Tauri's guidance for
    high-frequency events. This is Handy's approach.

The single source of recorder state means no parallel recording lifecycle is
introduced: the overlay only reflects and triggers the existing operations.

## Which way round the bar lies

The bar is always parallel to the screen edge it is docked against: flat along
the top and bottom, upright down the left and right. A 224px-wide bar pinned to
the right-hand edge would have to stick out into the middle of the screen to fit
at all, which is the whole reason this exists.

- **Which edge** (`geometry.ts::edgeForRect`): the nearest monitor edge to the
  window's centre. Nearest-edge rather than a docking zone, because the overlay
  can be dropped anywhere and the question still has to have an answer. A tie
  goes to the horizontal edges, so a corner — including the shipped
  bottom-right default — keeps the horizontal shape it has always had.
- **Anchor** (`overlayAnchorFrom`): the midpoint of the window side that *faces*
  that edge. That is the generalisation of the old bottom-centre rule and it
  preserves its purpose — the bar sits still while the transcript card grows
  away from the screen edge, never over it. For `bottom` it is byte-identical to
  what the anchor always meant, so positions saved before edges existed keep
  pointing at the same place.
- **Sizes** (`overlaySize`): the bar, the resting handle and the folded chip all
  transpose. The transcript **card does not** — turned on its side it would be a
  ~120px column of running speech, about fifteen characters to a line. It keeps
  its readable width and moves to sit *beside* the vertical bar instead of above
  the horizontal one.
- **Persistence**: `overlay.edge` in device config, its own key rather than a
  field on `overlay.anchor` — widening the anchor's arktype schema would fail
  validation against every value already stored and silently reset the spot the
  user chose.
- **Turning it**: `recordOverlayMove` recomputes the edge from where a real drag
  dropped the window, and re-applies geometry once the drag settles, so the bar
  flips orientation in place. The window manager overrides the edge the main
  window read from settings with its own pending value, because a fresh drag has
  not been written back yet — one authority, or the window gets sized for a
  horizontal bar with a vertical one inside it.

## Why the bar must never fail to appear

Every window call in `window-manager.tauri.ts` is an IPC round trip that can
reject. They used to run inside one function whose rejection the queue caught and
logged, which meant a single transient failure in geometry abandoned the run
**before** it ever showed the window — and if that view was the last of the
burst, nothing retried. The dictation carried on working and the bar simply never
appeared. That was a real user report.

So: each step is individually contained (`attempt`), a geometry failure is
cosmetic and never costs the show, and `settleVisibility` runs unconditionally at
the end of every run — reading `latestView`, not the view its own run started
with, so even a superseded or half-failed run leaves the window's visibility
correct. It also re-issues `setAlwaysOnTop(true)` on the way up: Windows orders
topmost windows among themselves by activation and the overlay never activates,
so any other always-on-top window raised later in the session would otherwise sit
above it permanently.

## Dev environment note

The TanStack Query devtools were removed from the root layout entirely (the
dependency too): it blocked the view in dev and was not pulling its weight.

The app does not position the Svelte inspector. `svelte.config.js` owns only
its behavior (hold mode, always-visible toggle, `alt-x`); the toggle inherits
the plugin default `top-right`, the corner left free by the current chrome (the
sidebar on the left, the full-width BottomNav at the bottom). Do not reintroduce
CSS that offsets `#svelte-inspector-host`: earlier overrides keyed to nav
z-index broke twice when the nav changed. To move or disable it per-machine, set
an env var instead, for example
`SVELTE_INSPECTOR_OPTIONS='{"toggleButtonPos":"top-left"}'`.

The overlay route still hides `#svelte-inspector-host` in its own webview with
one co-located CSS rule, since the inspector would otherwise sit on the pill.
That is suppression, not positioning, and it stays. All of this is dev-only.

## Deliberately deferred

These are tracked here as follow-ups.

1. **Settings.** There is no `show recording overlay` toggle or top/bottom
   position setting yet. Whispering settings are workspace KV entries with their
   own schema evolution rules, which is heavier than this slice warranted, so the
   overlay is on by default in the Tauri build. Add the toggle when touching the
   settings schema is otherwise justified.
