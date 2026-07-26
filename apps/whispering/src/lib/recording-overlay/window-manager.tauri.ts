import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	LogicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { once } from 'wellcrafted/function';
import { createLogger } from 'wellcrafted/logger';
import { whisperingPath } from '$lib/constants/urls';
import { settings } from '$lib/state/settings.svelte';
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
// When live transcription is on, the overlay also shows a transcript card above
// the pill (see RecordingPill), so the window is grown to fit it. Sized at
// creation from the setting; a mid-session toggle takes effect next session.
const OVERLAY_LIVE_WIDTH = 360;
const OVERLAY_LIVE_HEIGHT = 168;
// Corner placement (bottom-right, next to the Windows notification area / tray).
// Margins are in logical pixels. The bottom margin clears the taskbar since
// `monitor.size` reports the full monitor, not the taskbar-excluded work area.
const OVERLAY_BOTTOM_MARGIN = 72;
const OVERLAY_RIGHT_MARGIN = 24;

/** Overlay window size, grown when live transcription is on to fit the text. */
function overlaySize(): { width: number; height: number } {
	return settings.get('liveTranscription.enabled')
		? { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT }
		: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
}

let latestStatus: RecordingPillStatus | null = null;
let queue: Promise<void> = Promise.resolve();

async function computeOverlayPosition(): Promise<LogicalPosition | null> {
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;

	const scale = monitor.scaleFactor;
	const monitorX = monitor.position.x / scale;
	const monitorY = monitor.position.y / scale;
	const monitorWidth = monitor.size.width / scale;
	const monitorHeight = monitor.size.height / scale;

	// Bottom-right corner: pin to the right edge (minus margin) instead of centering.
	const { width, height } = overlaySize();
	const x = monitorX + monitorWidth - width - OVERLAY_RIGHT_MARGIN;
	const y = monitorY + monitorHeight - height - OVERLAY_BOTTOM_MARGIN;
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

async function createOverlayWindow(): Promise<WebviewWindow | null> {
	await ensureReadyListener();
	const overlayUrl = new URL(
		whisperingPath('/recording-overlay'),
		window.location.origin,
	).href;

	const { width, height } = overlaySize();
	const overlay = new WebviewWindow(RECORDING_OVERLAY_WINDOW_LABEL, {
		url: overlayUrl,
		title: 'Recording',
		width,
		height,
		transparent: true,
		decorations: false,
		shadow: false,
		alwaysOnTop: true,
		visibleOnAllWorkspaces: true,
		skipTaskbar: true,
		resizable: false,
		maximizable: false,
		minimizable: false,
		closable: false,
		focus: false,
		focusable: false,
		visible: false,
	});

	return new Promise<WebviewWindow | null>((resolve) => {
		overlay.once('tauri://created', () => resolve(overlay));
		overlay.once('tauri://error', (event) => {
			log.warn(
				new Error(
					`Failed to create recording overlay window: ${JSON.stringify(event.payload)}`,
				),
			);
			resolve(null);
		});
	});
}

async function getOrCreateOverlayWindow(): Promise<WebviewWindow | null> {
	const existing = await WebviewWindow.getByLabel(
		RECORDING_OVERLAY_WINDOW_LABEL,
	);
	if (existing) return existing;
	return createOverlayWindow();
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

	const overlay = await getOrCreateOverlayWindow();
	if (!overlay || isSuperseded()) return;

	const position = await computeOverlayPosition();
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
