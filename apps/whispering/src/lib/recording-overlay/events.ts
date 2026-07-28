/**
 * Tauri event contract for the recording overlay window. The main window pushes
 * the shared pill status into the secondary webview; the overlay sends pill
 * actions, readiness, and reveal requests back.
 *
 * Event names are durable wire values shared with the Rust recorder where
 * noted. Presentation vocabulary lives in `recording-pill/model.ts`; this
 * module only binds those payloads to transport channels.
 */
import { defineWindowEvent, defineWindowSignal } from '#platform/window-events';
import type {
	RecordingPillAction,
	RecordingPillStatus,
} from '$lib/recording-pill/model';

/** Stable Tauri label for the secondary recording pill webview. */
export const RECORDING_OVERLAY_WINDOW_LABEL = 'recording-overlay';

/** main -> overlay: what the shared recording pill should display. */
export const recordingOverlayStatus = defineWindowEvent<RecordingPillStatus>(
	'recording-overlay:status',
);

/** overlay -> main: the user invoked a recording pill control. */
export const recordingOverlayAction = defineWindowEvent<RecordingPillAction>(
	'recording-overlay:action',
);

/**
 * overlay -> main: the overlay window sits somewhere new, in PHYSICAL pixels
 * (the units `tauri://move` reports).
 *
 * The overlay forwards every move it observes; deciding which ones were the
 * user dragging — rather than the main window's own `setPosition` echoing back —
 * belongs to the main window, because it is the side that knows what position it
 * last commanded. Physical units are kept on the wire because that is what the
 * event carries; the main window converts once, against the monitor scale factor
 * it already reads, so no rounding happens twice.
 */
export const recordingOverlayMoved = defineWindowEvent<{
	x: number;
	y: number;
	/**
	 * The overlay's own physical size at the moment it moved. Sent along because
	 * the remembered spot is the window's bottom edge and horizontal centre — the
	 * one anchor that keeps the pill still while a transcript card grows above it
	 * — and deriving that from a top-left corner needs the size. Measuring it in
	 * the overlay is exact; the main window would have to reconstruct it from a
	 * logical size and a monitor scale factor.
	 */
	width: number;
	height: number;
}>('recording-overlay:moved');

/** overlay -> main: reveal the main Whispering window. */
export const revealMainWindow = defineWindowSignal('main-window:reveal');

/**
 * overlay -> main: the overlay mounted and its listener is live, so the main
 * window should re-send the latest status.
 */
export const recordingOverlayReady = defineWindowSignal(
	'recording-overlay:ready',
);

/**
 * Live mic level (main -> overlay), a raw RMS amplitude. The bare `mic-level`
 * name is shared with the Rust recorder's `MIC_LEVEL_EVENT`.
 */
export const recordingOverlayMicLevel = defineWindowEvent<number>('mic-level');
