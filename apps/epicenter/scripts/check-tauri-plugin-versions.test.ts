import { describe, expect, test } from 'bun:test';
import {
	collectPairs,
	findMismatches,
	parseCargoLockPlugins,
} from './check-tauri-plugin-versions.ts';

describe('parseCargoLockPlugins', () => {
	test('reads every tauri-plugin crate and strips the prefix', () => {
		const lock = `
[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "tauri-plugin-http"
version = "2.5.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-plugin-clipboard-manager"
version = "2.3.2"
`;
		expect([...parseCargoLockPlugins(lock)]).toEqual([
			['http', '2.5.9'],
			['clipboard-manager', '2.3.2'],
		]);
	});

	test('ignores non-plugin crates, including tauri itself', () => {
		const lock = `
[[package]]
name = "tauri"
version = "2.11.5"

[[package]]
name = "tauri-utils"
version = "2.9.0"
`;
		expect(parseCargoLockPlugins(lock).size).toBe(0);
	});
});

describe('findMismatches', () => {
	test('flags a pair whose halves disagree, even by one patch', () => {
		expect(
			findMismatches([
				{ plugin: 'http', rust: '2.5.9', js: '2.5.4' },
				{ plugin: 'os', rust: '2.3.2', js: '2.3.2' },
			]),
		).toEqual([{ plugin: 'http', rust: '2.5.9', js: '2.5.4' }]);
	});
});

describe('the repository as it stands', () => {
	test('every Tauri plugin ships matching Rust and JS halves', async () => {
		const pairs = await collectPairs();
		// Guards the real defect this check was written for: a mismatched pair does
		// not error, it silently drops IPC payloads (see the module docs).
		expect(pairs.length).toBeGreaterThan(0);
		expect(findMismatches(pairs)).toEqual([]);
	});
});
