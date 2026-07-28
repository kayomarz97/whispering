/**
 * Where the recording overlay window goes and how big it is.
 *
 * Pure arithmetic, deliberately separated from the Tauri window manager that
 * applies it: the manager is all `await` and platform objects, while this is the
 * part that can actually be wrong. Sizing that does not match what the pill
 * draws leaves a transparent window covering — and swallowing clicks over —
 * screen the user can see through but not touch, which is exactly the failure
 * this module exists to prevent.
 */
import type { RecordingOverlayView } from '$lib/recording-overlay/events';

/**
 * Logical sizes, mirroring what `RecordingPill` renders. The resting width is
 * the pill's max width (the cap in `RecordingPill`); the transparent window
 * centers narrower states inside it.
 */
export const OVERLAY_WIDTH = 224;
export const OVERLAY_HEIGHT = 40;
/**
 * A live transcript renders as a card stacked above the pill, so the window
 * grows to fit it: the card's own width plus the pill's horizontal breathing
 * room, and the card's max height plus the pill and the gap between them.
 */
export const OVERLAY_LIVE_WIDTH = 360;
export const OVERLAY_LIVE_HEIGHT = 168;
/**
 * Folded away, the card becomes a chevron chip: the pill's height plus the
 * chip's 24px and the 8px column gap between them.
 */
export const OVERLAY_COLLAPSED_HEIGHT = 72;
/**
 * Resting between dictations: a small handle the user can click to start, and
 * grab to move. Wide enough to hit without aiming and short enough to read as a
 * line rather than a window — this sits on screen all the time, so anything
 * bigger would be clutter, and anything thinner would be a click target nobody
 * can hit.
 */
export const OVERLAY_HANDLE_WIDTH = 96;
export const OVERLAY_HANDLE_HEIGHT = 20;
/**
 * Default corner placement (bottom-right, beside the Windows notification area
 * / tray), used until the user drags the overlay somewhere else. The bottom
 * margin clears the taskbar, since a monitor reports its full height rather
 * than the taskbar-excluded work area.
 */
export const OVERLAY_BOTTOM_MARGIN = 72;
export const OVERLAY_RIGHT_MARGIN = 24;

export type OverlaySize = { width: number; height: number };
export type Point = { x: number; y: number };

/**
 * A monitor in physical pixels, plus the scale factor that converts the logical
 * sizes above into the same units.
 */
export type MonitorBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
	scaleFactor: number;
};

/**
 * The window size for what the pill is actually rendering right now.
 *
 * This tracks the render conditions in `RecordingPill`, not the
 * live-transcription setting: the transcript card only exists while a VAD
 * capture has text to show, and it shrinks to a chip when folded. Sizing off
 * the setting alone left a manual recording — which never draws a card —
 * floating inside a window four times taller than its pill.
 */
export function overlaySize(view: RecordingOverlayView): OverlaySize {
	const { status } = view;
	// Between dictations the window shrinks to the resting handle. The size is
	// reported regardless of whether the handle is switched on — a hidden window
	// has no size worth arguing about, and answering unconditionally keeps this a
	// total function of the view rather than one with a hole in it.
	if (!status) {
		return {
			width: OVERLAY_HANDLE_WIDTH,
			height: OVERLAY_HANDLE_HEIGHT,
		};
	}
	if (
		status.phase === 'recording' &&
		status.trigger === 'vad' &&
		status.liveTranscript.length > 0
	) {
		return status.transcriptCollapsed
			? { width: OVERLAY_WIDTH, height: OVERLAY_COLLAPSED_HEIGHT }
			: { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT };
	}
	return { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
}

/**
 * Whether the overlay window should be on screen at all.
 *
 * A dictation always shows it. With no dictation it stays up only as the
 * resting handle, which is what makes "press the shortcut, or click the line"
 * possible without the app window: the overlay outlives the main window being
 * closed to the tray, so the handle is the app's whole surface until the next
 * dictation.
 */
export function overlayIsVisible(view: RecordingOverlayView): boolean {
	return view.status !== null || view.idleHandle;
}

/**
 * The point the overlay is remembered by: the bottom edge and horizontal centre
 * of where it was dropped, in physical pixels.
 *
 * Not the top-left corner, because the window resizes underneath the user — a
 * transcript card appears, folds, and reappears. Anchoring the bottom centre is
 * what keeps the pill itself sitting still while the card grows above it; a
 * top-left anchor would slide the pill down the screen every time text arrived.
 */
export function overlayAnchorFrom(placement: {
	x: number;
	y: number;
	width: number;
	height: number;
}): Point {
	return {
		x: placement.x + Math.round(placement.width / 2),
		y: placement.y + placement.height,
	};
}

/**
 * A point that is genuinely inside a window anchored at `anchor`, for asking
 * which monitor it is on.
 *
 * The anchor is the window's bottom edge, which is one row *past* the last row
 * the window occupies — so an overlay dropped flush with a monitor's bottom
 * produces an anchor no monitor contains. On stacked displays that point falls
 * inside the monitor *below*, and the overlay would reappear pinned to the top
 * of the wrong screen on every launch; side by side, it falls through to
 * wherever the window currently is, which at startup is the monitor it was
 * created on. Probing one row up keeps the question about the window itself.
 */
export function anchorProbePoint(anchor: Point): Point {
	return { x: anchor.x, y: anchor.y - 1 };
}

/** The physical size a logical overlay size takes on `monitor`. */
export function physicalSizeOn(
	monitor: MonitorBounds,
	size: OverlaySize,
): OverlaySize {
	return {
		width: Math.round(size.width * monitor.scaleFactor),
		height: Math.round(size.height * monitor.scaleFactor),
	};
}

// `max < min` when the window is wider or taller than the monitor: pin to the
// left/top edge rather than letting the clamp invert and shove it off the far
// side.
const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where to put a window of `size` on `monitor`, in physical pixels.
 *
 * A remembered anchor wins; otherwise the monitor's bottom-right corner. Either
 * way the result is clamped fully inside the monitor, so an anchor saved on a
 * display that has since been unplugged, rescaled, or resized cannot strand the
 * overlay somewhere the user can neither see nor drag it back from.
 */
export function overlayPosition(input: {
	anchor: Point | null;
	monitor: MonitorBounds;
	/** The LOGICAL size about to be applied; converted here, once. */
	size: OverlaySize;
}): Point {
	const { anchor, monitor, size } = input;
	// Deliberately the same conversion the caller applies to the window, against
	// the same monitor. Sizing the window logically (letting Tauri convert with
	// whichever scale factor the window is currently on) while placing it with
	// the target monitor's scale factor puts the two out of step on a mixed-DPI
	// desktop, and the window settles beside its remembered centre.
	const { width, height } = physicalSizeOn(monitor, size);

	const x = anchor
		? anchor.x - Math.round(width / 2)
		: monitor.x +
			monitor.width -
			width -
			Math.round(OVERLAY_RIGHT_MARGIN * monitor.scaleFactor);
	const y = anchor
		? anchor.y - height
		: monitor.y +
			monitor.height -
			height -
			Math.round(OVERLAY_BOTTOM_MARGIN * monitor.scaleFactor);

	return {
		x: clamp(x, monitor.x, monitor.x + monitor.width - width),
		y: clamp(y, monitor.y, monitor.y + monitor.height - height),
	};
}

/** Whether `point` falls inside `monitor`'s physical bounds. */
export function monitorContains(monitor: MonitorBounds, point: Point): boolean {
	return (
		point.x >= monitor.x &&
		point.x < monitor.x + monitor.width &&
		point.y >= monitor.y &&
		point.y < monitor.y + monitor.height
	);
}
