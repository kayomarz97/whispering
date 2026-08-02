/**
 * Reserved-shortcut policy for desktop global gestures (the structured
 * `KeyBinding` that resolves to tauri-plugin-global-shortcut chords, in
 * physical-key space). Pure: no Tauri or DOM dependency.
 *
 * Desktop bindings fire system-wide, so a few rules keep a gesture from
 * shadowing something the OS or foreground app owns:
 * - A short list of common OS/app chords (reload, clipboard, undo/redo, close,
 *   quit, app switch, screenshots, system search) is refused outright.
 * - A gesture must be a registrable plugin chord (one key plus a non-Fn
 *   modifier); a bare key, an Fn hold, and a modifier-only hold are refused
 *   (ADR-0117).
 */

import {
	type BindingLike,
	isRegistrableChord,
	type Modifier,
} from './key-binding';

/**
 * `primary` stands for the platform's command modifier: Command on macOS,
 * Control on Windows/Linux. A reserved entry using it expands to both, so the
 * same table covers Cmd+R and Ctrl+R without per-platform branching.
 */
type ModifierToken = Modifier | 'primary';

type ReservedChord = {
	modifiers: ModifierToken[];
	keys: string[];
	/** What the chord does, shown to the user when their pick is refused. */
	label: string;
};

/**
 * Common chords a global gesture must not shadow. Matched as exact set equality
 * (after expanding `primary`), so a precise combo is blocked while a superset
 * the user deliberately built (Ctrl+Shift+R when only Ctrl+R is listed) is not.
 * Keys are physical-position names from the `Key` vocabulary.
 */
const RESERVED_CHORDS: ReservedChord[] = [
	// Reload
	{ modifiers: ['primary'], keys: ['keyR'], label: 'Reload' },
	{ modifiers: ['primary', 'shift'], keys: ['keyR'], label: 'Hard reload' },
	{ modifiers: [], keys: ['f5'], label: 'Reload' },
	// Clipboard
	{ modifiers: ['primary'], keys: ['keyC'], label: 'Copy' },
	{ modifiers: ['primary'], keys: ['keyV'], label: 'Paste' },
	{ modifiers: ['primary'], keys: ['keyX'], label: 'Cut' },
	// Undo / redo
	{ modifiers: ['primary'], keys: ['keyZ'], label: 'Undo' },
	{ modifiers: ['primary', 'shift'], keys: ['keyZ'], label: 'Redo' },
	{ modifiers: ['ctrl'], keys: ['keyY'], label: 'Redo' },
	// Document basics
	{ modifiers: ['primary'], keys: ['keyA'], label: 'Select all' },
	{ modifiers: ['primary'], keys: ['keyS'], label: 'Save' },
	{ modifiers: ['primary'], keys: ['keyF'], label: 'Find' },
	{ modifiers: ['primary'], keys: ['keyP'], label: 'Print' },
	// Windows, tabs, app lifecycle
	{ modifiers: ['primary'], keys: ['keyN'], label: 'New window' },
	{ modifiers: ['primary'], keys: ['keyT'], label: 'New tab' },
	{ modifiers: ['primary'], keys: ['keyW'], label: 'Close window or tab' },
	{ modifiers: ['primary'], keys: ['keyQ'], label: 'Quit application' },
	{ modifiers: ['alt'], keys: ['f4'], label: 'Close window' },
	// Application / window switching
	{ modifiers: ['primary'], keys: ['tab'], label: 'Switch application' },
	{ modifiers: ['alt'], keys: ['tab'], label: 'Switch window' },
	// System search (macOS Spotlight / input source). Literal `meta`; the
	// Windows Ctrl+Win+Space combination is a different set and is listed
	// separately below, where it is also refused.
	{ modifiers: ['meta'], keys: ['space'], label: 'System search' },
	// Screenshots
	{ modifiers: ['primary', 'shift'], keys: ['num3'], label: 'Screenshot' },
	{ modifiers: ['primary', 'shift'], keys: ['num4'], label: 'Screenshot' },
	{ modifiers: ['primary', 'shift'], keys: ['num5'], label: 'Screenshot' },
	{ modifiers: ['meta', 'shift'], keys: ['keyS'], label: 'Screenshot' },

	// ── Chords the Windows shell owns ────────────────────────────────────────
	// Windows claims these before any application sees them, so `RegisterHotKey`
	// refuses them outright ("HotKey already registered"). Registration is
	// replace-all with rollback, so one of these does not just fail to bind — it
	// fails the whole batch and leaves every other gesture as it was, which
	// reads to the user as "the app is broken" rather than "that key is taken".
	// Refusing them here turns that into a sentence naming the culprit, at the
	// moment the chord is recorded.
	//
	// Verified by probing `RegisterHotKey` on Windows 11: Ctrl+Win+D, Space, V,
	// Left and F4 all came back already-registered, while Ctrl+Win+X/Z/J/K were
	// free. This list is the observed set plus the shell gestures Microsoft
	// documents; it cannot be exhaustive, which is why a registration failure
	// still has to explain itself at runtime.
	{ modifiers: ['ctrl', 'meta'], keys: ['keyD'], label: 'New virtual desktop' },
	{
		modifiers: ['ctrl', 'meta'],
		keys: ['f4'],
		label: 'Close virtual desktop',
	},
	{
		modifiers: ['ctrl', 'meta'],
		keys: ['leftArrow'],
		label: 'Switch virtual desktop',
	},
	{
		modifiers: ['ctrl', 'meta'],
		keys: ['rightArrow'],
		label: 'Switch virtual desktop',
	},
	{
		modifiers: ['ctrl', 'meta'],
		keys: ['space'],
		label: 'Switch input method',
	},
	{ modifiers: ['ctrl', 'meta'], keys: ['keyV'], label: 'Reserved by Windows' },
	{ modifiers: ['meta'], keys: ['keyL'], label: 'Lock the computer' },
	{ modifiers: ['meta'], keys: ['keyD'], label: 'Show the desktop' },
	{ modifiers: ['meta'], keys: ['keyE'], label: 'File Explorer' },
	{ modifiers: ['meta'], keys: ['keyR'], label: 'Run' },
	{ modifiers: ['meta'], keys: ['keyS'], label: 'Windows Search' },
	{ modifiers: ['meta'], keys: ['keyI'], label: 'Windows Settings' },
	{ modifiers: ['meta'], keys: ['keyA'], label: 'Quick Settings' },
	{ modifiers: ['meta'], keys: ['keyX'], label: 'Quick Link menu' },
	{ modifiers: ['meta'], keys: ['tab'], label: 'Task view' },
	{ modifiers: ['ctrl', 'shift'], keys: ['escape'], label: 'Task Manager' },
];

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((value) => set.has(value));
}

/** Expand a reserved chord's `primary` token into concrete modifier sets. */
function expandModifiers(modifiers: ModifierToken[]): Modifier[][] {
	if (!modifiers.includes('primary')) {
		return [modifiers as Modifier[]];
	}
	const base = modifiers.filter((m): m is Modifier => m !== 'primary');
	return [
		[...base, 'meta'],
		[...base, 'ctrl'],
	];
}

function matchesReserved(binding: BindingLike, chord: ReservedChord): boolean {
	if (!sameSet(binding.keys, chord.keys)) return false;
	return expandModifiers(chord.modifiers).some((modifiers) =>
		sameSet(binding.modifiers, modifiers),
	);
}

/**
 * Validate a desktop global gesture against the reserved-shortcut policy.
 * Returns `null` when the gesture is allowed, or a human-readable reason when it
 * is refused. (Domain state, not an operation failure, so a plain `string | null`
 * rather than a `Result`.)
 *
 * An empty binding (no modifiers, no keys) is treated as "unset" and passes;
 * clearing a gesture is the caller's job, not this check's.
 */
export function validateGlobalBinding(binding: BindingLike): string | null {
	const hasNothing =
		binding.modifiers.length === 0 && binding.keys.length === 0;
	if (hasNothing) return null;

	for (const chord of RESERVED_CHORDS) {
		if (matchesReserved(binding, chord)) {
			return `That combination is reserved by the system or app (${chord.label}). Pick another.`;
		}
	}

	// A global shortcut must be a registrable plugin chord. Refuse a bare key, an
	// Fn hold, or a modifier-only hold rather than store a gesture that silently
	// never registers (ADR-0117).
	if (!isRegistrableChord(binding)) {
		if (binding.modifiers.length === 0) {
			return 'Add a modifier so the gesture cannot fire on an ordinary keypress.';
		}
		return 'Only a chord works as a global shortcut: one key with a modifier. Fn and modifier-only holds are not supported.';
	}

	return null;
}
