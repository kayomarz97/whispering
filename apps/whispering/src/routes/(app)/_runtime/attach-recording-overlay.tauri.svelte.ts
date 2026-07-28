import type { UnlistenFn } from '@tauri-apps/api/event';
import {
	recordingOverlayAction,
	recordingOverlayMoved,
	revealMainWindow,
} from '$lib/recording-overlay/events';
import {
	recordOverlayMove,
	synchronizeRecordingOverlayWindow,
} from '$lib/recording-overlay/window-manager.tauri';
import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { liveTranscript } from '$lib/state/live-transcript.svelte';
import { overlayTranscript } from '$lib/state/overlay-transcript.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauriOnly } from '$lib/tauri.tauri';
import type { RuntimeOwner } from './types';

/** Own the Tauri recording overlay for the app session. */
function attachRecordingOverlay() {
	const unlisteners: UnlistenFn[] = [];
	let isDestroyed = false;
	const trackUnlistener = (unlisten: UnlistenFn) => {
		if (isDestroyed) unlisten();
		else unlisteners.push(unlisten);
	};

	const overlayView = $derived({
		status: projectLifecycleToStatus(dictationLifecycle.current, {
			text: liveTranscript.text,
			collapsed: overlayTranscript.collapsed,
		}),
		idleHandle: settings.get('overlay.idleHandle'),
	});

	$effect(() => {
		synchronizeRecordingOverlayWindow(overlayView);
	});

	void recordingOverlayAction
		.listen((event) => dispatchPillAction(event.payload))
		.then(trackUnlistener);
	// Every move the overlay window makes. The window manager sorts the user's
	// drags from its own repositioning by matching against the positions it
	// commanded, and remembers the former.
	void recordingOverlayMoved
		.listen((event) => recordOverlayMove(event.payload))
		.then(trackUnlistener);
	void revealMainWindow
		.listen(() => tauriOnly.mainWindow.reveal())
		.then(trackUnlistener);

	return () => {
		isDestroyed = true;
		for (const unlisten of unlisteners) unlisten();
	};
}

export const recordingOverlayRuntimeOwner: RuntimeOwner | null = {
	attach: attachRecordingOverlay,
};
