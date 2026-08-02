/**
 * Where the recording overlay window goes, which way round it lies, and how big
 * it is.
 *
 * Pure arithmetic, deliberately separated from the Tauri window manager that
 * applies it: the manager is all `await` and platform objects, while this is the
 * part that can actually be wrong. Sizing that does not match what the pill
 * draws leaves a transparent window covering — and swallowing clicks over —
 * screen the user can see through but not touch, which is exactly the failure
 * this module exists to prevent.
 */
import type { RecordingOverlayView } from '$lib/recording-overlay/events';
import type { OverlayEdge } from '$lib/recording-pill/model';

export type { OverlayEdge };

/** Whether an edge lays the bar out along the vertical axis. */
export const isVerticalEdge = (edge: OverlayEdge): boolean =>
	edge === 'left' || edge === 'right';

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
 * The four window footprints, per orientation.
 *
 * The bar itself simply transposes — a 224x40 pill lying on its side is 40x224,
 * and the same for the resting handle and the folded chip, whose "N words"
 * label runs along the bar.
 *
 * The transcript card does NOT transpose, and that is the one deliberate
 * asymmetry here. It is a paragraph of live speech: turned on its side it would
 * be a 120px column fitting about fifteen characters to a line, which is not a
 * transcript anybody can read. So it keeps its readable shape and moves to sit
 * *beside* the vertical bar instead of above the horizontal one — 40px of bar,
 * an 8px gap, and the same 360px card block the horizontal layout uses.
 */
const VERTICAL_LIVE_WIDTH = OVERLAY_HEIGHT + 8 + OVERLAY_LIVE_WIDTH;

type SizeTable = {
	handle: OverlaySize;
	pill: OverlaySize;
	live: OverlaySize;
	collapsed: OverlaySize;
};

const HORIZONTAL_SIZES: SizeTable = {
	handle: { width: OVERLAY_HANDLE_WIDTH, height: OVERLAY_HANDLE_HEIGHT },
	pill: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
	live: { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT },
	collapsed: { width: OVERLAY_WIDTH, height: OVERLAY_COLLAPSED_HEIGHT },
};

const VERTICAL_SIZES: SizeTable = {
	handle: { width: OVERLAY_HANDLE_HEIGHT, height: OVERLAY_HANDLE_WIDTH },
	pill: { width: OVERLAY_HEIGHT, height: OVERLAY_WIDTH },
	live: { width: VERTICAL_LIVE_WIDTH, height: OVERLAY_WIDTH },
	collapsed: { width: OVERLAY_COLLAPSED_HEIGHT, height: OVERLAY_WIDTH },
};

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

/** A window's placement in physical pixels. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * The window size for what the pill is actually rendering right now, laid out
 * along `edge`.
 *
 * This tracks the render conditions in `RecordingPill`, not the
 * live-transcription setting: the transcript card only exists while a VAD
 * capture has text to show, and it shrinks to a chip when folded. Sizing off
 * the setting alone left a manual recording — which never draws a card —
 * floating inside a window four times taller than its pill.
 */
export function overlaySize(view: RecordingOverlayView): OverlaySize {
	const sizes = isVerticalEdge(view.edge) ? VERTICAL_SIZES : HORIZONTAL_SIZES;
	const { status } = view;
	// Between dictations the window shrinks to the resting handle. The size is
	// reported regardless of whether the handle is switched on — a hidden window
	// has no size worth arguing about, and answering unconditionally keeps this a
	// total function of the view rather than one with a hole in it.
	if (!status) return sizes.handle;
	if (
		status.phase === 'recording' &&
		status.trigger === 'vad' &&
		status.liveTranscript.length > 0
	) {
		return status.transcriptCollapsed ? sizes.collapsed : sizes.live;
	}
	return sizes.pill;
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
 * Which screen edge a window belongs to: the nearest one to its centre.
 *
 * Nearest-edge rather than a docking zone, because the overlay can be dropped
 * anywhere and still has to answer the question. A tie goes to the horizontal
 * edges — a window in a corner hugs both, and the horizontal bar is the shipped
 * shape, so a corner keeps behaving the way it always has.
 */
export function edgeForRect(rect: Rect, monitor: MonitorBounds): OverlayEdge {
	const centreX = rect.x + rect.width / 2;
	const centreY = rect.y + rect.height / 2;
	// Ordered so that a strict `<` leaves a tie with the horizontal edge already
	// holding the answer.
	const distances: [OverlayEdge, number][] = [
		['top', centreY - monitor.y],
		['right', monitor.x + monitor.width - centreX],
		['left', centreX - monitor.x],
	];
	let nearest: OverlayEdge = 'bottom';
	let shortest = monitor.y + monitor.height - centreY;
	for (const [edge, distance] of distances) {
		if (distance < shortest) {
			nearest = edge;
			shortest = distance;
		}
	}
	return nearest;
}

/**
 * The point the overlay is remembered by: the midpoint of the window side that
 * faces its docked edge, in physical pixels.
 *
 * Not the top-left corner, because the window resizes underneath the user — a
 * transcript card appears, folds, and reappears. Anchoring the edge-facing side
 * is what keeps the bar itself sitting still while the card grows away from the
 * screen edge; a top-left anchor would slide the bar across the screen every
 * time text arrived.
 *
 * For the bottom edge this is the bottom centre, which is what the anchor has
 * always meant — so a position saved before edges existed keeps pointing at the
 * same place.
 */
export function overlayAnchorFrom(placement: Rect, edge: OverlayEdge): Point {
	const centreX = placement.x + Math.round(placement.width / 2);
	const centreY = placement.y + Math.round(placement.height / 2);
	switch (edge) {
		case 'bottom':
			return { x: centreX, y: placement.y + placement.height };
		case 'top':
			return { x: centreX, y: placement.y };
		case 'right':
			return { x: placement.x + placement.width, y: centreY };
		case 'left':
			return { x: placement.x, y: centreY };
		default:
			edge satisfies never;
			return { x: centreX, y: centreY };
	}
}

/**
 * A point that is genuinely inside a window anchored at `anchor`, for asking
 * which monitor it is on.
 *
 * On the bottom and right edges the anchor is one pixel *past* the last row or
 * column the window occupies — so an overlay dropped flush with a monitor's
 * bottom produces an anchor no monitor contains. On stacked displays that point
 * falls inside the monitor *below*, and the overlay would reappear pinned to
 * the top of the wrong screen on every launch; side by side, it falls through
 * to wherever the window currently is, which at startup is the monitor it was
 * created on. Probing one pixel back keeps the question about the window
 * itself. The top and left anchors already sit inside the window, so they are
 * left alone.
 */
export function anchorProbePoint(anchor: Point, edge: OverlayEdge): Point {
	switch (edge) {
		case 'bottom':
			return { x: anchor.x, y: anchor.y - 1 };
		case 'right':
			return { x: anchor.x - 1, y: anchor.y };
		default:
			return { x: anchor.x, y: anchor.y };
	}
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
 * A remembered anchor wins, placed so the window's edge-facing side sits on it;
 * otherwise the monitor's bottom-right corner. Either way the result is clamped
 * fully inside the monitor, so an anchor saved on a display that has since been
 * unplugged, rescaled, or resized cannot strand the overlay somewhere the user
 * can neither see nor drag it back from.
 */
export function overlayPosition(input: {
	anchor: Point | null;
	edge: OverlayEdge;
	monitor: MonitorBounds;
	/** The LOGICAL size about to be applied; converted here, once. */
	size: OverlaySize;
}): Point {
	const { anchor, edge, monitor, size } = input;
	// Deliberately the same conversion the caller applies to the window, against
	// the same monitor. Sizing the window logically (letting Tauri convert with
	// whichever scale factor the window is currently on) while placing it with
	// the target monitor's scale factor puts the two out of step on a mixed-DPI
	// desktop, and the window settles beside its remembered centre.
	const { width, height } = physicalSizeOn(monitor, size);

	const defaultX =
		monitor.x +
		monitor.width -
		width -
		Math.round(OVERLAY_RIGHT_MARGIN * monitor.scaleFactor);
	const defaultY =
		monitor.y +
		monitor.height -
		height -
		Math.round(OVERLAY_BOTTOM_MARGIN * monitor.scaleFactor);

	let x = defaultX;
	let y = defaultY;
	if (anchor) {
		// The axis the bar runs along is centred on the anchor; the axis it is
		// docked on puts the edge-facing side exactly there.
		switch (edge) {
			case 'bottom':
				x = anchor.x - Math.round(width / 2);
				y = anchor.y - height;
				break;
			case 'top':
				x = anchor.x - Math.round(width / 2);
				y = anchor.y;
				break;
			case 'right':
				x = anchor.x - width;
				y = anchor.y - Math.round(height / 2);
				break;
			case 'left':
				x = anchor.x;
				y = anchor.y - Math.round(height / 2);
				break;
			default:
				edge satisfies never;
		}
	}

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
