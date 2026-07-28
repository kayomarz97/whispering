import type { DictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import type { RecordingPillStatus } from './model.js';

/**
 * Project the main window's dictation lifecycle into the serializable status the
 * pill renders. A live capture is the pill's primary content; when capture is
 * idle (manual after stop, a VAD session after disarm) the outcome takes the
 * pill. `idle`/`none` hides the pill (`null`). The live error object is dropped
 * in favor of the failure `tier`, because the pill display must cross Tauri IPC on
 * desktop and the full failure detail lives on the recordings row and in the OS
 * notification.
 *
 * Shared by both pill mounts so desktop and web project identically: the Tauri
 * driver (`attach-recording-overlay`) sends the result over IPC; the web host
 * (`RecordingPillHost`) feeds it to the same component directly.
 */
export function projectLifecycleToStatus(
	lifecycle: DictationLifecycle,
	/**
	 * The live transcript's text and whether its card is folded away, read from
	 * the stores by the runtime callers (kept parameters so this projection stays
	 * a pure function and never imports reactive state).
	 */
	transcript: { text: string; collapsed: boolean } = {
		text: '',
		collapsed: false,
	},
): RecordingPillStatus | null {
	const { capture, outcome } = lifecycle;

	// A live capture owns the pill: the recording meter is the primary content. For
	// a VAD session, resolve its two glanceable signals here, the one place that
	// owns them, so every surface reads the same booleans: speech latched, and a
	// previous phrase still transcribing alongside. Success and failure earn no
	// signal: success is the landing text, and a failure goes to the notification
	// and the recordings row, not the pill.
	if (capture.kind === 'recording') {
		if (capture.trigger === 'manual')
			return { phase: 'recording', trigger: 'manual' };
		return {
			phase: 'recording',
			trigger: 'vad',
			isSpeaking: capture.vadState === 'SPEECH_DETECTED',
			// The previous utterance's transcribe or its Polish pass both read as
			// "still working on the last phrase" beside the live meter.
			isTranscribing:
				outcome.kind === 'transcribing' || outcome.kind === 'polishing',
			// The running transcript built up from each pause so far. Empty unless
			// live transcription is enabled and at least one phrase has landed.
			liveTranscript: transcript.text,
			// Folded away by the minimize control or the idle timer. The pill draws
			// a chevron chip instead of the card, and the desktop overlay window
			// shrinks to match.
			transcriptCollapsed: transcript.collapsed,
		};
	}

	// Capture is idle, so the outcome is the pill's content. This is the manual
	// post-stop flow and a VAD session's last outcome after disarm.
	switch (outcome.kind) {
		case 'none':
			return null;
		case 'transcribing':
			return { phase: 'transcribing' };
		case 'polishing':
			return { phase: 'polishing' };
		case 'delivered':
			return { phase: 'delivered', reach: outcome.reach };
		case 'failed':
			return { phase: 'failed', tier: outcome.tier };
		default:
			outcome satisfies never;
			return null;
	}
}
