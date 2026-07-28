/**
 * Whether the recording overlay's live transcript card is folded away.
 *
 * The card is the only part of the overlay that is large enough to sit over what
 * the user is reading, and the desktop overlay is a real window: while the card
 * is up, a 360x168 rectangle of the screen both covers content and swallows
 * clicks. So it folds, by two independent routes that mean the same thing to the
 * pill but must not overrule each other:
 *
 * - `userCollapsed` — the minimize control. A direct instruction, so a new
 *   phrase does NOT undo it; only the user expanding again does.
 * - `autoHidden` — the idle timer (`liveTranscription.overlayHideSeconds`).
 *   "Nothing has happened for a few seconds", so any new activity clears it and
 *   the card comes back on its own.
 *
 * Kept in the main window rather than in the overlay webview because the window
 * has to be resized around the fold, and the main window owns the window. One
 * copy of the fact means the card and the window it lives in cannot disagree.
 */
class OverlayTranscript {
	#userCollapsed = $state(false);
	#autoHidden = $state(false);
	#timer: ReturnType<typeof setTimeout> | undefined;

	/** Fold the transcript card away, by either route. */
	get collapsed(): boolean {
		return this.#userCollapsed || this.#autoHidden;
	}

	/**
	 * The minimize control was used. Expanding also restarts the idle timer, so an
	 * expand behaves like any other activity rather than pinning the card open
	 * forever.
	 */
	toggle(hideAfterSeconds: number): void {
		if (this.collapsed) {
			this.#userCollapsed = false;
			this.#autoHidden = false;
			this.#restartTimer(hideAfterSeconds);
			return;
		}
		this.#clearTimer();
		this.#userCollapsed = true;
	}

	/**
	 * Something happened worth showing: a phrase landed, or speech started. Undoes
	 * an automatic hide and restarts the countdown. Deliberately does not undo a
	 * user's explicit minimize.
	 *
	 * `hideAfterSeconds` of 0 means "never hide on its own", so the countdown is
	 * simply not armed.
	 */
	noteActivity(hideAfterSeconds: number): void {
		this.#autoHidden = false;
		this.#restartTimer(hideAfterSeconds);
	}

	/** A new dictation session: unfold and drop any pending countdown. */
	reset(): void {
		this.#clearTimer();
		this.#userCollapsed = false;
		this.#autoHidden = false;
	}

	#restartTimer(hideAfterSeconds: number): void {
		this.#clearTimer();
		if (hideAfterSeconds <= 0) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#autoHidden = true;
		}, hideAfterSeconds * 1000);
	}

	#clearTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

export const overlayTranscript = new OverlayTranscript();
