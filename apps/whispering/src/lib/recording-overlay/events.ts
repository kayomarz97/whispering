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
	OverlayEdge,
	RecordingPillAction,
	RecordingPillStatus,
} from '$lib/recording-pill/model';

/** Stable Tauri label for the secondary recording pill webview. */
export const RECORDING_OVERLAY_WINDOW_LABEL = 'recording-overlay';

/**
 * Everything the overlay window needs to draw itself.
 *
 * `status` is `null` between dictations. That used to mean "hide the window",
 * and now means "draw the resting handle" when `idleHandle` is on: the overlay
 * stays on screen as a small line the user can click (or drag) instead of
 * vanishing, so starting a dictation never requires finding the app first. The
 * two travel together in one message because the window is sized from both, and
 * a size derived from two events that can arrive out of order is a window that
 * flickers at the wrong size.
 */
export type RecordingOverlayView = {
	status: RecordingPillStatus | null;
	/** Rest as a small handle rather than disappearing between dictations. */
	idleHandle: boolean;
	/**
	 * Which screen edge the overlay is docked against, so the pill can lay
	 * itself out along it — horizontal on the top and bottom, vertical on the
	 * left and right.
	 *
	 * It travels with the status rather than on its own channel because the
	 * window is sized from the edge as well as the status, and geometry derived
	 * from two events that can arrive out of order is a window that draws its
	 * contents sideways inside the wrong rectangle for a frame.
	 */
	edge: OverlayEdge;
};

/** main -> overlay: what the overlay window should display. */
export const recordingOverlayStatus = defineWindowEvent<RecordingOverlayView>(
	'recording-overlay:status',
);

/** overlay -> main: the user invoked a recording pill control. */
export const recordingOverlayAction = defineWindowEvent<RecordingPillAction>(
	'recording-overlay:action',
);

/**
 * overlay -> main: the overlay window moved, in PHYSICAL pixels (the units
 * `tauri://move` reports).
 *
 * Every move is forwarded, including the main window's own `setPosition`
 * echoing back, and the main window separates them by matching against the
 * positions it has recently commanded. Matching against a *set* rather than a
 * single last value is the whole point: a live session resizes and repositions
 * the overlay repeatedly, so an echo routinely arrives after a newer position
 * has already been commanded, and a one-value comparison misreads it as a drag.
 *
 * `dragging` is the overlay's own account of whether a drag is in flight,
 * derived from having called `startDragging` and from moves still arriving. It
 * is a hint, never the correctness mechanism: it tells the main window to hold
 * off resizing the window out from under the OS move loop, so getting it wrong
 * costs a visual jolt rather than a wrong remembered position. It cannot be the
 * mechanism, because the move loop reports nothing while the user holds still —
 * a pause mid-drag is indistinguishable from letting go.
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
	/** The overlay believes a user drag is in flight. A hint; see above. */
	dragging: boolean;
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
