/**
 * Recording overlay geometry tests.
 *
 * Locks the two rules the overlay's screen footprint depends on:
 *
 * - The window is sized from what the pill actually draws, so folding the
 *   transcript card shrinks the WINDOW. The card is not merely hidden: a
 *   desktop overlay window covers the screen under it and swallows every click
 *   inside its bounds, so a fold that left the window at full size would leave
 *   the user's complaint ("it takes up the whole screen") completely unfixed.
 * - A remembered spot is the window's bottom centre, and is clamped onto a real
 *   monitor. Both matter: a top-left anchor would slide the pill down the screen
 *   whenever a transcript appeared, and an unclamped anchor would strand the
 *   overlay off-screen after a monitor was unplugged or resized.
 */
import { describe, expect, test } from 'bun:test';
import type { RecordingOverlayView } from '../src/lib/recording-overlay/events';
import {
	type MonitorBounds,
	monitorContains,
	OVERLAY_COLLAPSED_HEIGHT,
	OVERLAY_HANDLE_HEIGHT,
	OVERLAY_HANDLE_WIDTH,
	OVERLAY_HEIGHT,
	OVERLAY_LIVE_HEIGHT,
	OVERLAY_LIVE_WIDTH,
	OVERLAY_WIDTH,
	overlayAnchorFrom,
	overlayIsVisible,
	overlayPosition,
	overlaySize,
} from '../src/lib/recording-overlay/geometry';
import type { RecordingPillStatus } from '../src/lib/recording-pill/model';

/** A view with the resting handle on, which is the shipped default. */
const view = (status: RecordingPillStatus | null): RecordingOverlayView => ({
	status,
	idleHandle: true,
});

const vadRecording = (
	overrides: Partial<Extract<RecordingPillStatus, { trigger: 'vad' }>> = {},
): RecordingPillStatus => ({
	phase: 'recording',
	trigger: 'vad',
	isSpeaking: false,
	isTranscribing: false,
	liveTranscript: '',
	transcriptCollapsed: false,
	...overrides,
});

// A plain 1920x1080 primary monitor at 100%, and a second one to its right at
// 125% — the layout that breaks naive logical-coordinate maths, since each
// monitor divides by its own scale factor.
const primary: MonitorBounds = {
	x: 0,
	y: 0,
	width: 1920,
	height: 1080,
	scaleFactor: 1,
};
const secondary: MonitorBounds = {
	x: 1920,
	y: 0,
	width: 2560,
	height: 1440,
	scaleFactor: 1.25,
};

describe('overlayIsVisible', () => {
	test('a dictation always shows the overlay', () => {
		expect(overlayIsVisible(view({ phase: 'recording', trigger: 'manual' }))).toBe(
			true,
		);
		expect(
			overlayIsVisible({
				status: { phase: 'transcribing' },
				idleHandle: false,
			}),
		).toBe(true);
	});

	test('with nothing live, the handle setting decides', () => {
		// This is what keeps the app reachable with its window closed to the tray:
		// the handle is the only surface left, so "no dictation" must not mean
		// "no window".
		expect(overlayIsVisible(view(null))).toBe(true);
		expect(overlayIsVisible({ status: null, idleHandle: false })).toBe(false);
	});
});

describe('overlaySize', () => {
	test('with nothing live the window is just the resting handle', () => {
		expect(overlaySize(view(null))).toEqual({
			width: OVERLAY_HANDLE_WIDTH,
			height: OVERLAY_HANDLE_HEIGHT,
		});
	});

	test('a manual or transcribing pill gets the resting pill size', () => {
		expect(
			overlaySize(view({ phase: 'recording', trigger: 'manual' })),
		).toEqual({ width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
		expect(overlaySize(view({ phase: 'transcribing' }))).toEqual({
			width: OVERLAY_WIDTH,
			height: OVERLAY_HEIGHT,
		});
	});

	test('a VAD capture with no text yet stays at the resting pill size', () => {
		// Sizing off the live-transcription *setting* was the old bug: it left a
		// capture with nothing to show floating in a window four times too tall.
		expect(overlaySize(view(vadRecording()))).toEqual({
			width: OVERLAY_WIDTH,
			height: OVERLAY_HEIGHT,
		});
	});

	test('a transcript grows the window to fit its card', () => {
		expect(
			overlaySize(view(vadRecording({ liveTranscript: 'hello there' }))),
		).toEqual({ width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT });
	});

	test('folding the card shrinks the window, not just the card', () => {
		const folded = overlaySize(
			view(
				vadRecording({
					liveTranscript: 'hello there',
					transcriptCollapsed: true,
				}),
			),
		);
		expect(folded).toEqual({
			width: OVERLAY_WIDTH,
			height: OVERLAY_COLLAPSED_HEIGHT,
		});
		// The whole point: a folded overlay covers a fraction of the screen a
		// live one does.
		expect(folded.width * folded.height).toBeLessThan(
			OVERLAY_LIVE_WIDTH * OVERLAY_LIVE_HEIGHT / 3,
		);
	});
});

describe('overlayAnchorFrom', () => {
	test('remembers the bottom centre of where the window was dropped', () => {
		expect(
			overlayAnchorFrom({ x: 100, y: 200, width: 224, height: 40 }),
		).toEqual({ x: 212, y: 240 });
	});
});

describe('overlayPosition', () => {
	test('with no anchor, it sits in the monitor bottom-right corner', () => {
		const { x, y } = overlayPosition({
			anchor: null,
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		// 1920 - 224 - 24 margin, and 1080 - 40 - 72 taskbar-clearing margin.
		expect({ x, y }).toEqual({ x: 1672, y: 968 });
	});

	test('the default corner follows the monitor the overlay is on', () => {
		const { x, y } = overlayPosition({
			anchor: null,
			monitor: secondary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		// Physical: the second monitor starts at x=1920 and everything scales 1.25.
		expect({ x, y }).toEqual({ x: 1920 + 2560 - 280 - 30, y: 1440 - 50 - 90 });
	});

	test('an anchored overlay keeps its pill still while the card grows above it', () => {
		const anchor = { x: 800, y: 900 };
		const resting = overlayPosition({
			anchor,
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		const withCard = overlayPosition({
			anchor,
			monitor: primary,
			size: { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT },
		});

		// Same bottom edge and same horizontal centre in both sizes: the pill does
		// not move when a transcript appears, the card expands upward and outward.
		expect(resting.y + OVERLAY_HEIGHT).toBe(withCard.y + OVERLAY_LIVE_HEIGHT);
		expect(resting.x + OVERLAY_WIDTH / 2).toBe(
			withCard.x + OVERLAY_LIVE_WIDTH / 2,
		);
	});

	test('an anchor is clamped back onto the monitor it lands on', () => {
		// Saved against a wider display that is now gone: without the clamp the
		// overlay would sit past the right and bottom edges, unreachable.
		const { x, y } = overlayPosition({
			anchor: { x: 3800, y: 2000 },
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		expect(x).toBe(1920 - OVERLAY_WIDTH);
		expect(y).toBe(1080 - OVERLAY_HEIGHT);
	});

	test('an anchor near the top-left corner is clamped to the monitor origin', () => {
		const { x, y } = overlayPosition({
			anchor: { x: 0, y: 0 },
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		expect({ x, y }).toEqual({ x: 0, y: 0 });
	});

	test('a window larger than its monitor pins to the origin rather than inverting', () => {
		const tiny: MonitorBounds = {
			x: 0,
			y: 0,
			width: 200,
			height: 100,
			scaleFactor: 1,
		};
		const { x, y } = overlayPosition({
			anchor: { x: 150, y: 90 },
			monitor: tiny,
			size: { width: OVERLAY_LIVE_WIDTH, height: OVERLAY_LIVE_HEIGHT },
		});
		expect({ x, y }).toEqual({ x: 0, y: 0 });
	});
});

describe('monitorContains', () => {
	test('separates two monitors at their shared edge', () => {
		expect(monitorContains(primary, { x: 1919, y: 500 })).toBe(true);
		expect(monitorContains(primary, { x: 1920, y: 500 })).toBe(false);
		expect(monitorContains(secondary, { x: 1920, y: 500 })).toBe(true);
	});
});
