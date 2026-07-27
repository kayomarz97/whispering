import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	LogicalPosition,
	LogicalSize,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { once } from 'wellcrafted/function';
import { createLogger } from 'wellcrafted/logger';
import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	recordingOverlayReady,
	recordingOverlayStatus,
} from '$lib/recording-overlay/events';
import type { RecordingPillStatus } from '$lib/recording-pill/model';

const log = createLogger('whispering/recording-overlay');

// Fixed size in logical pixels. The width is the pill's max width (the cap in
// RecordingPill); the transparent window centers the narrower states inside it.
const OVERLAY_WIDTH = 224;
const OVERLAY_HEIGHT = 40;
// A live transcript renders as a card stacked above the pill (see RecordingPill),
// so the window grows to fit it: the card's own width plus the pill's horizontal
// breathing room, and its max height plus the pill and the gap between them.
const OVERLAY_LIVE_WIDTH = 360;
const OVERLAY_LIVE_HEIGHT = 168;
// Corner placement (bottom-right, next to the Windows notification area / tray).
// Margins are in logical pixels. The bottom margin clears the taskbar since
// `monitor.size` reports the full monitor, not the taskbar-excluded work area.
const OVERLAY_BOTTOM_MARGIN = 72;
const OVERLAY_RIGHT_MARGIN = 24;

/**
 * The window size for what the pill is actually rendering right now.
 *
 * This tracks the render condition in `RecordingPill`, not the live-transcription
 * setting: the transcript card only exists while a VAD capture has text to show.
 * Sizing off the setting alone left a manual recording — which never draws a card
 * — floating inside a window four times taller than its pill. The overlay is
 * bottom-anchored, so the pill holds its place on screen and the card grows
 * upward as it appears.
 */
function overlaySize(status: RecordingPillStatus | null): {
	width: number;
	height: number;
} {
	const showsTranscript =
		status?.phase === 'recording' &&
		status.trigger === 'vad' &&
		status.liveTranscript.length > 0;
	return showsTranscript
		? { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT }
		: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
}

let latestStatus: RecordingPillStatus | null = null;
let queue: Promise<void> = Promise.resolve();

async function computeOverlayPosition(size: {
	width: number;
	height: number;
}): Promise<LogicalPosition | null> {
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;

	const scale = monitor.scaleFactor;
	const monitorX = monitor.position.x / scale;
	const monitorY = monitor.position.y / scale;
	const monitorWidth = monitor.size.width / scale;
	const monitorHeight = monitor.size.height / scale;

	// Bottom-right corner: pin to the right edge (minus margin) instead of centering.
	// Both edges are derived from the current size, so a window that grows to fit a
	// transcript keeps the same bottom-right anchor and expands up and to the left.
	const x = monitorX + monitorWidth - size.width - OVERLAY_RIGHT_MARGIN;
	const y = monitorY + monitorHeight - size.height - OVERLAY_BOTTOM_MARGIN;
	return new LogicalPosition(x, y);
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

	// Size before position: the anchor is the bottom-right corner, so the
	// position is derived from the size we are about to apply. Setting both on
	// every status keeps the window fitted to what the pill draws, so a
	// transcript appearing (or the mode changing mid-session) resizes it now
	// rather than at the next launch.
	const size = overlaySize(status);
	await overlay.setSize(new LogicalSize(size.width, size.height));
	if (isSuperseded()) return;

	const position = await computeOverlayPosition(size);
	if (isSuperseded()) return;
	if (position) await overlay.setPosition(position);
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
