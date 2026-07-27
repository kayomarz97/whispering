/**
 * Audio container identification, shared by the desktop blob store's write and
 * read halves.
 *
 * Both halves care about the container for the same downstream reason: the
 * cloud transcription wire detects the audio format from the upload's filename
 * extension, which `@epicenter/client` derives from the blob's MIME type. A blob
 * that claims `audio/wav` while holding WebM is uploaded as `audio.wav` and
 * rejected, so the container a recording was saved in has to survive the round
 * trip through the filesystem.
 */

/** Containers Rust may store an artifact under, keyed by extension. */
const MIME_BY_EXTENSION = {
	wav: 'audio/wav',
	webm: 'audio/webm',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	mp3: 'audio/mpeg',
	mp4: 'audio/mp4',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	flac: 'audio/flac',
} as const satisfies Record<string, string>;

/** The extension to store a blob under, from its MIME type. */
const EXTENSION_BY_MIME: Record<string, string> = {
	'audio/wav': 'wav',
	'audio/wave': 'wav',
	'audio/x-wav': 'wav',
	'audio/webm': 'webm',
	'video/webm': 'webm',
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/m4a': 'm4a',
	'audio/aac': 'aac',
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
};

/**
 * The filename extension to persist a blob under.
 *
 * MediaRecorder reports its type with codec parameters attached
 * (`audio/webm;codecs=opus`), so the parameters are stripped before lookup. An
 * unrecognized or absent type falls back to `webm`, what every Chromium-family
 * WebView (and therefore the VAD recorder on desktop) actually produces.
 */
export function artifactExtensionForMimeType(mimeType: string): string {
	const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
	return EXTENSION_BY_MIME[base] ?? 'webm';
}

/**
 * The MIME type of a stored artifact, read from its own leading bytes.
 *
 * Sniffing beats trusting the extension here because it is also right for
 * artifacts written before this path existed, and because the bytes are already
 * in hand — no extra IPC round trip to ask Rust what it stored. Every container
 * below carries a fixed magic number at a known offset.
 */
export function sniffAudioMimeType(bytes: ArrayBuffer): string {
	const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16));
	const startsWith = (...signature: number[]) =>
		signature.every((byte, i) => head[i] === byte);
	const ascii = (offset: number, text: string) =>
		[...text].every((c, i) => head[offset + i] === c.charCodeAt(0));

	// RIFF....WAVE
	if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return MIME_BY_EXTENSION.wav;
	// EBML header: WebM and Matroska share it; only WebM is plausible here.
	if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return MIME_BY_EXTENSION.webm;
	if (ascii(0, 'OggS')) return MIME_BY_EXTENSION.ogg;
	// ISO base media (MP4/M4A): a `ftyp` box at offset 4.
	if (ascii(4, 'ftyp')) return MIME_BY_EXTENSION.mp4;
	if (ascii(0, 'fLaC')) return MIME_BY_EXTENSION.flac;
	if (ascii(0, 'ID3')) return MIME_BY_EXTENSION.mp3;
	// MPEG audio frame sync (11 set bits), covering an MP3 with no ID3 tag.
	if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) {
		return MIME_BY_EXTENSION.mp3;
	}

	// Unknown container: the cpal recorder writes WAV, so it is the honest
	// default for anything this app produced that is not one of the above.
	return MIME_BY_EXTENSION.wav;
}
