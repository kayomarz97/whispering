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
	edgeForRect,
	type MonitorBounds,
	monitorContains,
	type OverlayEdge,
	type OverlaySize,
	overlayAnchorFrom,
	overlayIsVisible,
	overlayPosition,
	overlaySize,
	type Point,
	physicalSizeOn,
	type Rect,
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

let latestView: RecordingOverlayView = {
	status: null,
	idleHandle: false,
	edge: 'bottom',
};
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

// ── Failure containment ──────────────────────────────────────────────────────
// Every window call below is a Tauri IPC round trip that can reject. They used
// to run bare inside one `try`-less async function whose rejection was caught by
// the queue and logged — which meant a single transient failure anywhere in
// geometry abandoned the run BEFORE it ever showed the window, and if that view
// was the last of the burst nothing retried. The dictation carried on working
// and the bar simply never appeared, silently, for the rest of it. That is the
// "sometimes I speak and no bar comes up" report.
//
// So each step is contained: a failure is logged with the step that failed and
// the run continues to the visibility step, which is the one that must not be
// skipped. A bar in the wrong place beats no bar at all.

async function attempt<T>(
	step: string,
	run: () => Promise<T>,
): Promise<T | null> {
	try {
		return await run();
	} catch (error) {
		log.warn(
			new Error(`recording overlay: ${step} failed`, {
				cause: error instanceof Error ? error : new Error(String(error)),
			}),
		);
		return null;
	}
}

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

// ── Anchor and edge persistence ──────────────────────────────────────────────

let anchorWriteTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAnchor: Point | null = null;
let pendingEdge: OverlayEdge | null = null;

function persistPlacementSoon(anchor: Point, edge: OverlayEdge): void {
	pendingAnchor = anchor;
	pendingEdge = edge;
	if (anchorWriteTimer !== undefined) return;
	anchorWriteTimer = setTimeout(() => {
		anchorWriteTimer = undefined;
		if (pendingAnchor) deviceConfig.set('overlay.anchor', pendingAnchor);
		if (pendingEdge) deviceConfig.set('overlay.edge', pendingEdge);
		pendingAnchor = null;
		pendingEdge = null;
	}, ANCHOR_WRITE_DEBOUNCE_MS);
}

/** The anchor including a write that has not been flushed yet. */
const effectiveAnchor = (): Point | null =>
	pendingAnchor ?? deviceConfig.get('overlay.anchor');

/** The docked edge including a write that has not been flushed yet. */
const effectiveEdge = (): OverlayEdge =>
	pendingEdge ?? deviceConfig.get('overlay.edge');

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
async function monitorForAnchor(
	anchor: Point,
	edge: OverlayEdge,
): Promise<MonitorBounds | null> {
	const probe = anchorProbePoint(anchor, edge);
	const containing = knownMonitors.find((monitor) =>
		monitorContains(monitor, probe),
	);
	if (containing) return containing;
	// The anchor's monitor is gone (unplugged, or resized under it): fall through
	// to wherever the overlay currently is and let the clamp pull it on-screen.
	const fallback = (await currentMonitor()) ?? (await primaryMonitor());
	return fallback ? boundsOf(fallback) : null;
}

/** Where an overlay that has never been dragged should live. */
async function monitorForNewOverlay(): Promise<MonitorBounds | null> {
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	return monitor ? boundsOf(monitor) : (knownMonitors[0] ?? null);
}

type Placement = { physicalSize: OverlaySize; position: Point };

async function computePlacement(size: OverlaySize): Promise<Placement | null> {
	// One monitor enumeration per placement, cached for the synchronous edge test
	// a drag needs. Refreshing here is what keeps that cache from going stale
	// across a display being plugged in or rearranged.
	await refreshKnownMonitors();

	const anchor = effectiveAnchor();
	const edge = effectiveEdge();
	const bounds = anchor
		? await monitorForAnchor(anchor, edge)
		: await monitorForNewOverlay();
	if (!bounds) return null;
	return {
		// Both derived from the same monitor, so one scale factor governs the size
		// and the position. Sizing logically and placing physically puts them out
		// of step on a mixed-DPI desktop.
		physicalSize: physicalSizeOn(bounds, size),
		position: overlayPosition({ anchor, edge, monitor: bounds, size }),
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

	const placement = await attempt('compute placement', () =>
		computePlacement(size),
	);
	if (!placement) return;

	if (
		!lastAppliedPhysicalSize ||
		lastAppliedPhysicalSize.width !== placement.physicalSize.width ||
		lastAppliedPhysicalSize.height !== placement.physicalSize.height
	) {
		const applied = await attempt('resize', () =>
			overlay.setSize(
				new PhysicalSize(
					placement.physicalSize.width,
					placement.physicalSize.height,
				),
			),
		);
		// Only record it once the window agreed, or a failed resize would be
		// remembered as applied and never retried.
		if (applied !== null) lastAppliedPhysicalSize = placement.physicalSize;
	}
	lastAppliedSize = size;

	if (!currentPosition || !samePoint(currentPosition, placement.position)) {
		rememberCommanded(placement.position);
		await attempt('reposition', () =>
			overlay.setPosition(
				new PhysicalPosition(placement.position.x, placement.position.y),
			),
		);
	}
}

/**
 * Bring the window's visibility into line with the LATEST view, and put it back
 * on top of the topmost band while doing it.
 *
 * Deliberately reads `latestView` rather than the view its run started with, and
 * deliberately runs even when that run was superseded or partly failed: this is
 * the step whose omission the user sees. Everything above it is cosmetic by
 * comparison.
 *
 * The always-on-top re-assertion matters because Windows orders topmost windows
 * among themselves by activation, and the overlay never activates. Any other
 * always-on-top window raised later in the session sits above it permanently, so
 * `alwaysOnTop` set once at creation is not the same thing as being on top.
 * Re-issuing it on the way up is a `SetWindowPos(HWND_TOPMOST)` that puts the
 * bar back in front of whatever got there since.
 */
async function settleVisibility(overlay: WebviewWindow): Promise<void> {
	const wanted = overlayIsVisible(latestView);
	const actual = await attempt('read visibility', () => overlay.isVisible());

	if (!wanted) {
		if (actual !== false) await attempt('hide', () => overlay.hide());
		return;
	}

	// `actual === null` means we could not find out; showing an already-shown
	// window is a no-op, so re-issuing is the safe way to be wrong.
	if (actual !== true) await attempt('show', () => overlay.show());
	await attempt('raise', () => overlay.setAlwaysOnTop(true));
}

/**
 * Record where the overlay moved to, and which screen edge it now belongs to.
 *
 * Called for every move the window reports, ours and the user's alike. A move
 * matching a position we recently commanded is our own; anything else is the
 * user dragging, and becomes the remembered spot. A drag that crosses to a
 * different edge also turns the bar: the new edge is worked out from where the
 * window was dropped, and the window is re-laid-out once the drag settles.
 */
export function recordOverlayMove(move: Rect & { dragging: boolean }): void {
	if (move.dragging) noteDragInFlight();
	currentPosition = { x: move.x, y: move.y };
	if (isOurOwnMove(move)) return;

	const edge = edgeForDroppedRect(move) ?? effectiveEdge();
	const turned = edge !== effectiveEdge();
	persistPlacementSoon(overlayAnchorFrom(move, edge), edge);
	// Turning the bar changes its size as well as its layout, and the drag is
	// still in flight, so the resize is deferred to the settle timer. Arm it even
	// if this move never reported `dragging`, or a drop that lands on a new edge
	// with no further moves would keep the old orientation until the next
	// dictation.
	if (turned) {
		geometryDeferred = true;
		noteDragInFlight();
	}
}

/**
 * Which edge a dropped window belongs to, or `null` when no monitor claims it.
 *
 * Synchronous by necessity — this runs inside a move report, several per mouse
 * frame — so it reads the monitor list captured by the last placement rather
 * than awaiting `availableMonitors()` on every pixel of a drag.
 */
function edgeForDroppedRect(rect: Rect): OverlayEdge | null {
	const monitor =
		knownMonitors.find((bounds) =>
			monitorContains(bounds, {
				x: rect.x + Math.round(rect.width / 2),
				y: rect.y + Math.round(rect.height / 2),
			}),
		) ?? knownMonitors[0];
	return monitor ? edgeForRect(rect, monitor) : null;
}

/**
 * Monitor bounds as of the last placement, kept for the synchronous edge test
 * above. Refreshed whenever geometry is applied, which is often enough that a
 * display change cannot go unnoticed for longer than one dictation.
 */
let knownMonitors: MonitorBounds[] = [];

async function refreshKnownMonitors(): Promise<void> {
	const monitors = await availableMonitors().catch(() => [] as Monitor[]);
	if (monitors.length > 0) knownMonitors = monitors.map(boundsOf);
}

/**
 * Forget the remembered spot and send the overlay back to the bottom-right
 * corner, lying horizontally. The escape hatch for an overlay dragged onto a
 * monitor that no longer exists, or simply somewhere the user regrets.
 */
export function resetOverlayPosition(): void {
	clearTimeout(anchorWriteTimer);
	anchorWriteTimer = undefined;
	pendingAnchor = null;
	pendingEdge = null;
	deviceConfig.set('overlay.anchor', null);
	deviceConfig.set('overlay.edge', 'bottom');
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
	const overlay = await getOverlayWindow();
	if (!overlay) return;

	// A newer view is already queued behind this one, so the drawing work here is
	// wasted — but the visibility step at the bottom still runs, because it reads
	// the latest view and is the only step the user notices missing.
	const isSuperseded = () => view !== latestView;

	if (!isSuperseded()) {
		if (overlayIsVisible(view)) {
			const size = overlaySize(view);
			// Grow the window before telling the overlay to draw into it, and shrink
			// it after. Either way the window is never smaller than what it contains,
			// so nothing is clipped for the frame between the two IPC calls — which
			// is every dictation start, since the handle is a quarter of the pill's
			// width.
			const growing =
				!lastAppliedSize ||
				size.width > lastAppliedSize.width ||
				size.height > lastAppliedSize.height;

			if (growing) await applyGeometry(overlay, size);
			if (!isSuperseded()) {
				await attempt('push status', () => recordingOverlayStatus.emit(view));
			}
			if (!growing && !isSuperseded()) await applyGeometry(overlay, size);
		} else {
			await attempt('push status', () => recordingOverlayStatus.emit(view));
		}
	}

	await settleVisibility(overlay);
}

/**
 * Synchronize the native overlay without letting cosmetic failures stop capture.
 *
 * The caller reads the docked edge from settings, which lags a fresh drag by the
 * anchor write debounce, so it is overridden here with this module's own pending
 * value. One authority for the edge is the point: the window is sized from it
 * and the pill lays itself out from it, and a window sized for a horizontal bar
 * containing a vertical one is a bar drawn outside its own window.
 */
export function synchronizeRecordingOverlayWindow(
	view: RecordingOverlayView,
): void {
	const edge = effectiveEdge();
	const normalized = view.edge === edge ? view : { ...view, edge };
	latestView = normalized;
	queue = queue
		.then(() => applyOverlayView(normalized))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}
