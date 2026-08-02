import { createPersistedMap, defineEntry } from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { os } from '#platform/os';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { LOCAL_MODEL_UNLOAD_POLICIES } from '$lib/constants/local-model-unload-policy';
import type { OverlayEdge } from '$lib/recording-pill/model';
import { log, report } from '$lib/report';
import type { KeyBinding } from '$lib/utils/key-binding';

// ── Global shortcut binding shape ────────────────────────────────────────────

/**
 * Runtime shape of a stored global shortcut: the structured `KeyBinding` the
 * frontend resolves to a `tauri-plugin-global-shortcut` accelerator (physical-key
 * space). `modifiers` is strictly enumerated; `keys` is validated as strings
 * here. A binding that is not a registrable chord produces no accelerator and is
 * refused before it registers (ADR-0117), so a bad or unsupported gesture is
 * never registered.
 */
const globalBinding = type({
	modifiers: "('ctrl' | 'alt' | 'shift' | 'meta' | 'fn')[]",
	keys: 'string[]',
}).or('null');

// Default global gestures, not mnemonic app hotkeys. These are plain chords the
// `tauri-plugin-global-shortcut` backend registers with no Accessibility grant,
// the only global-shortcut backend on every platform (ADR-0117). Every default
// binding is distinct.
//
// Toggle recording is the out-of-the-box gesture: press once to start and again
// to stop. A chord is the right tool for a toggle; its press effort resists
// accidental triggers. Push-to-talk ships unbound: bind a chord for it in
// settings if you want a held key (Fn and modifier-only holds are not supported).
//
//   macOS:   Cmd + Shift + Space  = toggle,  Cmd + .          = cancel
//   Windows: Ctrl + Shift + Space = toggle,  Ctrl + Shift + . = cancel
//
// Cancel is the platform cancel chord (Cmd + . on macOS, the system cancel
// gesture since classic Mac OS; Ctrl + Shift + . elsewhere); it carries a
// modifier so it is safe to register globally. Recipe gestures ship
// unbound: opt-in only. Exported so the reset path in platform/system-shortcuts.tauri.ts
// shares this one source of truth.
const TOGGLE_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta', 'shift']
	: ['ctrl', 'shift'];

const CANCEL_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta']
	: ['ctrl', 'shift'];

export const DEFAULT_GLOBAL_BINDINGS = {
	pushToTalk: null,
	toggleManualRecording: { modifiers: TOGGLE_MODIFIERS, keys: ['space'] },
	cancelRecording: { modifiers: CANCEL_MODIFIERS, keys: ['dot'] },
	// Voice-activated capture shipped unbound, which left pause-triggered
	// dictation unreachable from outside the app: the only way in was to focus
	// the window and click a tab, which defeats the point of a dictation tool you
	// drive while working somewhere else. It takes the same toggle chord as
	// manual recording on `v` for voice, so the two live gestures read as a pair.
	// Rebindable in Settings -> Shortcuts.
	toggleVadRecording: { modifiers: TOGGLE_MODIFIERS, keys: ['keyV'] },
	openRecipePicker: null,
	runRecipeOnClipboard: null,
	// Focused-reach command (ADR-0052): its reach ceiling clamps any key to the
	// in-app store, so the router never writes this global slot. It stays here only
	// so the system backend's all-commands sync keeps one entry per command;
	// always null.
	openSettings: null,
} satisfies Record<string, KeyBinding | null>;

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * The provider API keys: the device entries that are secrets. Grouped on their
 * own so the secret set has a single source of truth. {@link SECRET_KEYS} is
 * derived from these keys, and the secrets facade reads exactly this set
 * (ADR-0074). Adding a provider key here makes it a device entry and a vault
 * secret in one line; there is no second list to keep in step.
 */
const SECRET_DEFINITIONS = {
	'providers.openai.apiKey': defineEntry(type('string'), ''),
	'providers.anthropic.apiKey': defineEntry(type('string'), ''),
	'providers.groq.apiKey': defineEntry(type('string'), ''),
	'providers.google.apiKey': defineEntry(type('string'), ''),
	'providers.deepgram.apiKey': defineEntry(type('string'), ''),
	'providers.elevenlabs.apiKey': defineEntry(type('string'), ''),
	'providers.mistral.apiKey': defineEntry(type('string'), ''),
	'providers.openrouter.apiKey': defineEntry(type('string'), ''),
	'providers.custom.apiKey': defineEntry(type('string'), ''),
};

/**
 * Device-bound configuration definitions: secrets, hardware IDs, filesystem
 * paths, and global OS shortcuts that should NEVER sync across devices.
 *
 * Each key has its own schema and default value. Stored individually in
 * localStorage under the `whispering.device.{key}` prefix.
 */
const DEVICE_DEFINITIONS = {
	// ── Provider backends ─────────────────────────────────────────────
	// One record per network backend: how this device reaches it. API keys
	// are secrets (grouped above as `SECRET_DEFINITIONS`) and never sync.
	// Empty `endpoint` means the provider's official API; Custom and Speaches
	// have no official API, so their endpoints carry real defaults.
	...SECRET_DEFINITIONS,
	'providers.openai.endpoint': defineEntry(type('string'), ''),
	'providers.groq.endpoint': defineEntry(type('string'), ''),
	'providers.custom.endpoint': defineEntry(
		type('string'),
		'http://localhost:11434/v1',
	),
	'providers.speaches.endpoint': defineEntry(
		type('string'),
		'http://localhost:8000',
	),
	/**
	 * Model installed on the Speaches server. Device-local like the rest
	 * of the record: which models are pulled depends on the machine.
	 */
	'providers.speaches.modelId': defineEntry(
		type('string'),
		'Systran/faster-distil-whisper-small.en',
	),

	// ── Recording hardware ────────────────────────────────────────────
	'recording.cpal.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineEntry(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),
	'recording.cpal.sampleRate': defineEntry(
		type("'16000' | '44100' | '48000'"),
		'16000',
	),

	// ── Local model selection ─────────────────────────────────────────
	/**
	 * The selected local model's catalog id (`"{repoId}@{revision}/{filename}"`),
	 * never a path. Rust owns the GGUF catalog and resolves the id to a
	 * shared-HF-cache path at load time (`transcription::catalog`). Device-local
	 * because the download lives on this machine's Hugging Face cache.
	 */
	'transcription.local.selectedModel': defineEntry(type('string'), ''),

	// ── Local model lifecycle (per device: memory pressure is physical) ─
	/**
	 * When to drop the resident local transcription model. Pushed to Rust
	 * on change via the `set_unload_policy` Tauri command; the Rust side
	 * owns the actual eviction (synchronous for `immediately`, idle-watcher
	 * for timed values). Device-local because the right answer depends on
	 * available RAM (a 64 GB workstation and a 16 GB laptop want different
	 * policies for the same workflow).
	 */
	'transcription.localModelUnloadPolicy': defineEntry(
		type.enumerated(...LOCAL_MODEL_UNLOAD_POLICIES),
		'after_5_minutes',
	),

	// ── Recording overlay placement ───────────────────────────────────
	/**
	 * Where the user dragged the recording overlay, in PHYSICAL desktop pixels:
	 * the window's bottom edge and horizontal centre, not its top-left corner.
	 * The overlay resizes as a live transcript appears and folds away, and the
	 * bottom-centre is the only anchor that leaves the pill itself sitting still
	 * while the card grows above it.
	 *
	 * Physical rather than logical because a multi-monitor desktop has no single
	 * logical coordinate space — each monitor carries its own scale factor, so
	 * the same logical pair means different places depending on which monitor you
	 * divide by. Physical pixels are the one frame every monitor shares.
	 *
	 * Device-bound, and emphatically so: monitor count, resolution, and layout
	 * are facts about this machine, and a spot that is perfect on a 32" desktop
	 * display is off-screen on a laptop. `null` means "never moved", which is the
	 * bottom-right default the overlay ships with.
	 */
	'overlay.anchor': defineEntry(
		type({ x: 'number', y: 'number' }).or('null'),
		null as { x: number; y: number } | null,
	),
	/**
	 * Which screen edge the overlay was dropped against, which decides whether
	 * the bar lies horizontally or vertically and which way its transcript card
	 * grows.
	 *
	 * Its own entry rather than a field on `overlay.anchor`, deliberately:
	 * widening the anchor's schema would fail validation against every value
	 * already stored and silently reset the spot the user chose. As a separate
	 * key an existing anchor keeps working untouched, and `'bottom'` — the only
	 * edge that existed before — is exactly what it used to mean.
	 *
	 * Device-bound for the same reason the anchor is: which edge is convenient
	 * is a fact about this machine's screens.
	 */
	'overlay.edge': defineEntry(
		type("'bottom' | 'top' | 'left' | 'right'"),
		'bottom' as OverlayEdge,
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	// Structured KeyBinding (physical-key space) resolved to a plugin accelerator.
	// Old accelerator-string values are not migrated: they fail this schema and
	// reset to the defaults (clean break, see the note below the singleton).
	'shortcuts.global.pushToTalk': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.pushToTalk,
	),
	'shortcuts.global.toggleManualRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleManualRecording,
	),
	'shortcuts.global.cancelRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.cancelRecording,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleVadRecording,
	),
	'shortcuts.global.openRecipePicker': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.openRecipePicker,
	),
	'shortcuts.global.runRecipeOnClipboard': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.runRecipeOnClipboard,
	),
	// Always null: `openSettings` is focused-reach, so the router never routes a
	// write here. Present only to keep one global slot per command for the system
	// backend's uniform sync (see DEFAULT_GLOBAL_BINDINGS.openSettings).
	'shortcuts.global.openSettings': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.openSettings,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

/**
 * The device entries that are secrets: provider API keys. The secrets facade
 * reads exactly this set (ADR-0074). Derived from {@link SECRET_DEFINITIONS},
 * so it stays complete by construction; there is no parallel list to maintain.
 */
export type SecretKey = keyof typeof SECRET_DEFINITIONS & string;
export const SECRET_KEYS = Object.keys(SECRET_DEFINITIONS) as SecretKey[];

// ── Singleton ────────────────────────────────────────────────────────────────

const DEVICE_CONFIG_PREFIX = 'whispering.device.';

export const deviceConfig = createPersistedMap({
	prefix: DEVICE_CONFIG_PREFIX,
	definitions: DEVICE_DEFINITIONS,
	onError: (key) => {
		log.info(`Invalid device config for "${key}", using default`);
	},
	onUpdateError: (_key, error) => {
		report.error({
			title: 'Error updating device config',
			cause: {
				name: 'DeviceConfigUpdateFailed',
				message: extractErrorMessage(error),
			},
		});
	},
});

// Nothing here is migrated from a legacy format; both prior formats take a clean
// break. Local model selections once lived under `transcription.*.modelPath` as
// filesystem paths: those keys are simply orphaned now and the
// `transcription.local.selectedModel` entry reads its default (empty). Global
// shortcuts once stored accelerator strings under
// the same key: a legacy value fails the `globalBinding` schema on read and falls
// back to the default (see `createPersistedMap`). Either way upgrading users get
// the new defaults, and we carry no parser for a format nothing writes anymore.
