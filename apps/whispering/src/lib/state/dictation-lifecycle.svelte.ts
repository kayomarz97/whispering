import type { AnyTaggedError } from 'wellcrafted/error';
import type { VadState } from '$lib/constants/audio';
import type { DeliveryReach } from '$lib/operations/delivery';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * The dictation lifecycle owned by the main window. See ADR-0039.
 *
 * Voice-activated capture is *continuous*: an utterance transcribes while the
 * session keeps listening, so a live meter and a pipeline outcome run at once.
 * Manual capture is sequential. Two facts keep both honest:
 *
 * - `capture` is *derived* from the recorder machines: the live session, with no
 *   second copy of "are we recording" to drift.
 * - `outcome` is the most-recent utterance's pipeline result, an ephemeral signal
 *   the pipeline drives. Most-recent-wins: a new utterance overwrites it, and the
 *   OS-notification path reads it and wants each distinct failure exactly once.
 *
 * A failure is transient here, not a held state: the pill glances it (manual),
 * the OS notification fires for it, and the recordings row is the durable
 * record. The pill is not a review surface, so there is no failure latch.
 */
export type DictationCapture =
	| { kind: 'idle' }
	| { kind: 'recording'; trigger: 'manual' }
	| { kind: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> };

export type DictationOutcome =
	| { kind: 'none' }
	| { kind: 'transcribing' }
	| { kind: 'polishing' }
	| { kind: 'delivered'; reach: DeliveryReach }
	| ({ kind: 'failed' } & DictationFailure);

export type DictationLifecycle = {
	capture: DictationCapture;
	outcome: DictationOutcome;
};

/** Where a dictation failed, which determines how loudly feedback surfaces it. */
export type DictationFailureTier = 'silent-loss' | 'transcription';

/** A dictation failure, carrying the live error object for the projection. */
export type DictationFailure = {
	tier: DictationFailureTier;
	error: AnyTaggedError;
};

// How long a clean delivery's checkmark flashes before the outcome retires to
// `none`. Sub-second: the transcribed text landing is the real receipt, so this
// is a glance confirming it, not a notice to read. (A live VAD session projects
// `delivered` to no pip, so this flash only ever shows once capture is idle.)
const DELIVERED_FLASH_MS = 900;

// How long the outcomes that carry real information — a reduced reach, or a
// failure — stay up before retiring. Long enough to read and act on, and then
// gone.
//
// These used to hold until the next dictation, on the reasoning that they say
// something the landing text does not. That reasoning still holds; what changed
// is the surface. The desktop overlay now rests permanently on screen as a small
// handle, and a held outcome does not merely linger — it occupies that handle's
// place indefinitely, so the affordance the user is told to click to start
// dictating is instead a stale notice that raises the app window. For anyone
// whose cursor writes cannot paste (no Accessibility grant), every single
// dictation ends in `clipboard`, which would leave the handle permanently
// unreachable from the first dictation onward.
//
// Nothing is lost by retiring them: ADR-0039 already puts the durable record on
// the recordings row and the OS notification, and calls the pill a glance.
const REDUCED_REACH_HOLD_MS = 6_000;
const FAILURE_HOLD_MS = 8_000;

function createDictationLifecycle() {
	// The outcome track is the ephemeral signal directly: `none` when no utterance
	// is in flight, otherwise the most-recent utterance's phase. Reset to `none`
	// when a new dictation begins so a stale `failed` never lingers past the next
	// attempt.
	let outcome = $state<DictationOutcome>({ kind: 'none' });
	let retireTimer: ReturnType<typeof setTimeout> | undefined;
	// Counts outcome changes, so a pending retirement can tell whether the
	// outcome it was scheduled for is still the current one.
	//
	// Deliberately a counter and not an identity check against the outcome
	// object: `$state` deep-proxies what is assigned to it, so `outcome` reads
	// back as a proxy and never `===` the plain object that was stored. Written
	// that way first, it made the guard permanently false and nothing ever
	// retired — a failed dictation held the overlay forever, which is the exact
	// defect this retirement exists to fix.
	let outcomeGeneration = 0;

	function setOutcome(next: DictationOutcome) {
		clearTimeout(retireTimer);
		retireTimer = undefined;
		outcomeGeneration += 1;
		outcome = next;
	}

	/** Retire this outcome after `delayMs`, unless a newer one has taken over. */
	function retireAfter(delayMs: number) {
		const generation = outcomeGeneration;
		retireTimer = setTimeout(() => {
			retireTimer = undefined;
			if (outcomeGeneration === generation) setOutcome({ kind: 'none' });
		}, delayMs);
	}

	// The live session, read straight off the recorder machines. The pill owner is
	// the most-recent dictation, so a manual recording and a VAD session never
	// both report `recording` (only one recorder is live at a time).
	const capture = $derived.by((): DictationCapture => {
		if (manualRecorder.state === 'RECORDING')
			return { kind: 'recording', trigger: 'manual' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { kind: 'recording', trigger: 'vad', vadState: vadRecorder.state };
		return { kind: 'idle' };
	});

	const current = $derived<DictationLifecycle>({ capture, outcome });

	return {
		/** The current lifecycle facts. Read reactively to project them. */
		get current(): DictationLifecycle {
			return current;
		},

		/**
		 * A new dictation is starting: clear any terminal outcome from the last one
		 * so it does not linger into this attempt.
		 */
		reset(): void {
			setOutcome({ kind: 'none' });
		},

		/** The recorder stopped (or a VAD utterance ended); now transcribing. */
		markTranscribing(): void {
			setOutcome({ kind: 'transcribing' });
		},

		/**
		 * The transcript landed and the always-on Polish pass is now running over it
		 * (ADR-0099). Held until `markDelivered`, with a `ship-raw` control on the
		 * pill to skip it. Only entered when a Polish pass actually runs (a usable
		 * provider, Polish on); speed mode goes straight from transcribing to
		 * delivered.
		 */
		markPolishing(): void {
			setOutcome({ kind: 'polishing' });
		},

		/**
		 * The transcript landed. `reach` is how far it got toward the configured
		 * output: either a clean `output` or a `clipboard` fallback. Both reaches are
		 * successes because the text is saved, so neither is a dictation failure.
		 *
		 * A clean `output` flashes for a beat: the landing text is the receipt, so
		 * the pill is just a glance. The reduced `clipboard` reach holds several
		 * times longer, because the text did not land where the user asked and the
		 * tag carries information the text alone does not — a sub-second flash
		 * would be too easy to miss. There is no notification for a reduced reach
		 * (ADR-0039): the pill tag and the recordings row are the surfaces, and a
		 * revoked Accessibility grant already raises its own standing notice.
		 */
		markDelivered(reach: DeliveryReach): void {
			setOutcome({ kind: 'delivered', reach });
			retireAfter(
				reach === 'output' ? DELIVERED_FLASH_MS : REDUCED_REACH_HOLD_MS,
			);
		},

		/** A dictation failed: hold the failed outcome long enough to read, then
		 * retire it. Transient, not a held state: the pill glances it (manual), the
		 * notification path fires it, and the recordings row is the durable record. */
		markFailed(failure: DictationFailure): void {
			setOutcome({ kind: 'failed', ...failure });
			retireAfter(FAILURE_HOLD_MS);
		},
	};
}

export const dictationLifecycle = createDictationLifecycle();
