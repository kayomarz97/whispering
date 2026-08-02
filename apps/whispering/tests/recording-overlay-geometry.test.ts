/**
 * Recording overlay geometry tests.
 *
 * Locks the three rules the overlay's screen footprint depends on:
 *
 * - The window is sized from what the pill actually draws, so folding the
 *   transcript card shrinks the WINDOW. The card is not merely hidden: a
 *   desktop overlay window covers the screen under it and swallows every click
 *   inside its bounds, so a fold that left the window at full size would leave
 *   the user's complaint ("it takes up the whole screen") completely unfixed.
 * - The bar lies parallel to the screen edge it is docked against, and the
 *   window transposes with it. A 224px-wide bar on the right-hand edge would
 *   have to stick out into the middle of the screen to fit at all.
 * - A remembered spot is the midpoint of the window side facing that edge, and
 *   is clamped onto a real monitor. Both matter: a top-left anchor would slide
 *   the bar across the screen whenever a transcript appeared, and an unclamped
 *   anchor would strand the overlay off-screen after a monitor was unplugged or
 *   resized.
 */
import { describe, expect, test } from 'bun:test';
import type { RecordingOverlayView } from '../src/lib/recording-overlay/events';
import {
	anchorProbePoint,
	edgeForRect,
	isVerticalEdge,
	type MonitorBounds,
	monitorContains,
	OVERLAY_COLLAPSED_HEIGHT,
	OVERLAY_HANDLE_HEIGHT,
	OVERLAY_HANDLE_WIDTH,
	OVERLAY_HEIGHT,
	OVERLAY_LIVE_HEIGHT,
	OVERLAY_LIVE_WIDTH,
	OVERLAY_WIDTH,
	type OverlayEdge,
	overlayAnchorFrom,
	overlayIsVisible,
	overlayPosition,
	overlaySize,
	physicalSizeOn,
} from '../src/lib/recording-overlay/geometry';
import type { RecordingPillStatus } from '../src/lib/recording-pill/model';

/** A view with the resting handle on, which is the shipped default. */
const view = (
	status: RecordingPillStatus | null,
	edge: OverlayEdge = 'bottom',
): RecordingOverlayView => ({
	status,
	idleHandle: true,
	edge,
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

const EDGES: OverlayEdge[] = ['bottom', 'top', 'left', 'right'];

describe('overlayIsVisible', () => {
	test('a dictation always shows the overlay', () => {
		expect(
			overlayIsVisible(view({ phase: 'recording', trigger: 'manual' })),
		).toBe(true);
		expect(
			overlayIsVisible({
				status: { phase: 'transcribing' },
				idleHandle: false,
				edge: 'bottom',
			}),
		).toBe(true);
	});

	test('with nothing live, the handle setting decides', () => {
		// This is what keeps the app reachable with its window closed to the tray:
		// the handle is the only surface left, so "no dictation" must not mean
		// "no window".
		expect(overlayIsVisible(view(null))).toBe(true);
		expect(
			overlayIsVisible({ status: null, idleHandle: false, edge: 'bottom' }),
		).toBe(false);
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
			(OVERLAY_LIVE_WIDTH * OVERLAY_LIVE_HEIGHT) / 3,
		);
	});

	test('a side edge transposes the bar and the handle', () => {
		for (const edge of ['left', 'right'] as const) {
			expect(overlaySize(view(null, edge))).toEqual({
				width: OVERLAY_HANDLE_HEIGHT,
				height: OVERLAY_HANDLE_WIDTH,
			});
			expect(overlaySize(view({ phase: 'transcribing' }, edge))).toEqual({
				width: OVERLAY_HEIGHT,
				height: OVERLAY_WIDTH,
			});
			// Folded, the chip lies along the bar too, so the whole footprint is the
			// horizontal one turned on its side.
			expect(
				overlaySize(
					view(
						vadRecording({
							liveTranscript: 'hello there',
							transcriptCollapsed: true,
						}),
						edge,
					),
				),
			).toEqual({ width: OVERLAY_COLLAPSED_HEIGHT, height: OVERLAY_WIDTH });
		}
	});

	test('the transcript card keeps its readable width beside a vertical bar', () => {
		// Deliberately NOT a transpose. A card turned on its side is a ~120px
		// column of running speech, about fifteen characters to a line. It stays
		// its readable width and moves to sit alongside the bar instead.
		const live = overlaySize(
			view(vadRecording({ liveTranscript: 'hello there' }), 'right'),
		);
		expect(live).toEqual({
			width: OVERLAY_HEIGHT + 8 + OVERLAY_LIVE_WIDTH,
			height: OVERLAY_WIDTH,
		});
		expect(live.width).toBeGreaterThan(OVERLAY_LIVE_WIDTH);
	});

	test('the top and bottom edges are the same horizontal layout', () => {
		for (const status of [null, vadRecording({ liveTranscript: 'hi' })]) {
			expect(overlaySize(view(status, 'top'))).toEqual(
				overlaySize(view(status, 'bottom')),
			);
		}
	});
});

describe('edgeForRect', () => {
	const bar = { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };

	test('picks the edge the window sits nearest to', () => {
		expect(edgeForRect({ x: 800, y: 1020, ...bar }, primary)).toBe('bottom');
		expect(edgeForRect({ x: 800, y: 10, ...bar }, primary)).toBe('top');
		expect(edgeForRect({ x: 10, y: 500, ...bar }, primary)).toBe('left');
		expect(
			edgeForRect({ x: 1900 - OVERLAY_WIDTH, y: 500, ...bar }, primary),
		).toBe('right');
	});

	test('the shipped default corner stays horizontal', () => {
		// 1920-224-24 by 1080-40-72: the bottom-right corner the overlay ships in.
		// It is nearer the bottom than the right, so it keeps the horizontal shape
		// it has always had — turning the default overlay sideways on first launch
		// would be a change nobody asked for.
		expect(edgeForRect({ x: 1672, y: 968, ...bar }, primary)).toBe('bottom');
	});

	test('a corner tie goes to the horizontal edge', () => {
		// Centre 100px from both the left and the bottom.
		const rect = {
			x: 100 - OVERLAY_WIDTH / 2,
			y: 980 - OVERLAY_HEIGHT / 2,
			...bar,
		};
		expect(edgeForRect(rect, primary)).toBe('bottom');
	});

	test('it answers against the monitor the window is on, not the origin', () => {
		// Near the second monitor's left edge, which is 1920px from the desktop
		// origin: measured against `primary` this would read as "right".
		const rect = { x: 1930, y: 700, ...bar };
		expect(edgeForRect(rect, secondary)).toBe('left');
	});

	test('turning the bar does not then turn it back', () => {
		// The flip changes the window's size, which moves its centre. If that
		// moved it enough to re-select a different edge, a single drop would
		// oscillate. Re-running the test on the placed vertical window must give
		// the same answer.
		const dropped = { x: 1870, y: 500, ...bar };
		const edge = edgeForRect(dropped, primary);
		expect(edge).toBe('right');

		const size = overlaySize(view({ phase: 'transcribing' }, edge));
		const anchor = overlayAnchorFrom(dropped, edge);
		const placed = overlayPosition({ anchor, edge, monitor: primary, size });
		expect(edgeForRect({ ...placed, ...size }, primary)).toBe(edge);
	});
});

describe('isVerticalEdge', () => {
	test('only the side edges lay the bar out vertically', () => {
		expect(EDGES.filter(isVerticalEdge)).toEqual(['left', 'right']);
	});
});

describe('overlayAnchorFrom', () => {
	test('remembers the bottom centre of where the window was dropped', () => {
		// Unchanged from before edges existed, so every position already saved on
		// a user's machine keeps meaning exactly what it meant.
		expect(
			overlayAnchorFrom({ x: 100, y: 200, width: 224, height: 40 }, 'bottom'),
		).toEqual({ x: 212, y: 240 });
	});

	test('remembers the side that faces the docked edge', () => {
		const rect = { x: 100, y: 200, width: 224, height: 40 };
		expect(overlayAnchorFrom(rect, 'top')).toEqual({ x: 212, y: 200 });
		expect(overlayAnchorFrom(rect, 'left')).toEqual({ x: 100, y: 220 });
		expect(overlayAnchorFrom(rect, 'right')).toEqual({ x: 324, y: 220 });
	});

	test('an anchor at a monitor edge still probes onto that monitor', () => {
		// The bottom and right anchors are one pixel past the last row or column
		// the window occupies, so an overlay dropped flush with the bottom of a
		// screen has an anchor NO monitor contains. Left uncorrected, a stacked
		// second monitor claims it and the overlay reappears pinned to the top of
		// the wrong screen at every launch; side by side, it falls through to
		// whichever monitor the window happens to be on.
		const stackedBelow: MonitorBounds = {
			x: 0,
			y: 1080,
			width: 1920,
			height: 1080,
			scaleFactor: 1,
		};
		const flushWithBottom = overlayAnchorFrom(
			{
				x: 800,
				y: 1080 - OVERLAY_HEIGHT,
				width: OVERLAY_WIDTH,
				height: OVERLAY_HEIGHT,
			},
			'bottom',
		);
		expect(flushWithBottom.y).toBe(1080);
		expect(monitorContains(primary, flushWithBottom)).toBe(false);
		expect(monitorContains(stackedBelow, flushWithBottom)).toBe(true);

		const probe = anchorProbePoint(flushWithBottom, 'bottom');
		expect(monitorContains(primary, probe)).toBe(true);
		expect(monitorContains(stackedBelow, probe)).toBe(false);
	});

	test('the same correction applies to a bar flush with the right edge', () => {
		const rightOfPrimary = overlayAnchorFrom(
			{
				x: 1920 - OVERLAY_HEIGHT,
				y: 500,
				width: OVERLAY_HEIGHT,
				height: OVERLAY_WIDTH,
			},
			'right',
		);
		expect(rightOfPrimary.x).toBe(1920);
		expect(monitorContains(primary, rightOfPrimary)).toBe(false);
		expect(monitorContains(secondary, rightOfPrimary)).toBe(true);

		const probe = anchorProbePoint(rightOfPrimary, 'right');
		expect(monitorContains(primary, probe)).toBe(true);
		expect(monitorContains(secondary, probe)).toBe(false);
	});

	test('the top and left anchors already sit inside the window', () => {
		const anchor = { x: 500, y: 500 };
		expect(anchorProbePoint(anchor, 'top')).toEqual(anchor);
		expect(anchorProbePoint(anchor, 'left')).toEqual(anchor);
	});
});

describe('physicalSizeOn', () => {
	test('is the same conversion overlayPosition uses', () => {
		// Size and position must agree on one scale factor. Sizing the window
		// logically — letting Tauri convert with whichever monitor the window is
		// currently on — while placing it with the target monitor's factor leaves
		// the two out of step across a mixed-DPI desktop, and the window settles
		// beside its remembered centre by half the difference.
		const size = { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
		const anchor = { x: 3000, y: 1200 };
		const physical = physicalSizeOn(secondary, size);
		expect(physical).toEqual({ width: 280, height: 50 });

		const { x } = overlayPosition({
			anchor,
			edge: 'bottom',
			monitor: secondary,
			size,
		});
		// The anchor is the horizontal centre, so the gap either side of it must be
		// exactly half the physical width the caller is about to apply.
		expect(anchor.x - x).toBe(Math.round(physical.width / 2));
	});
});

describe('overlayPosition', () => {
	test('with no anchor, it sits in the monitor bottom-right corner', () => {
		const { x, y } = overlayPosition({
			anchor: null,
			edge: 'bottom',
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		// 1920 - 224 - 24 margin, and 1080 - 40 - 72 taskbar-clearing margin.
		expect({ x, y }).toEqual({ x: 1672, y: 968 });
	});

	test('the default corner follows the monitor the overlay is on', () => {
		const { x, y } = overlayPosition({
			anchor: null,
			edge: 'bottom',
			monitor: secondary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		// Physical: the second monitor starts at x=1920 and everything scales 1.25.
		expect({ x, y }).toEqual({ x: 1920 + 2560 - 280 - 30, y: 1440 - 50 - 90 });
	});

	test('an anchored overlay keeps its bar still while the card grows, on every edge', () => {
		// The invariant the whole anchor scheme exists for, stated once per edge:
		// the side facing the screen edge does not move when a transcript appears,
		// and the bar stays centred on the anchor along the other axis. Anything
		// else and the bar slides across the screen every time text arrives.
		const anchors: Record<OverlayEdge, { x: number; y: number }> = {
			bottom: { x: 800, y: 900 },
			top: { x: 800, y: 120 },
			left: { x: 40, y: 500 },
			right: { x: 1880, y: 500 },
		};

		for (const edge of EDGES) {
			const anchor = anchors[edge];
			const restingSize = overlaySize(view({ phase: 'transcribing' }, edge));
			const liveSize = overlaySize(
				view(vadRecording({ liveTranscript: 'hello there' }), edge),
			);
			const resting = overlayPosition({
				anchor,
				edge,
				monitor: primary,
				size: restingSize,
			});
			const withCard = overlayPosition({
				anchor,
				edge,
				monitor: primary,
				size: liveSize,
			});

			const facing = (
				position: { x: number; y: number },
				size: typeof restingSize,
			) => {
				switch (edge) {
					case 'bottom':
						return position.y + size.height;
					case 'top':
						return position.y;
					case 'right':
						return position.x + size.width;
					case 'left':
						return position.x;
				}
			};
			const along = (
				position: { x: number; y: number },
				size: typeof restingSize,
			) =>
				isVerticalEdge(edge)
					? position.y + size.height / 2
					: position.x + size.width / 2;

			expect(facing(resting, restingSize)).toBe(facing(withCard, liveSize));
			expect(along(resting, restingSize)).toBe(along(withCard, liveSize));
		}
	});

	test('an anchor is clamped back onto the monitor it lands on', () => {
		// Saved against a wider display that is now gone: without the clamp the
		// overlay would sit past the right and bottom edges, unreachable.
		const { x, y } = overlayPosition({
			anchor: { x: 3800, y: 2000 },
			edge: 'bottom',
			monitor: primary,
			size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
		});
		expect(x).toBe(1920 - OVERLAY_WIDTH);
		expect(y).toBe(1080 - OVERLAY_HEIGHT);
	});

	test('a vertical bar dropped past an edge is clamped back on too', () => {
		const size = overlaySize(view({ phase: 'transcribing' }, 'right'));
		const { x, y } = overlayPosition({
			anchor: { x: 2400, y: 1400 },
			edge: 'right',
			monitor: primary,
			size,
		});
		expect(x).toBe(1920 - size.width);
		expect(y).toBe(1080 - size.height);
	});

	test('an anchor near the top-left corner is clamped to the monitor origin', () => {
		const { x, y } = overlayPosition({
			anchor: { x: 0, y: 0 },
			edge: 'bottom',
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
			edge: 'bottom',
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
