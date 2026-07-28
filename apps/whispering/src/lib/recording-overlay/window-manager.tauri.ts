import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	availableMonitors,
	currentMonitor,
	LogicalSize,
	type Monitor,
	PhysicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { once } from 'wellcrafted/function';
import { createLogger } from 'wellcrafted/logger';
import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	recordingOverlayReady,
	recordingOverlayStatus,
} from '$lib/recording-overlay/events';
import {
	type MonitorBounds,
	monitorContains,
	overlayAnchorFrom,
	overlayPosition,
	overlaySize,
	type Point,
} from '$lib/recording-overlay/geometry';
import type { RecordingPillStatus } from '$lib/recording-pill/model';
import { deviceConfig } from '$lib/state/device-config.svelte';

const log = createLogger('whispering/recording-overlay');

// How far a reported move may sit from the position we just commanded and still
// count as our own `setPosition` echoing back rather than the user dragging.
// Logical-to-physical rounding can shift a corner by a pixel; a real drag never
// ends this close to where the window already was.
const MOVE_ECHO_TOLERANCE_PX = 2;

let latestStatus: RecordingPillStatus | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * The physical position this module last asked the overlay to take.
 *
 * Every `setPosition` makes the window report a move, and that report is
 * indistinguishable from a drag unless you know what you commanded. Without
 * this the overlay would "remember" its own default corner the first time it
 * was shown and never return to that corner again — not after a resolution
 * change, and not on a different monitor.
 */
let lastCommandedPosition: Point | null = null;

/** Whether the overlay is already at `point`, give or take rounding. */
const isAt = (point: Point): boolean =>
	lastCommandedPosition !== null &&
	Math.abs(point.x - lastCommandedPosition.x) <= MOVE_ECHO_TOLERANCE_PX &&
	Math.abs(point.y - lastCommandedPosition.y) <= MOVE_ECHO_TOLERANCE_PX;

const boundsOf = (monitor: Monitor): MonitorBounds => ({
	x: monitor.position.x,
	y: monitor.position.y,
	width: monitor.size.width,
	height: monitor.size.height,
	scaleFactor: monitor.scaleFactor,
});

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
	const containing = monitors.find((monitor) =>
		monitorContains(boundsOf(monitor), anchor),
	);
	// The anchor's monitor is gone (unplugged, or resized under it): fall through
	// to wherever the overlay currently is and let the clamp pull it on-screen.
	return containing ?? (await currentMonitor()) ?? (await primaryMonitor());
}

async function computeOverlayPosition(size: {
	width: number;
	height: number;
}): Promise<PhysicalPosition | null> {
	const anchor = deviceConfig.get('overlay.anchor');
	const monitor = anchor
		? await monitorForAnchor(anchor)
		: ((await currentMonitor()) ?? (await primaryMonitor()));
	if (!monitor) return null;

	const { x, y } = overlayPosition({
		anchor,
		monitor: boundsOf(monitor),
		size,
	});
	return new PhysicalPosition(x, y);
}

/**
 * Remember where the user dragged the overlay.
 *
 * Called for every move the overlay reports, including the ones this module
 * caused; the commanded-position check is what separates a drag from an echo.
 */
export function recordOverlayMove(move: {
	x: number;
	y: number;
	width: number;
	height: number;
}): void {
	if (isAt(move)) return;
	// The drag's landing spot is now the commanded position too, so the same move
	// reported twice is not processed twice — and so a status arriving mid-drag
	// does not fight the OS move loop for the window.
	lastCommandedPosition = { x: move.x, y: move.y };
	deviceConfig.set('overlay.anchor', overlayAnchorFrom(move));
}

/**
 * Forget the remembered spot and send the overlay back to the bottom-right
 * corner. The escape hatch for an overlay dragged onto a monitor that no longer
 * exists, or simply somewhere the user regrets.
 */
export function resetOverlayPosition(): void {
	deviceConfig.set('overlay.anchor', null);
	lastCommandedPosition = null;
	synchronizeRecordingOverlayWindow(latestStatus);
}

/** Keep the ready listener live before a newly created overlay can emit. */
const ensureReadyListener = once(
	(): Promise<void> =>
		recordingOverlayReady
			.listen(() => {
				if (latestStatus) void recordingOverlayStatus.emit(latestStatus);
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
	const overlay = await WebviewWindow.getByLabel(RECORDING_OVERLAY_WINDOW_LABEL);
	if (!overlay) {
		log.warn(
			new Error(
				`No "${RECORDING_OVERLAY_WINDOW_LABEL}" window: the native overlay was not created at startup.`,
			),
		);
	}
	return overlay;
}

async function applyOverlayStatus(status: RecordingPillStatus | null) {
	const isSuperseded = () => status !== latestStatus;
	if (isSuperseded()) return;

	if (!status) {
		const overlay = await WebviewWindow.getByLabel(
			RECORDING_OVERLAY_WINDOW_LABEL,
		);
		if (overlay) await overlay.hide();
		return;
	}

	const overlay = await getOverlayWindow();
	if (!overlay || isSuperseded()) return;

	// Size before position: the anchor is the window's bottom edge and centre, so
	// the position is derived from the size we are about to apply. Setting both on
	// every status keeps the window fitted to what the pill draws, so a transcript
	// appearing or folding resizes it now rather than at the next launch.
	const size = overlaySize(status);
	await overlay.setSize(new LogicalSize(size.width, size.height));
	if (isSuperseded()) return;

	const position = await computeOverlayPosition(size);
	if (isSuperseded()) return;
	// Only move it if it is not already there. This is not an optimization: while
	// the user drags, the OS move loop repositions the window on every mouse
	// move and a live VAD session pushes a status on every speech transition, so
	// an unconditional `setPosition` would yank the window back mid-drag. Each
	// reported move updates `lastCommandedPosition`, so a status arriving during
	// a drag computes the spot the window is already in and leaves it alone.
	if (position && !isAt(position)) {
		lastCommandedPosition = { x: position.x, y: position.y };
		await overlay.setPosition(position);
	}
	if (isSuperseded()) return;

	await overlay.show();
	if (isSuperseded()) {
		if (!latestStatus) await overlay.hide();
		return;
	}

	await recordingOverlayStatus.emit(status);
}

/** Synchronize the native overlay without letting cosmetic failures stop capture. */
export function synchronizeRecordingOverlayWindow(
	status: RecordingPillStatus | null,
): void {
	latestStatus = status;
	queue = queue
		.then(() => applyOverlayStatus(status))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}
