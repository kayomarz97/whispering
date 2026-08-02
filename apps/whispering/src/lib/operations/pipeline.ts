import { InstantString } from '@epicenter/field';
import { IanaTimeZone } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import {
	deliverTranscriptionResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { polishWillRun, runPolish } from '$lib/operations/run-polish';
import { sound } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { RecorderStopResult } from '$lib/services/recorder/contract';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { liveTranscript } from '$lib/state/live-transcript.svelte';
import { overlayTranscript } from '$lib/state/overlay-transcript.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * Whether a voice-activated session is still listening right now.
 *
 * Read straight off the recorder state module rather than through
 * `operations/recording`, which imports this file: the state module imports no
 * operations, so this direction has no cycle.
 */
const isVadSessionLive = (): boolean =>
	vadRecorder.state === 'LISTENING' || vadRecorder.state === 'SPEECH_DETECTED';

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file import path build the
 * equivalent shape with `kind: 'blob'`. `deliverySource` is forwarded
 * straight to delivery, so it shares delivery's `TranscriptionSource` type.
 */
type PipelineInput = {
	source: RecorderStopResult;
	durationMs: number | null;
	deliverySource?: TranscriptionSource;
};

/**
 * Processes a recording through the full pipeline: persist artifact,
 * transcribe by id, then polish.
 *
 * Audio bytes never live in pipeline state. For cpal sources Rust has
 * already written the durable artifact at
 * `<appDataDir>/recordings/{id}.wav` by the time we get here. For blob
 * sources (navigator MediaRecorder, VAD, file import) we persist the
 * bytes through the recordings blob store, then operate on the id.
 *
 * `deliverySource` only shapes the success copy (recording vs file import).
 */
export async function processRecordingPipeline({
	source,
	durationMs,
	deliverySource = 'recording',
}: PipelineInput) {
	const now = InstantString.now();
	const recordingId =
		source.kind === 'artifact' ? source.artifact.id : source.recordingId;

	// A live dictation (not a file import) drives the dictation pill. The
	// recorder is already idle by the time we get here, so the lifecycle hands
	// the pill from `recording` to `transcribing`. File imports have their own
	// surface, so they leave the dictation lifecycle untouched.
	const isDictation = deliverySource === 'recording';
	if (isDictation) dictationLifecycle.markTranscribing();

	recordings.set({
		id: recordingId,
		title: '',
		recordedAt: now,
		recordedAtZone: IanaTimeZone.current(),
		transcript: '',
		polishedTranscript: null,
		duration: durationMs,
		transcription: null,
	});

	if (source.kind === 'blob') {
		const { error: saveError } = await services.blobs.audio.save(
			recordingId,
			source.blob,
		);
		if (saveError) {
			// Transcription reads by id from disk: if the save failed there
			// is nothing to transcribe. Bailing here surfaces the real
			// failure instead of the misleading "no recording artifact
			// found" the transcribe path would emit on the empty directory.
			recordings.update(recordingId, {
				transcription: {
					status: 'failed',
					completedAt: InstantString.now(),
					error: extractErrorMessage(saveError),
				},
			});
			if (isDictation) {
				// No toast in the dictation path: the failure goes to the notification
				// (when unfocused) and the recordings row.
				dictationLifecycle.markFailed({
					tier: 'transcription',
					error: saveError,
				});
			} else {
				report.error({
					title: 'Failed to save recording',
					description:
						'We could not write the recording bytes; transcription cannot continue.',
					cause: saveError,
				});
			}
			return;
		}
	}

	// File import has no pill, so it keeps a progress toast; the dictation path is
	// driven by the lifecycle markers above (the pill), with no toast.
	const transcribeLoading = isDictation
		? null
		: report.loading({
				title: '📋 Transcribing...',
				description: 'Your recording is being transcribed...',
			});

	const { data: transcribedText, error: transcribeError } =
		await transcribeAndPersist(recordingId);

	if (transcribeError) {
		if (isDictation) {
			dictationLifecycle.markFailed({
				tier: 'transcription',
				error: transcribeError,
			});
		} else {
			transcribeLoading?.reject({ cause: transcribeError });
		}
		return;
	}

	// Live transcription: append this phrase to the running overlay transcript so
	// text builds up as the user speaks. Dictation-only and gated on the setting;
	// purely additive, it never affects the Polish/delivery path below.
	if (isDictation && settings.get('liveTranscription.enabled')) {
		liveTranscript.append(transcribedText);
		// New text is the activity the overlay's idle timer waits for: it brings the
		// card back if the timer had folded it away, and restarts the countdown from
		// this phrase. A card the user folded by hand stays folded.
		overlayTranscript.noteActivity(
			settings.get('liveTranscription.overlayHideSeconds'),
		);
	}

	// Run Polish over the raw transcript, then deliver the polished text. The raw
	// stays on `recordings.transcript` (persisted by transcribeAndPersist) so
	// "show original" is recoverable. We hold delivery until Polish finishes and
	// deliver once, with the final text: delivering the raw and then the polished
	// version would land two copies (a clipboard the user might paste mid-polish,
	// or two cursor pastes), the exact race the deliver-after-polish rule exists to
	// dodge. Polish is the only thing on the automatic path; there is no
	// auto-running Recipe. See ADR-0099.
	//
	// The "Polishing…" HUD and its ship-raw control live on the dictation pill, so
	// the lifecycle's polishing phase and the abort signal are dictation-only: file
	// import has no pill to cancel from and keeps its own progress toast. The pill
	// shows the HUD only when an AI pass actually runs (not in speed mode); begin/end
	// bracket the call so the controller is dropped on success, failure, or abort.
	const willPolish = polishWillRun(transcribedText);
	const showPolishHud = willPolish && isDictation;
	let signal: AbortSignal | undefined;
	if (showPolishHud) {
		dictationLifecycle.markPolishing();
		signal = polishHud.begin();
	}
	const { data: polishedText, error: polishError } = await runPolish({
		input: transcribedText,
		signal,
	});
	if (showPolishHud) polishHud.end();
	// Polish is best-effort: a failed AI pass carries the raw transcript in
	// `fallback`, so a transcript is never lost to a polish error. Surface the
	// failure without blocking delivery.
	const deliveredText = polishError ? polishError.fallback : polishedText;
	if (polishError) {
		report.info({
			title: 'Polishing skipped',
			description: polishError.message,
		});
	}

	// Persist the polished transcript alongside the raw transcript so history
	// shows what was actually delivered, with the original one click away. Only
	// write when a Polish pass actually produced a result: `recordings.set`
	// already left `polishedTranscript` null, so speed mode (no AI call) and a
	// polish failure (the fallback delivers the raw words) need no second write.
	if (willPolish && !polishError) {
		recordings.update(recordingId, { polishedTranscript: polishedText });
	}

	// The transcript is "ready" once it is polished and about to be delivered, so
	// the completion sound and the resolved loading notice both fire here.
	//
	// …except while a voice-activated session is still listening. Every pause
	// ends a phrase, so this would chime once per pause, over the top of someone
	// still mid-sentence — reported as "the ting-tong noise while I'm talking is
	// very distracting, I get confused about what's happening". The sound means
	// "your words have landed", which is only true once the session is over. The
	// phrase that finishes *after* listening stops still gets it, because by then
	// the recorder is idle and it means exactly that. Manual dictation is one
	// phrase per session and is unaffected.
	if (!isVadSessionLive()) sound.playSoundIfEnabled('transcriptionComplete');
	const { outcome: transcriptDelivery, notice: transcribeNotice } =
		await deliverTranscriptionResult({
			text: deliveredText,
			source: deliverySource,
		});
	if (isDictation) {
		// The polished transcript is the dictation receipt. Every reach is a success
		// (the transcript is saved), so this is always `delivered`; the reach decides
		// whether the pill flashes (clean `output`) or persists (a reduced
		// `clipboard`).
		dictationLifecycle.markDelivered(transcriptDelivery.reach);
	} else {
		transcribeLoading?.resolve(transcribeNotice);
	}
}
