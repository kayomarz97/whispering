import { tryAsync } from 'wellcrafted/result';
import { commands } from '$lib/tauri/commands';
import {
	artifactExtensionForMimeType,
	sniffAudioMimeType,
} from './audio-container';
import { BlobError, type BlobStore } from './types';

/**
 * Recording artifacts are owned by Rust and addressed only by recording id. The
 * WebView passes bytes and an id across a focused command; it never sees, or
 * names, a filesystem path.
 *
 * The cpal recorder writes its own WAV inside Rust. This store covers the
 * producers that arrive with a finished container instead of PCM — the VAD
 * recorder's MediaRecorder blobs and file import — which is what makes
 * voice-activated capture (and the live transcription built on it) work at all
 * on desktop.
 */
export function createFileSystemBlobStore() {
	const urlCache = new Map<string, string>();

	return {
		async save(key, blob) {
			return tryAsync({
				try: async () => {
					// The container is preserved rather than transcoded, so the
					// extension has to come from the blob: it is how the artifact is
					// later recognized, and how the cloud wire is told what it is.
					const { error } = await commands.saveRecordingArtifact(
						key,
						artifactExtensionForMimeType(blob.type),
						await blob.arrayBuffer(),
					);
					if (error !== null) throw new Error(error);
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async delete(idOrIds) {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: async () => {
					const { error } = await commands.deleteRecordingArtifacts(ids);
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async getBlob(key) {
			return tryAsync({
				try: async () => {
					const { data, error } = await commands.readRecordingArtifact(key);
					if (error !== null) throw new Error(error);
					// The container is read from the bytes rather than assumed: this
					// blob's type decides the upload filename's extension, which is how
					// the transcription wire detects the audio format. Labelling a WebM
					// artifact `audio/wav` uploads it as `audio.wav` and the provider
					// rejects it.
					return new Blob([data], { type: sniffAudioMimeType(data) });
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		async ensurePlaybackUrl(key) {
			return tryAsync({
				try: async () => {
					const cachedUrl = urlCache.get(key);
					if (cachedUrl) return cachedUrl;

					const { data: blob, error } = await this.getBlob(key);
					if (error !== null) throw error;

					const url = URL.createObjectURL(blob);
					urlCache.set(key, url);
					return url;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl(key) {
			const url = urlCache.get(key);
			if (!url) return;
			URL.revokeObjectURL(url);
			urlCache.delete(key);
		},

		async clear() {
			for (const url of urlCache.values()) URL.revokeObjectURL(url);
			urlCache.clear();
			return tryAsync({
				try: async () => {
					const { error } = await commands.clearRecordingArtifacts();
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	} satisfies BlobStore;
}
