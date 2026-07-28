import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	availableMonitors,
	currentMonitor,
	type Monitor,
	PhysicalPosition,
	PhysicalSize,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { once } from 'wellcrafted/function';
import { createLogger } from 'wellcrafted/logger';
import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	type RecordingOverlayView,
	recordingOverlayReady,
	recordingOverlayStatus,
} from '$lib/recording-overlay/events';
import {
	anchorProbePoint,
	type MonitorBounds,
	monitorContains,
	type OverlaySize,
	overlayAnchorFrom,
	overlayIsVisible,
	overlayPosition,
	overlaySize,
	type Point,
	physicalSizeOn,
} from '$lib/recording-overlay/geometry';
import { deviceConfig } from '$lib/state/device-config.svelte';

const log = createLogger('whispering/recording-overlay');

// How far two positions may sit apart and still be the same place. Rounding
// between logical and physical pixels can shift a corner by one; a real drag
// never ends this close to where the window already was.
const POSITION_TOLERANCE_PX = 2;
// How many recently commanded positions to remember when deciding whether a
// reported move is our own doing. It has to be a set, not a single value: a live
// session resizes and repositions the overlay repeatedly, so an echo routinely
// arrives after a newer position has been commanded. One value was the original
// bug — the mismatched echo was recorded as a drag and the remembered spot crept
// toward the corner. Eight covers far more reordering than the queue can produce.
const COMMANDED_HISTORY = 8;
// How long to keep deferring window geometry after the overlay last reported a
// drag in flight, before assuming the drag is over and catching up. Longer than
// the overlay's own settle window, so the two cannot disagree about who is
// waiting for whom.
const DRAG_DEFER_MS = 2_000;
// The anchor lands in localStorage, and a drag reports a move per mouse frame.
// Writing on each one puts a synchronous stringify-and-store on the same thread
// as the recorder; the last write is the only one that matters.
const ANCHOR_WRITE_DEBOUNCE_MS = 250;

let latestView: RecordingOverlayView = { status: null, idleHandle: false };
let queue: Promise<void> = Promise.resolve();

/** Where we believe the window is now, in physical pixels. */
let currentPosition: Point | null = null;
/** Recent positions this module commanded, newest last. */
const commandedPositions: Point[] = [];
/** The logical size last applied, so a grow can be told from a shrink. */
let lastAppliedSize: OverlaySize | null = null;
/** The physical size last applied, to skip no-op resizes. */
let lastAppliedPhysicalSize: OverlaySize | null = null;

const samePoint = (a: Point, b: Point): boolean =>
	Math.abs(a.x - b.x) <= POSITION_TOLERANCE_PX &&
	Math.abs(a.y - b.y) <= POSITION_TOLERANCE_PX;

function rememberCommanded(position: Point): void {
	commandedPositions.push(position);
	if (commandedPositions.length > COMMANDED_HISTORY) commandedPositions.shift();
	currentPosition = position;
}

const isOurOwnMove = (position: Point): boolean =>
	commandedPositions.some((commanded) => samePoint(commanded, position));

const boundsOf = (monitor: Monitor): MonitorBounds => ({
	x: monitor.position.x,
	y: monitor.position.y,
	width: monitor.size.width,
	height: monitor.size.height,
	scaleFactor: monitor.scaleFactor,
});

// ── Drag deferral ────────────────────────────────────────────────────────────
// While the user drags, the OS move loop owns the window. Resizing or moving it
// then yanks it out from under the cursor — and a live VAD session will try to,
// because the transcript's idle timer folds the card mid-drag. So geometry is
// held back and applied once the drag settles. This only ever delays a resize;
// the remembered position does not depend on it.

let dragDeferTimer: ReturnType<typeof setTimeout> | undefined;
let geometryDeferred = false;

const isDragInFlight = (): boolean => dragDeferTimer !== undefined;

function noteDragInFlight(): void {
	clearTimeout(dragDeferTimer);
	dragDeferTimer = setTimeout(() => {
		dragDeferTimer = undefined;
		if (!geometryDeferred) return;
		geometryDeferred = false;
		// Catch up on whatever the window should look like now.
		synchronizeRecordingOverlayWindow(latestView);
	}, DRAG_DEFER_MS);
}

// ── Anchor persistence ───────────────────────────────────────────────────────

let anchorWriteTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAnchor: Point | null = null;

function persistAnchorSoon(anchor: Point): void {
	pendingAnchor = anchor;
	if (anchorWriteTimer !== undefined) return;
	anchorWriteTimer = setTimeout(() => {
		anchorWriteTimer = undefined;
		if (pendingAnchor) deviceConfig.set('overlay.anchor', pendingAnchor);
		pendingAnchor = null;
	}, ANCHOR_WRITE_DEBOUNCE_MS);
}

/** The anchor including a write that has not been flushed yet. */
const effectiveAnchor = (): Point | null =>
	pendingAnchor ?? deviceConfig.get('overlay.anchor');

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * The monitor a remembered anchor belongs to.
 *
 * Enumerating is worth it because `currentMonitor()` answers for where the
 * overlay *is*, which at startup is wherever it was created — not necessarily
 * the monitor the user dragged it to. Clamping a second-monitor anchor against
 * the primary monitor's bounds would quietly haul the overlay back to screen
 * one on every launch.
 */
async function monitorForAnchor(anchor: Point): Promise<Monitor | null> {
	const monitors = await availableMonitors().catch(() => [] as Monitor[]);
	const probe = anchorProbePoint(anchor);
	const containing = monitors.find((monitor) =>
		monitorContains(boundsOf(monitor), probe),
	);
	// The anchor's monitor is gone (unplugged, or resized under it): fall through
	// to wherever the overlay currently is and let the clamp pull it on-screen.
	return containing ?? (await currentMonitor()) ?? (await primaryMonitor());
}

type Placement = { physicalSize: OverlaySize; position: Point };

async function computePlacement(size: OverlaySize): Promise<Placement | null> {
	const anchor = effectiveAnchor();
	const monitor = anchor
		? await monitorForAnchor(anchor)
		: ((await currentMonitor()) ?? (await primaryMonitor()));
	if (!monitor) return null;

	const bounds = boundsOf(monitor);
	return {
		// Both derived from the same monitor, so one scale factor governs the size
		// and the position. Sizing logically and placing physically puts them out
		// of step on a mixed-DPI desktop.
		physicalSize: physicalSizeOn(bounds, size),
		position: overlayPosition({ anchor, monitor: bounds, size }),
	};
}

/**
 * Fit the window to `size` and put it where the anchor says, skipping whatever
 * is already true and deferring everything while a drag is in flight.
 */
async function applyGeometry(
	overlay: WebviewWindow,
	size: OverlaySize,
): Promise<void> {
	if (isDragInFlight()) {
		geometryDeferred = true;
		return;
	}

	const placement = await computePlacement(size);
	if (!placement) return;

	if (
		!lastAppliedPhysicalSize ||
		lastAppliedPhysicalSize.width !== placement.physicalSize.width ||
		lastAppliedPhysicalSize.height !== placement.physicalSize.height
	) {
		await overlay.setSize(
			new PhysicalSize(
				placement.physicalSize.width,
				placement.physicalSize.height,
			),
		);
		lastAppliedPhysicalSize = placement.physicalSize;
	}
	lastAppliedSize = size;

	if (!currentPosition || !samePoint(currentPosition, placement.position)) {
		rememberCommanded(placement.position);
		await overlay.setPosition(
			new PhysicalPosition(placement.position.x, placement.position.y),
		);
	}
}

/**
 * Record where the overlay moved to.
 *
 * Called for every move the window reports, ours and the user's alike. A move
 * matching a position we recently commanded is our own; anything else is the
 * user dragging, and becomes the remembered spot.
 */
export function recordOverlayMove(move: {
	x: number;
	y: number;
	width: number;
	height: number;
	dragging: boolean;
}): void {
	if (move.dragging) noteDragInFlight();
	currentPosition = { x: move.x, y: move.y };
	if (isOurOwnMove(move)) return;
	persistAnchorSoon(overlayAnchorFrom(move));
}

/**
 * Forget the remembered spot and send the overlay back to the bottom-right
 * corner. The escape hatch for an overlay dragged onto a monitor that no longer
 * exists, or simply somewhere the user regrets.
 */
export function resetOverlayPosition(): void {
	clearTimeout(anchorWriteTimer);
	anchorWriteTimer = undefined;
	pendingAnchor = null;
	deviceConfig.set('overlay.anchor', null);
	currentPosition = null;
	commandedPositions.length = 0;
	synchronizeRecordingOverlayWindow(latestView);
}

/** Keep the ready listener live before a newly created overlay can emit. */
const ensureReadyListener = once(
	(): Promise<void> =>
		recordingOverlayReady
			.listen(() => {
				void recordingOverlayStatus.emit(latestView);
			})
			.then(() => undefined),
);

/**
 * The overlay window, created by Rust at startup and looked up by label.
 *
 * This never creates the webview itself, and that is load-bearing rather than a
 * style choice: a webview built from JavaScript receives no initialization
 * script, and the Whispering SPA's `index.html` blocks its module graph on a
 * global that script defines. A JS-created overlay therefore never mounts
 * SvelteKit and renders as a blank white rectangle. Rust owns creation so the
 * bootstrap can't be skipped; a missing window means that creation failed, which
 * is worth a warning and no overlay rather than a white box on the user's screen.
 */
async function getOverlayWindow(): Promise<WebviewWindow | null> {
	await ensureReadyListener();
	const overlay = await WebviewWindow.getByLabel(
		RECORDING_OVERLAY_WINDOW_LABEL,
	);
	if (!overlay) {
		log.warn(
			new Error(
				`No "${RECORDING_OVERLAY_WINDOW_LABEL}" window: the native overlay was not created at startup.`,
			),
		);
	}
	return overlay;
}

async function applyOverlayView(view: RecordingOverlayView) {
	const isSuperseded = () => view !== latestView;
	if (isSuperseded()) return;

	const overlay = await getOverlayWindow();
	if (!overlay || isSuperseded()) return;

	if (!overlayIsVisible(view)) {
		await recordingOverlayStatus.emit(view);
		await overlay.hide();
		return;
	}

	const size = overlaySize(view);
	// Grow the window before telling the overlay to draw into it, and shrink it
	// after. Either way the window is never smaller than what it contains, so
	// nothing is clipped for the frame between the two IPC calls — which is
	// every dictation start, since the handle is a quarter of the pill's width.
	const growing =
		!lastAppliedSize ||
		size.width > lastAppliedSize.width ||
		size.height > lastAppliedSize.height;

	if (growing) await applyGeometry(overlay, size);
	if (isSuperseded()) return;

	await recordingOverlayStatus.emit(view);
	if (isSuperseded()) return;

	if (!growing) await applyGeometry(overlay, size);
	if (isSuperseded()) return;

	await overlay.show();
}

/** Synchronize the native overlay without letting cosmetic failures stop capture. */
export function synchronizeRecordingOverlayWindow(
	view: RecordingOverlayView,
): void {
	latestView = view;
	queue = queue
		.then(() => applyOverlayView(view))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}
