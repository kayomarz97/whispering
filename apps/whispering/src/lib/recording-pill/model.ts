import type { DeliveryReach } from '$lib/operations/delivery';
import type { DictationFailureTier } from '$lib/state/dictation-lifecycle.svelte';

/**
 * What the shared recording pill should display. Only non-idle phases are
 * representable: an idle dictation hides the pill rather than producing a
 * status. The model is platform-free; Tauri serializes it over overlay IPC and
 * the browser host consumes it directly.
 */
export type RecordingPillStatus =
	| { phase: 'recording'; trigger: 'manual' }
	| {
			phase: 'recording';
			trigger: 'vad';
			/** VAD has latched onto speech: light the meter past mere loudness. */
			isSpeaking: boolean;
			/** A previous phrase is still transcribing beside the live meter. */
			isTranscribing: boolean;
			/**
			 * Running live transcript so far this session (empty until the first
			 * phrase lands, and only populated when live transcription is enabled).
			 * Shown as building text below the meter in the overlay.
			 */
			liveTranscript: string;
			/**
			 * The transcript card is folded away, leaving only a chevron chip to
			 * bring it back. Set either by the user's minimize control or by the
			 * idle timer (`liveTranscription.overlayHideSeconds`), because both
			 * mean the same thing to the pill: draw the chip, not the card.
			 *
			 * The desktop overlay window is sized from what the pill renders, so a
			 * collapsed card also shrinks the window — which is the point. A card
			 * left up keeps a 360x168 window over whatever the user is reading, and
			 * that window swallows every click inside it.
			 */
			transcriptCollapsed: boolean;
	  }
	| { phase: 'transcribing' }
	| { phase: 'polishing' }
	| { phase: 'delivered'; reach: DeliveryReach }
	| { phase: 'failed'; tier: DictationFailureTier };

/**
 * A control gesture emitted by either mount of the shared recording pill.
 *
 * `toggle-transcript` folds the live transcript card away (or brings it back).
 * It is a gesture rather than local component state because the desktop pill
 * lives in its own webview while the window that must resize around it is owned
 * by the main window: the main window holds the fold state, so the card and the
 * window it sits in can never disagree.
 *
 * `start` comes from the resting handle: the overlay stays on screen as a small
 * line between dictations, and clicking it begins one. It is the only action
 * that arrives while nothing is live.
 */
export type RecordingPillAction =
	| 'start'
	| 'stop'
	| 'cancel'
	| 'ship-raw'
	| 'toggle-transcript';
