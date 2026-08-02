<script lang="ts">
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, onMount } from 'svelte';
	import {
		recordingOverlayAction,
		recordingOverlayMicLevel,
		recordingOverlayMoved,
		recordingOverlayReady,
		recordingOverlayStatus,
		revealMainWindow,
	} from '$lib/recording-overlay/events';
	import type { RecordingOverlayView } from '$lib/recording-overlay/events';
	import { foldMicLevel } from '$lib/recording-pill/level';
	import type {
		OverlayEdge,
		RecordingPillAction,
	} from '$lib/recording-pill/model';
	import RecordingPill from '$lib/recording-pill/RecordingPill.svelte';

	// Tauri adapter for the recording pill. The overlay lives in its own webview,
	// so it cannot read the recorder state modules directly: the main window
	// pushes the current view over a Tauri event and we render from that, and
	// control gestures go back over Tauri events. The pill itself
	// (`RecordingPill`) is platform-free; this route owns the IPC glue.
	//
	// The window is created hidden, so `idleHandle: true` here only decides what
	// is drawn if the window is somehow shown before the first view lands — the
	// main window is the authority and sends its own value immediately.
	let view = $state<RecordingOverlayView>({
		status: null,
		idleHandle: true,
		edge: 'bottom',
	});

	// The window is anchored on the edge the bar is docked to, and the bar hugs
	// that edge inside it, so the transcript card grows inward and the bar itself
	// never moves as the window resizes around it. Bottom-anchored was the only
	// case before edges existed; the other three are the same rule.
	const ALIGNMENT_CLASS = {
		bottom: 'items-end justify-center',
		top: 'items-start justify-center',
		right: 'items-center justify-end',
		left: 'items-center justify-start',
	} satisfies Record<OverlayEdge, string>;

	// Live, smoothed mic loudness, 0 (silent) to 1 (loud). Driven by the
	// `mic-level` event: VAD frames in JS for voice-activated capture, the Rust
	// CPAL worker for manual recording. Both send a raw RMS amplitude; we apply
	// the perceptual curve and smoothing (shared with the web pill) so the bars
	// react to the actual voice rather than looping on a timer.
	let level = $state(0);

	const unlisteners: UnlistenFn[] = [];
	let isDestroyed = false;
	const trackUnlistener = (unlisten: UnlistenFn) => {
		if (isDestroyed) unlisten();
		else unlisteners.push(unlisten);
	};

	onMount(() => {
		void (async () => {
			trackUnlistener(
				await recordingOverlayStatus.listen((event) => {
					view = event.payload;
				}),
			);
			trackUnlistener(
				await recordingOverlayMicLevel.listen((event) => {
					level = foldMicLevel(level, event.payload);
				}),
			);
			// Report every move, with this side's account of whether a drag is in
			// flight. The main window separates its own repositioning from a real
			// drag by matching against the positions it commanded; see the event's
			// documentation for why the drag flag cannot be the mechanism.
			trackUnlistener(
				await getCurrentWindow().onMoved((event) => {
					if (isDraggingWindow) keepDragAliveUntilMovesStop();
					// The overlay is undecorated with no shadow, so its client area is
					// its window: the viewport in device pixels is the window's physical
					// size, measured without a Tauri round trip or a size permission.
					void recordingOverlayMoved.emit({
						x: event.payload.x,
						y: event.payload.y,
						width: Math.round(window.innerWidth * window.devicePixelRatio),
						height: Math.round(window.innerHeight * window.devicePixelRatio),
						dragging: isDraggingWindow,
					});
				}),
			);
			// Tell the main window we are ready so it re-sends the latest status.
			// Without this handshake the status emitted right after window creation
			// can land before our listener is attached.
			if (!isDestroyed) await recordingOverlayReady.emit();
		})();
	});

	onDestroy(() => {
		isDestroyed = true;
		for (const unlisten of unlisteners) unlisten();
	});

	function sendAction(action: RecordingPillAction) {
		void recordingOverlayAction.emit(action);
	}

	// A drag is bounded by its move reports, not by a pointer release: once
	// `startDragging` hands the pointer to the Windows move loop, this document
	// stops receiving pointer events entirely, so there is no `pointerup` to end
	// on. The moves are the only signal available, and they are an imperfect one —
	// the loop reports nothing while the user holds still, so a pause mid-drag
	// reads exactly like letting go. That is why this flag only ever suppresses
	// resizing (where a wrong answer costs a visual jolt) and never decides which
	// moves are remembered. Generous, because ending it early is the failure that
	// matters and ending it late costs one delayed resize.
	const DRAG_SETTLE_MS = 1_500;
	let isDraggingWindow = false;
	let dragSettleTimer: ReturnType<typeof setTimeout> | undefined;

	function keepDragAliveUntilMovesStop() {
		clearTimeout(dragSettleTimer);
		dragSettleTimer = setTimeout(() => {
			dragSettleTimer = undefined;
			isDraggingWindow = false;
		}, DRAG_SETTLE_MS);
	}

	/**
	 * Hand this window to the OS move loop. The pill decides when a press has
	 * become a drag; this only performs it, because "which window" is knowledge
	 * this route has and the platform-free pill must not.
	 */
	function startDragging() {
		isDraggingWindow = true;
		// If the drag never produces a move (the gesture was refused, or the user
		// let go without travelling), this closes it rather than leaving the flag
		// set for the next repositioning to misread.
		keepDragAliveUntilMovesStop();
		void getCurrentWindow()
			.startDragging()
			// A window that will not move is a cosmetic loss, not a reason to break
			// the dictation the overlay is reporting on.
			.catch((error: unknown) => {
				isDraggingWindow = false;
				console.warn('Overlay drag failed', error);
			});
	}
</script>

<!-- The pill hugs its content, so place it within the fixed overlay window (the
     web host centers its own copy). A fixed full-window flex box positions the
     chip regardless of how the layout nests the route.

     Edge-anchored, not centered: the window grows away from the screen edge the
     bar is docked to when a live transcript card stacks beside it, so pinning
     the bar to that edge keeps it sitting still on screen instead of jumping
     half the card's size every time text arrives. -->
<div class={`fixed inset-0 flex ${ALIGNMENT_CLASS[view.edge]}`}>
	<RecordingPill
		status={view.status}
		idleHandle={view.idleHandle}
		edge={view.edge}
		{level}
		onStop={() => sendAction('stop')}
		onCancel={() => sendAction('cancel')}
		onShipRaw={() => sendAction('ship-raw')}
		onStartCapture={() => sendAction('start')}
		onReveal={() => void revealMainWindow.emit()}
		onToggleTranscript={() => sendAction('toggle-transcript')}
		onDragStart={startDragging}
	/>
</div>

<style>
	/* The document-level resets below stay as `:global` CSS: a component cannot
	   apply utilities to `html`/`body` or to the dev-injected inspector host, so
	   these have no Tailwind equivalent. They belong to the overlay webview, not the
	   pill: they are only ever loaded in the dedicated overlay Tauri window, which
	   has its own document. The main app window never navigates here, so its
	   document background is untouched. (The isolation comes from the separate
	   webview document, not from Svelte's component scoping.) The shared
	   `RecordingPill` keeps no document-level styles so it can also mount inside the
	   app on web. */
	:global(html),
	:global(body) {
		background: transparent !important;
		margin: 0;
		overflow: hidden;
		/* The app shell forces a dark theme (ModeWatcher sets color-scheme:dark),
		   which makes the browser paint a dark canvas behind the pill in this
		   transparent webview. Reset it so only the pill is visible. */
		color-scheme: normal !important;
	}

	/* The Svelte inspector toggle (svelte.config.js `showToggleButton: always`)
	   is injected into every dev document, including this overlay webview where
	   it overlaps the pill. Hide it here; this rule lives only in the overlay
	   webview's document, and the host element does not exist in production. */
	:global(#svelte-inspector-host) {
		display: none !important;
	}
</style>
