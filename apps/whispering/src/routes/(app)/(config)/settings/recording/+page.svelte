<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { SettingSelect, SettingSwitch } from '$lib/components/settings';
	import {
		BITRATE_OPTIONS,
		RECORDING_TRIGGER_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { report } from '$lib/report';
	import { asDeviceIdentifier } from '@epicenter/recorder';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { os } from '#platform/os';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import { tauri } from '#platform/tauri';
	import { whispering } from '#platform/whispering';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	const exportRecordings = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'export'],
			mutationFn: whispering.actions.recordings_export_markdown,
		}),
	);

	// Second-based tuning for live (pause-triggered) transcription. Values must
	// stay within the schema ranges in workspace/definition.ts
	// (pauseSeconds 0.3-3, minSpeechSeconds 0.1-2).
	const PAUSE_SECONDS_OPTIONS = [
		{ value: 0.5, label: '0.5 seconds (snappy)' },
		{ value: 0.8, label: '0.8 seconds (recommended)' },
		{ value: 1, label: '1 second' },
		{ value: 1.5, label: '1.5 seconds' },
		{ value: 2, label: '2 seconds (relaxed)' },
	];
	const MIN_SPEECH_OPTIONS = [
		{ value: 0.2, label: '0.2 seconds' },
		{ value: 0.3, label: '0.3 seconds (recommended)' },
		{ value: 0.5, label: '0.5 seconds' },
		{ value: 0.8, label: '0.8 seconds' },
	];

	// How long a voice activated session may sit in silence before it disarms
	// itself, and how long the overlay's transcript card stays up after the last
	// phrase. Both are "0 = never" (schema ranges: 0-300 and 0-60).
	const VAD_SILENCE_TIMEOUT_OPTIONS = [
		{ value: 5, label: '5 seconds' },
		{ value: 10, label: '10 seconds (recommended)' },
		{ value: 20, label: '20 seconds' },
		{ value: 30, label: '30 seconds' },
		{ value: 60, label: '1 minute' },
		{ value: 0, label: "Never — keep listening until I stop it" },
	];
	const OVERLAY_HIDE_OPTIONS = [
		{ value: 2, label: '2 seconds' },
		{ value: 3, label: '3 seconds (recommended)' },
		{ value: 5, label: '5 seconds' },
		{ value: 10, label: '10 seconds' },
		{ value: 0, label: 'Never — leave it up until I hide it' },
	];
</script>

<svelte:head> <title>Recording Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Recording</Field.Legend>
	<Field.Description>
		Configure your Whispering recording preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<SettingSelect
			store={settings}
			key="recording.trigger"
			label="Recording Trigger"
			items={RECORDING_TRIGGER_OPTIONS}
			description="Choose how recording starts: {RECORDING_TRIGGER_OPTIONS.map(
				(option) => option.label.toLowerCase(),
			).join(', ')}"
		/>

		<SettingSwitch
			key="recording.pausePlayback"
			label="Pause playback while recording"
			description="Whispering pauses media playing on your computer (music, video, browser tabs) while your voice is being captured, then tries to resume it after. In voice activated mode it pauses only while you actually speak, so music keeps playing between phrases. Works with most apps in your system media controls. A few can't be paused, and on macOS the resume can occasionally wake a different app that was already paused."
		/>

		{#if settings.get('recording.trigger') === 'manual'}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = manualRecorderConfig.deviceId;
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => (manualRecorderConfig.deviceId = selected)}
			/>
		{:else if settings.get('recording.trigger') === 'vad'}
			{#if os.isLinux}
				<Alert.Root variant="destructive">
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated not supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) requires the browser's Navigator
						API, which is not fully supported in Tauri on Linux. Device
						enumeration and recording will fail. Please use Manual recording
						instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#if tauri && os.isApple}
					<Alert.Root variant="warning">
						<InfoIcon class="size-4" />
						<Alert.Title>
							Global Shortcuts May Be Unreliable
						</Alert.Title>
						<Alert.Description>
							VAD uses browser-owned capture. macOS App Nap may delay browser
							recording logic when Whispering is not in focus.
						</Alert.Description>
					</Alert.Root>
				{/if}
				<Alert.Root>
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated Detection
					</Alert.Title>
					<Alert.Description>
						VAD uses the browser's Web Audio API for real-time voice detection.
						Captured speech is encoded to uncompressed WAV format.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<VadSelectRecordingDevice
				bind:selected={() => {
					const selected = deviceConfig.get('recording.navigator.deviceId');
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) =>
						deviceConfig.set('recording.navigator.deviceId', selected)}
			/>

			<SettingSelect
				store={settings}
				key="recording.vadSilenceTimeoutSeconds"
				label="Stop listening after silence"
				items={VAD_SILENCE_TIMEOUT_OPTIONS}
				description="Voice Activated listening switches itself off after this much silence, so a session you forgot about does not sit open holding the microphone (and does not start transcribing a film, a call, or the room). Only silence counts: every phrase you speak restarts the clock, so it cannot cut you off mid-dictation. Press your voice capture shortcut to start listening again."
			/>
		{/if}

		{#if settings.get('recording.trigger') === 'manual'}
			{#if !tauri}
				<SettingSelect
					store={deviceConfig}
					key="recording.navigator.bitrateKbps"
					label="Bitrate"
					items={BITRATE_OPTIONS}
					description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
				/>
			{:else}
				<SettingSelect
					store={deviceConfig}
					key="recording.cpal.sampleRate"
					label="Sample Rate"
					items={SAMPLE_RATE_OPTIONS}
					description="Higher sample rates provide better quality but create larger files"
				/>
			{/if}
		{/if}

		{#if tauri}
			<SettingSwitch
				key="overlay.idleHandle"
				label="Keep a small handle on screen"
				description="Between dictations the overlay rests as a small line in the corner instead of disappearing. Click it to start dictating, or drag it to move it — it stays put even when you close Whispering to the tray, so you never have to find the app first. Turn this off if you would rather see nothing until you press your shortcut."
			/>

			<Field.Field>
				<Field.Label>Recording overlay position</Field.Label>
				<Button
					variant="outline"
					class="w-fit"
					onclick={() => tauri?.recordingOverlay.resetPosition()}
				>
					Move overlay back to the corner
				</Button>
				<Field.Description>
					Drag the overlay by its handle, its pill, or the transcript above it to
					put it anywhere on screen; it stays there, on this computer, until you
					move it again. This puts it back in the bottom-right corner — useful if
					you moved it onto a screen you no longer have.
				</Field.Description>
			</Field.Field>
		{/if}

		<Field.Field>
			<Field.Label>Export recordings</Field.Label>
			<Button
				variant="outline"
				class="w-fit"
				onclick={() => {
					exportRecordings.mutate(undefined, {
						onSuccess: (data) => {
							if (data.written === 0) {
								report.info({
									title: 'Nothing to export',
									description: 'You have no recordings yet.',
								});
								return;
							}
							report.success({
								title: 'Recordings exported',
								description: `Saved ${data.written} ${data.written === 1 ? 'recording' : 'recordings'} as a zip file.`,
							});
						},
						onError: (error) => {
							// Cancelling the Save dialog is not a failure.
							if (error.name === 'SaveCancelled') return;
							report.error({
								title: 'Export failed',
								cause: error,
							});
						},
					});
				}}
				disabled={exportRecordings.isPending}
			>
				{exportRecordings.isPending ? 'Exporting...' : 'Export recordings (.zip)'}
			</Button>
			<Field.Description>
				Download every recording as a zip of Markdown files. This is a
				snapshot: later edits in Whispering do not change the downloaded file.
			</Field.Description>
		</Field.Field>
	</Field.Group>
</Field.Set>

<Field.Set>
	<Field.Legend>Live transcription</Field.Legend>
	<Field.Description>
		Show your words in the recording overlay as you speak, instead of only after
		you stop. This uses Voice Activated recording: each time you pause, the phrase
		you just spoke is transcribed and added to the overlay.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<SettingSwitch
			key="liveTranscription.enabled"
			label="Enable live transcription"
			description="When on, each phrase is transcribed the moment you pause and appears live in the recording overlay. The full transcript is still produced when you stop, so final accuracy is unchanged."
		/>

		{#if settings.get('liveTranscription.enabled')}
			<Alert.Root>
				<InfoIcon class="size-4" />
				<Alert.Title>How it works</Alert.Title>
				<Alert.Description>
					You speak, and the moment you pause for the "pause length" below, that
					phrase is sent to your transcription provider and appears in the corner
					overlay, building up as you talk. A longer pause gives fewer, more
					complete phrases; a shorter pause is snappier but choppier. This needs
					the Recording Trigger above set to Voice Activated.
				</Alert.Description>
			</Alert.Root>

			{#if settings.get('recording.trigger') !== 'vad'}
				<Alert.Root variant="warning">
					<InfoIcon class="size-4" />
					<Alert.Title>Set the trigger to Voice Activated</Alert.Title>
					<Alert.Description>
						Live transcription needs pause detection, which only Voice Activated
						recording provides. Change the Recording Trigger above to Voice
						Activated to use it.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<SettingSelect
				store={settings}
				key="liveTranscription.pauseSeconds"
				label="Pause length"
				items={PAUSE_SECONDS_OPTIONS}
				description="How long a silence counts as a pause that ends a phrase and sends it for transcription."
			/>
			<SettingSelect
				store={settings}
				key="liveTranscription.minSpeechSeconds"
				label="Shortest phrase"
				items={MIN_SPEECH_OPTIONS}
				description="Phrases shorter than this are ignored, so silences and short blips do not each trigger a transcription (which your provider may bill at a minimum length)."
			/>
			<SettingSelect
				store={settings}
				key="liveTranscription.overlayHideSeconds"
				label="Hide the transcript after"
				items={OVERLAY_HIDE_OPTIONS}
				description="The transcript folds itself away this long after your last phrase, leaving just the small pill so it stops covering what is behind it. The next thing you say brings it straight back. You can also fold and unfold it yourself with the chevron on the transcript."
			/>
		{/if}
	</Field.Group>
</Field.Set>
