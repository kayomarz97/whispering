import { describe, expect, test } from 'bun:test';
import {
	artifactExtensionForMimeType,
	sniffAudioMimeType,
} from './audio-container';

const bytesOf = (...parts: (string | number[])[]): ArrayBuffer => {
	const flat: number[] = [];
	for (const part of parts) {
		if (typeof part === 'string') {
			for (const c of part) flat.push(c.charCodeAt(0));
		} else {
			flat.push(...part);
		}
	}
	// Pad so the sniffer always has its 16-byte window.
	while (flat.length < 16) flat.push(0);
	return new Uint8Array(flat).buffer;
};

describe('artifactExtensionForMimeType', () => {
	test('strips MediaRecorder codec parameters', () => {
		// What the VAD recorder actually reports in a Chromium WebView.
		expect(artifactExtensionForMimeType('audio/webm;codecs=opus')).toBe('webm');
		expect(artifactExtensionForMimeType('audio/ogg;codecs=opus')).toBe('ogg');
	});

	test('maps the containers the recorder and file import produce', () => {
		expect(artifactExtensionForMimeType('audio/wav')).toBe('wav');
		expect(artifactExtensionForMimeType('audio/x-wav')).toBe('wav');
		expect(artifactExtensionForMimeType('audio/mpeg')).toBe('mp3');
		expect(artifactExtensionForMimeType('audio/mp4')).toBe('m4a');
		expect(artifactExtensionForMimeType('audio/x-m4a')).toBe('m4a');
		expect(artifactExtensionForMimeType('audio/flac')).toBe('flac');
	});

	test('falls back to webm for an unknown or absent type', () => {
		expect(artifactExtensionForMimeType('')).toBe('webm');
		expect(artifactExtensionForMimeType('application/octet-stream')).toBe(
			'webm',
		);
	});

	test('only ever yields a short alphanumeric token', () => {
		// Rust rejects anything else outright, so a mapping that produced a dot or
		// a separator would fail every save rather than escaping the directory.
		for (const mime of [
			'audio/webm;codecs=opus',
			'audio/wav',
			'audio/mpeg',
			'',
			'nonsense/../..',
		]) {
			expect(artifactExtensionForMimeType(mime)).toMatch(/^[a-z0-9]{1,8}$/);
		}
	});
});

describe('sniffAudioMimeType', () => {
	test('identifies each container from its magic number', () => {
		expect(sniffAudioMimeType(bytesOf('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe(
			'audio/wav',
		);
		expect(sniffAudioMimeType(bytesOf([0x1a, 0x45, 0xdf, 0xa3]))).toBe(
			'audio/webm',
		);
		expect(sniffAudioMimeType(bytesOf('OggS'))).toBe('audio/ogg');
		expect(sniffAudioMimeType(bytesOf([0, 0, 0, 0x20], 'ftypM4A '))).toBe(
			'audio/mp4',
		);
		expect(sniffAudioMimeType(bytesOf('fLaC'))).toBe('audio/flac');
		expect(sniffAudioMimeType(bytesOf('ID3'))).toBe('audio/mpeg');
		expect(sniffAudioMimeType(bytesOf([0xff, 0xfb]))).toBe('audio/mpeg');
	});

	test('a VAD artifact is reported as WebM, not WAV', () => {
		// The regression this guards: the blob's type becomes the upload
		// filename's extension, and a WebM sent as `audio.wav` is rejected.
		const webm = bytesOf([0x1a, 0x45, 0xdf, 0xa3]);
		expect(sniffAudioMimeType(webm)).not.toBe('audio/wav');
	});

	test('falls back to wav, what the native recorder writes', () => {
		expect(sniffAudioMimeType(bytesOf([0x00, 0x01, 0x02, 0x03]))).toBe(
			'audio/wav',
		);
	});

	test('does not read past a short buffer', () => {
		expect(() => sniffAudioMimeType(new Uint8Array([0x52, 0x49]).buffer)).not.toThrow();
	});
});
