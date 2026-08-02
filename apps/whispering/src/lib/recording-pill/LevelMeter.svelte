<script lang="ts">
	import { cn } from '@epicenter/ui/utils';

	// The pill's live mic meter: a fixed bank of bars whose lengths ride the
	// smoothed `level`. The pill styles the bars (thickness, color) and the
	// container (breadth, gap); the defaults render its 3px white bar, and a VAD
	// session tints the bars via `barClass` when speech latches.
	//
	// The bars grow across the pill, so a pill lying on its side grows them
	// sideways: `vertical` swaps the axis the bank runs along and the axis the
	// bars extend on. Nothing else about the meter changes.
	let {
		level,
		minPx = 3,
		maxPx = 18,
		vertical = false,
		barClass,
		class: className,
	}: {
		/** Smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Bar length floor (silent) and ceiling (loud), in px. */
		minPx?: number;
		maxPx?: number;
		/** Stack the bars down a vertical bar and grow them sideways. */
		vertical?: boolean;
		/** Per-bar classes: thickness and color. */
		barClass?: string;
		/** Container classes: breadth and gap. */
		class?: string;
	} = $props();

	// Per-bar length envelope (longer in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const ENVELOPE = [
		0.35, 0.5, 0.68, 0.84, 0.95, 1, 0.95, 0.84, 0.68, 0.5, 0.35,
	];

	function barLength(envelope: number): number {
		return minPx + envelope * level * (maxPx - minPx);
	}
</script>

<div
	class={cn(
		'flex items-center gap-[3px]',
		vertical && 'flex-col justify-center',
		className,
	)}
	aria-hidden="true"
>
	{#each ENVELOPE as envelope, i (i)}
		<!-- Length is set inline from the live mic level; the transition glides
		     between samples (~20-30 Hz) so the meter looks continuous, and is
		     dropped under reduced motion. -->
		<span
			class={cn(
				'rounded-full bg-white/80 ease-linear motion-reduce:transition-none',
				vertical
					? 'h-[3px] transition-[width] duration-[80ms]'
					: 'w-[3px] transition-[height] duration-[80ms]',
				barClass,
			)}
			style={vertical
				? `width: ${barLength(envelope)}px`
				: `height: ${barLength(envelope)}px`}
		></span>
	{/each}
</div>
