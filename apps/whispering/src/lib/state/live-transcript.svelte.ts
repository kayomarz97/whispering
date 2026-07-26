/**
 * Accumulates the phrases transcribed during a live (pause-triggered) dictation
 * session, so the recording overlay can show text building up as the user
 * speaks. The pipeline appends each completed phrase (see
 * `operations/pipeline.ts`, gated on `liveTranscription.enabled`); the VAD start
 * path resets it (`operations/recording.ts`). Platform-free reactive state: the
 * projection reads `.text` and the pill renders it, on both web and desktop.
 */
class LiveTranscript {
	#phrases = $state<string[]>([]);

	/** All phrases so far, joined into one running transcript. */
	get text(): string {
		return this.#phrases.join(' ');
	}

	/** Append one just-transcribed phrase. Blank phrases are ignored. */
	append(phrase: string): void {
		const trimmed = phrase.trim();
		if (trimmed) this.#phrases = [...this.#phrases, trimmed];
	}

	/** Clear the running transcript at the start of a new session. */
	reset(): void {
		if (this.#phrases.length > 0) this.#phrases = [];
	}
}

export const liveTranscript = new LiveTranscript();
