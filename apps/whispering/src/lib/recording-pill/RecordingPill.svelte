<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Component } from 'svelte';
	import { DICTATION_FAILURE_LABEL } from '$lib/dictation-feedback';
	import type { DeliveryReach } from '$lib/operations/delivery';
	import LevelMeter from '$lib/recording-pill/LevelMeter.svelte';
	import type {
		OverlayEdge,
		RecordingPillStatus,
	} from '$lib/recording-pill/model';
	import VadIndicator from '$lib/recording-pill/VadIndicator.svelte';

	// The floating dictation pill, presentational and platform-free. It renders
	// whatever status it is handed and reports control gestures through callback
	// props; it never reads recorder state or touches Tauri. The Tauri build
	// drives it over IPC from a dedicated overlay webview; the web build mounts it
	// directly in the app layout. Both feed the same `status` and `level`.
	let {
		status,
		level,
		onStop,
		onCancel,
		onShipRaw,
		onReveal,
		onToggleTranscript,
		onDragStart,
		onStartCapture,
		idleHandle = false,
		edge = 'bottom',
	}: {
		/** What to display, or `null` when no dictation is in flight. */
		status: RecordingPillStatus | null;
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Stop the live capture (stop recording / stop listening). */
		onStop: () => void;
		/** Discard the live manual recording. */
		onCancel: () => void;
		/** Skip the in-flight Polish pass and deliver the raw transcript now. */
		onShipRaw: () => void;
		/** Reveal Whispering by raising the main window (desktop). */
		onReveal?: () => void;
		/** Fold the live transcript card away, or bring it back. */
		onToggleTranscript?: () => void;
		/**
		 * Hand the pill's window over to the OS move loop (desktop). Called once
		 * per gesture, after the pointer has travelled far enough to be a drag
		 * rather than a click. Absent on web, where the pill is an element in the
		 * page and there is no window to move.
		 */
		onDragStart?: () => void;
		/** Begin a dictation from the resting handle. */
		onStartCapture?: () => void;
		/**
		 * Rest as a small handle instead of rendering nothing when `status` is
		 * `null`. Desktop only: the handle exists so the overlay stays on screen
		 * (and clickable) between dictations, which has no meaning for the web
		 * mount, where the pill is an element inside a page the user is already
		 * looking at.
		 */
		idleHandle?: boolean;
		/**
		 * The screen edge the pill is docked against. The bar lies parallel to it —
		 * horizontal along the top and bottom, vertical down the left and right —
		 * and the transcript card grows away from it, never over it. The web mount
		 * is an element in a page with no edge, and keeps the default.
		 */
		edge?: OverlayEdge;
	} = $props();

	// ── Orientation ──────────────────────────────────────────────────────────
	// One derived flag and four small class maps, rather than an `if` per element.
	// The pill's structure is identical in both orientations; only the axis it
	// runs along, the side the card stacks on, and the way the labels read
	// change. Keeping that in maps is what stops the vertical layout drifting into
	// a second copy of the component.

	const vertical = $derived(edge === 'left' || edge === 'right');

	/** Card first or bar first, so the bar always ends up against the edge. */
	const STACK_CLASS = {
		bottom: 'flex-col',
		top: 'flex-col-reverse',
		right: 'flex-row',
		left: 'flex-row-reverse',
	} satisfies Record<OverlayEdge, string>;

	/** Which way the chevron points to bring the folded card back. */
	const SHOW_CARD_ICON = {
		bottom: ChevronUpIcon,
		top: ChevronDownIcon,
		right: ChevronLeftIcon,
		left: ChevronRightIcon,
	} satisfies Record<OverlayEdge, Component<{ class?: string }>>;

	/** …and back toward the edge to fold it away again. */
	const HIDE_CARD_ICON = {
		bottom: ChevronDownIcon,
		top: ChevronUpIcon,
		right: ChevronRightIcon,
		left: ChevronLeftIcon,
	} satisfies Record<OverlayEdge, Component<{ class?: string }>>;

	/** The resting handle hugs its edge rather than floating in the window. */
	const HANDLE_CLASS = {
		bottom: 'h-5 w-full items-end justify-center pb-[3px]',
		top: 'h-5 w-full items-start justify-center pt-[3px]',
		right: 'h-full w-5 items-center justify-end pr-[3px]',
		left: 'h-full w-5 items-center justify-start pl-[3px]',
	} satisfies Record<OverlayEdge, string>;

	const ShowCardIcon = $derived(SHOW_CARD_ICON[edge]);
	const HideCardIcon = $derived(HIDE_CARD_ICON[edge]);

	// Text inside a vertical bar reads along the bar. `vertical-rl` is the
	// standard rotation for Latin script in a vertical line: the characters turn
	// a quarter turn clockwise and the line runs downward, which is how every
	// vertical taskbar and side rail reads. Turning the bar but leaving the label
	// horizontal would make it a 40px-wide box the label cannot fit in at all.
	const labelClass = $derived(
		vertical
			? 'max-h-full min-h-0 truncate text-[13px] font-medium [writing-mode:vertical-rl]'
			: 'min-w-0 truncate text-[13px] font-medium',
	);

	// Dragging the overlay and clicking it to reveal Whispering share one pointer,
	// so they are separated by distance rather than by target. `startDragging`
	// hands the pointer to the OS move loop, which never returns a `pointerup` or a
	// `click` to this document — so calling it on `pointerdown` would silently
	// delete the reveal gesture. Instead the press is watched until it travels
	// DRAG_THRESHOLD_PX, and only then becomes a drag; anything shorter stays a
	// click. The flag then suppresses the trailing `click` in the case where the
	// window manager does deliver one.
	const DRAG_THRESHOLD_PX = 4;
	let pressOrigin: { x: number; y: number } | null = null;
	let capture: { element: Element; pointerId: number } | null = null;
	let didDrag = $state(false);

	// The press has to be followed outside the element, and the overlay window is
	// barely bigger than the element: a vertical bar is 20px wide. A quick flick
	// leaves the window between two pointer samples, and without capture those
	// moves go to whatever window is now under the cursor — so the threshold is
	// never crossed, `startDragging` is never called, and the bar simply refuses
	// to move. Reproduced exactly that way on the 20px-wide vertical handle.
	function capturePointer(event: PointerEvent) {
		const element = event.currentTarget;
		if (!(element instanceof Element)) return;
		try {
			element.setPointerCapture(event.pointerId);
			capture = { element, pointerId: event.pointerId };
		} catch {
			// A pointer that has already been released or retargeted; the press is
			// still tracked, it just cannot be followed off the element.
		}
	}

	function releasePointer() {
		if (!capture) return;
		const { element, pointerId } = capture;
		capture = null;
		if (element.hasPointerCapture(pointerId))
			element.releasePointerCapture(pointerId);
	}

	function onDragSurfacePointerDown(event: PointerEvent) {
		if (!onDragStart || event.button !== 0) return;
		pressOrigin = { x: event.clientX, y: event.clientY };
		didDrag = false;
		capturePointer(event);
	}

	function onDragSurfacePointerMove(event: PointerEvent) {
		if (!onDragStart || !pressOrigin || didDrag) return;
		// A press this element never saw released — the overlay window can be
		// hidden out from under one — would otherwise leave `pressOrigin` set, and
		// the next plain hover would hand the window to the OS move loop with no
		// button held, leaving it stuck to the cursor until the user clicks.
		if (event.buttons === 0) {
			pressOrigin = null;
			releasePointer();
			return;
		}
		const travelled = Math.hypot(
			event.clientX - pressOrigin.x,
			event.clientY - pressOrigin.y,
		);
		if (travelled < DRAG_THRESHOLD_PX) return;
		didDrag = true;
		pressOrigin = null;
		// Hand the pointer back before the OS move loop takes it: from that call
		// on this document receives no further pointer events at all, so a capture
		// left held would never be released by a `pointerup` that never comes.
		releasePointer();
		onDragStart();
	}

	function onDragSurfacePointerUp() {
		pressOrigin = null;
		releasePointer();
	}

	/** Reveal, unless this press was really a drag. */
	function onPillClick() {
		if (didDrag) {
			didDrag = false;
			return;
		}
		onReveal?.();
	}

	/** How much text is folded away, so the collapsed chip still says something. */
	function wordCount(text: string): number {
		const words = text.trim().split(/\s+/).filter(Boolean);
		return words.length;
	}

	// Narrow the status to its live-recording variants once, so the template reads
	// the discriminated fields directly (manual vs vad, speech latched, a previous
	// phrase transcribing) instead of a flattened bag of booleans. `null` for every
	// non-recording phase, which the chip block below renders instead.
	const recording = $derived(status?.phase === 'recording' ? status : null);

	// Every non-recording phase is a "chip": one icon plus a short, fixed label,
	// with a tone that tints the icon (and, when failed, the whole pill). They
	// render through one block below instead of a branch apiece. The label is
	// always a closed, glanceable token, never a raw error message, so it fits the
	// fixed-width pill without truncation; the full failure detail lives in the OS
	// notification and the recordings row (ADR-0039).
	type Chip = {
		Icon: Component<{ class?: string }>;
		label: string;
		tone: 'neutral' | 'success' | 'degraded' | 'failed';
	};
	const CHIP_TONE_CLASS = {
		neutral: 'text-white/80',
		success: 'text-[#7ee2a8]',
		degraded: 'text-[#f5c97b]',
		failed: 'text-[#ffb4b4]',
	} satisfies Record<Chip['tone'], string>;

	// A delivery is a success at both reaches: a clean `output` reads green; the
	// `clipboard` fallback reads amber, "landed, but not where you asked".
	const DELIVERED_CHIP = {
		output: { Icon: CheckIcon, label: 'Delivered', tone: 'success' },
		clipboard: {
			Icon: CheckIcon,
			label: 'Copied to clipboard',
			tone: 'degraded',
		},
	} satisfies Record<DeliveryReach, Chip>;

	const chip = $derived.by((): Chip | null => {
		if (!status) return null;
		switch (status.phase) {
			// `recording` renders the meter and `polishing` its own HUD (with an
			// action), so neither is a plain chip.
			case 'recording':
			case 'polishing':
				return null;
			case 'transcribing':
				return {
					Icon: Spinner,
					label: 'Transcribing',
					tone: 'neutral',
				};
			case 'delivered':
				return DELIVERED_CHIP[status.reach];
			case 'failed':
				return {
					Icon: TriangleAlertIcon,
					label: DICTATION_FAILURE_LABEL[status.tier],
					tone: 'failed',
				};
			default:
				status satisfies never;
				return null;
		}
	});

	// Resting state is a filled chip, not a bare icon, so the controls read as
	// buttons at a glance in the small pill. Each control composes its own tone over
	// this shared base, which carries the hover/press feedback: background and
	// press-scale glide together at 150ms.
	const actionBase =
		'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/90 transition duration-150 ease-out hover:scale-[1.08] active:scale-95';
</script>

<!-- The desktop pill lives in a non-focusable overlay window. Clicking its body
     asks the main window to reveal itself; the nested controls stop propagation
     so stop, cancel, and ship-raw never reveal it as a side effect. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if !status && idleHandle}
	<!-- Resting: a small line, always on screen, which is the whole point. The
	     main window closes to the tray and the app has no other visible surface,
	     so this is what a dictation starts from when the user has not memorised a
	     shortcut — click it and it becomes the pill. It is a dark bar with a light
	     ring rather than a plain white line because it has to stay legible over
	     whatever happens to be behind it. It lies along its edge, so a handle on
	     the side of the screen is a vertical tick, not a stub poking inward. -->
	<button
		type="button"
		class={cn(
			'group flex cursor-pointer bg-transparent select-none',
			HANDLE_CLASS[edge],
		)}
		aria-label="Start dictation"
		title="Click to start dictation · drag to move"
		onpointerdown={onDragSurfacePointerDown}
		onpointermove={onDragSurfacePointerMove}
		onpointerup={onDragSurfacePointerUp}
		onpointercancel={onDragSurfacePointerUp}
		onpointerleave={onDragSurfacePointerUp}
		onclick={() => {
			if (didDrag) {
				didDrag = false;
				return;
			}
			onStartCapture?.();
		}}
	>
		<span
			class={cn(
				'rounded-full bg-[#0f0f11]/85 ring-1 ring-white/30 transition-all duration-150 ease-out group-hover:bg-[#0f0f11]/95 group-hover:ring-white/60',
				vertical
					? 'h-14 w-[6px] group-hover:h-20'
					: 'h-[6px] w-14 group-hover:w-20',
			)}
		></span>
	</button>
{:else if status}
	<!-- Stack wrapper: the live transcript (when present) sits on the inward side
	     of the bar, so it never grows over the screen edge the bar is docked to.
	     With no transcript this collapses to just the bar, unchanged. -->
	<div class={cn('flex items-center gap-2', STACK_CLASS[edge])}>
		{#if recording && recording.trigger === 'vad' && recording.liveTranscript}
			{#if recording.transcriptCollapsed}
				{@const words = wordCount(recording.liveTranscript)}
				<!-- Folded away: a chip barely thicker than a line of text, so the
				     desktop overlay window shrinks back to near the bar's own
				     footprint and stops covering (and swallowing clicks over) what is
				     behind it. It still reports how much text is waiting, so folding
				     never reads as "the transcript was lost". -->
				<button
					type="button"
					class={cn(
						'flex items-center gap-1.5 rounded-full border border-white/10 bg-[#0f0f11]/80 text-[11px] font-medium text-white/70 backdrop-blur-md transition duration-150 select-none hover:text-white/95',
						vertical
							? 'w-6 flex-col px-0 py-2.5 [writing-mode:vertical-rl]'
							: 'h-6 px-2.5',
					)}
					aria-label="Show live transcript"
					title="Show live transcript"
					onpointerdown={onDragSurfacePointerDown}
					onpointermove={onDragSurfacePointerMove}
					onpointerup={onDragSurfacePointerUp}
					onpointercancel={onDragSurfacePointerUp}
					onpointerleave={onDragSurfacePointerUp}
					onclick={(event) => {
						event.stopPropagation();
						if (didDrag) {
							didDrag = false;
							return;
						}
						onToggleTranscript?.();
					}}
				>
					<ShowCardIcon class="size-3.5 shrink-0" />
					{words}
					{words === 1 ? 'word' : 'words'}
				</button>
			{:else}
				<!-- The card keeps its readable horizontal shape in both orientations.
				     Turned on its side it would be a 120px column fitting about fifteen
				     characters to a line, which is not a transcript anyone can read; so
				     beside a vertical bar it simply sits alongside instead of above. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class={cn(
						'relative w-[340px] overflow-hidden rounded-2xl border border-white/10 bg-[#0f0f11]/90 py-2.5 pr-9 pl-3.5 text-left text-[13px] leading-snug text-white/90 backdrop-blur-md select-none',
						vertical ? 'max-h-[208px]' : 'max-h-[96px]',
					)}
					onpointerdown={onDragSurfacePointerDown}
					onpointermove={onDragSurfacePointerMove}
					onpointerup={onDragSurfacePointerUp}
					onpointercancel={onDragSurfacePointerUp}
					onpointerleave={onDragSurfacePointerUp}
				>
					{recording.liveTranscript}
					<button
						type="button"
						class={cn(
							actionBase,
							'absolute top-1.5 right-1.5 size-5 hover:bg-white/20',
						)}
						aria-label="Hide live transcript"
						title="Hide live transcript"
						onpointerdown={(event) => event.stopPropagation()}
						onclick={(event) => {
							event.stopPropagation();
							onToggleTranscript?.();
						}}
					>
						<HideCardIcon class="size-3.5" />
					</button>
				</div>
			{/if}
		{/if}
	<div
		class={cn(
			// 40px-thick bar, shared look. gap-2.5 spaces the chip icon from its label;
			// in recording it is only the floor (justify-between distributes wider). The
			// length differs by phase (next arg).
			'box-border flex items-center gap-2.5 rounded-full text-white/90 backdrop-blur-md select-none',
			vertical ? 'w-10 flex-col px-0 py-2.5' : 'h-10 px-2.5',
			// Recording is a longer bar: the mic pins the leading edge and stop the
			// trailing one, with the meter spread between them (justify-between). The
			// text chips hug their content, capped long enough for the longest label
			// ("Transcription failed") to show in full. The 224px cap is mirrored by
			// the desktop overlay window (OVERLAY_WIDTH in the Tauri runtime owner),
			// which must stay in sync — transposed on a vertical edge.
			vertical
				? recording
					? 'h-[208px] justify-between'
					: 'h-fit max-h-[224px]'
				: recording
					? 'w-[208px] justify-between'
					: 'w-fit max-w-[224px]',
			// Failed: a red chip so the failure reads at a glance, with the terse reason
			// in the label. No action: detail and retry live on the recordings row.
			chip?.tone === 'failed'
				? 'border border-red-500/55 bg-[#3c1216]/90'
				: 'border border-white/10 bg-[#0f0f11]/80',
			onReveal && 'cursor-pointer',
		)}
		title={onDragStart
			? 'Drag to move · click to open Whispering'
			: onReveal
				? 'Open Whispering'
				: undefined}
		onpointerdown={onDragSurfacePointerDown}
		onpointermove={onDragSurfacePointerMove}
		onpointerup={onDragSurfacePointerUp}
		onpointercancel={onDragSurfacePointerUp}
		onpointerleave={onDragSurfacePointerUp}
		onclick={onPillClick}
	>
		{#if recording}
			{@const stopLabel =
				recording.trigger === 'manual' ? 'Stop recording' : 'Stop listening'}
			<!-- The mode icon doubles as the visible grab affordance: the whole pill
			     drags, but a lone icon gives no hint that it can be moved, so this
			     one carries the grab cursor. On web there is no window to move and it
			     stays a plain icon. -->
			<div
				class={cn(
					'flex size-6 shrink-0 items-center justify-center rounded-full text-white/80',
					onDragStart && 'cursor-grab active:cursor-grabbing hover:bg-white/10',
				)}
			>
				{#if recording.trigger === 'manual'}
					<MicIcon class="size-4" />
				{:else}
					<AudioLinesIcon class="size-4" />
				{/if}
			</div>

			<!-- Speech detected (VAD) tints the bars so the user sees capture cross the
			     threshold, on top of the height already reacting to loudness. -->
			<LevelMeter
				{level}
				{vertical}
				class={vertical ? 'w-5' : 'h-5'}
				barClass={recording.trigger === 'vad' && recording.isSpeaking
					? 'bg-[#ffe5ee]'
					: undefined}
			/>

			<!-- Trailing cluster: a contextual slot, then stop as the constant final
			     anchor. Manual and VAD share this skeleton (slot then stop), so the
			     meter and the stop button land in the same place in both modes and only
			     the slot's content differs. The slot is always the cancel button's
			     size, so the cluster reads as balanced and the pill keeps a steady
			     length as the slot's content changes. -->
			<div class={cn('flex items-center gap-1', vertical && 'flex-col')}>
				{#if recording.trigger === 'manual'}
					<!-- Manual can discard the take, so the slot is the cancel button. -->
					<button
						type="button"
						class={cn(actionBase, 'hover:bg-[#faa2ca]/20 hover:text-[#ffd2e4]')}
						aria-label="Cancel recording"
						title="Cancel recording"
						onpointerdown={(event) => event.stopPropagation()}
						onclick={(event) => {
							event.stopPropagation();
							onCancel();
						}}
					>
						<XIcon class="size-4" />
					</button>
				{:else}
					<!-- VAD has no per-utterance cancel, so the slot holds the capture
					     indicator at the cancel button's size, keeping the cluster
					     balanced. The dim-dot -> lit-dot -> spinner mark: the bars track
					     raw level, this mark tracks whether VAD has latched onto speech
					     (with its detection delay) and then the previous phrase's
					     transcribe. -->
					<div class="flex size-6 shrink-0 items-center justify-center">
						<VadIndicator signals={recording} />
					</div>
				{/if}

				<!-- Stop: the primary action and the constant final anchor. A red chip so
				     it reads as "stop recording". -->
				<button
					type="button"
					class={cn(actionBase, 'bg-red-500/60 text-white hover:bg-red-500/80')}
					aria-label={stopLabel}
					title={stopLabel}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={(event) => {
						event.stopPropagation();
						onStop();
					}}
				>
					<SquareIcon class="size-3.5" />
				</button>
			</div>
		{:else if status.phase === 'polishing'}
			<!-- The Polish HUD holds the same spot as a chip: a spinner and "Polishing…"
			     mask the ~1s AI pass, with a single ship-raw control to skip it and take
			     the raw transcript now (ADR-0099). Unlike a chip, it carries an action. -->
			<div class="flex shrink-0 items-center text-white/80">
				<Spinner class="size-4 text-white/80" />
			</div>
			<span class={labelClass}>Polishing…</span>
			<button
				type="button"
				class={cn(actionBase, 'hover:bg-[#faa2ca]/20 hover:text-[#ffd2e4]')}
				aria-label="Ship raw transcript now"
				title="Ship raw transcript now"
				onpointerdown={(event) => event.stopPropagation()}
				onclick={(event) => {
					event.stopPropagation();
					onShipRaw();
				}}
			>
				<XIcon class="size-4" />
			</button>
		{:else if chip}
			<!-- One chip block for every non-recording phase. A failure is glanceable
			     by design: the terse label, no action; detail and retry live on the
			     recordings row (ADR-0039). -->
			{@const Icon = chip.Icon}
			<div
				class={cn(
					'flex shrink-0 items-center',
					// A clean delivery reads green; a reduced reach (clipboard/history)
					// reads amber, "landed, but not where you asked" rather than a clean
					// success; a failure reads red, paired with the red pill background.
					CHIP_TONE_CLASS[chip.tone],
				)}
			>
				<Icon class="size-4" />
			</div>
			<!-- The label takes only its text's length in the snug chip. Labels are
			     closed, short tokens that fit the fixed-size pill; truncate's ellipsis
			     is a safety net, not load-bearing truncation. The full failure detail
			     lives in the OS notification and the recordings row, never here. -->
			<span class={labelClass}>{chip.label}</span>
		{/if}
	</div>
	</div>
{/if}
