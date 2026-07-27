/**
 * Tauri plugins ship as two halves — a Rust crate and a JS package — that talk
 * over a private IPC protocol. That protocol is not a stable API: it changes
 * between releases, including inside a patch line, and a mismatched pair does
 * NOT error. It silently misbehaves.
 *
 * This is not hypothetical. `tauri-plugin-http` 2.5.4 (JS) streamed a response
 * body over a Tauri channel; 2.5.9 (Rust) instead returns it chunk-by-chunk from
 * repeated `fetch_read_body` calls. Pairing those two halves left every
 * `await response.json()` pending forever, which took down cloud transcription
 * with no error message anywhere: the request succeeded, the answer arrived, and
 * the frontend dropped it and waited.
 *
 * So the halves must be pinned to the same version, and this check exists to
 * fail loudly the moment they drift instead of letting a feature die quietly.
 * The Rust side is read from `Cargo.lock` (what actually compiles) and the JS
 * side is resolved from `node_modules` (what actually bundles), so the check
 * compares shipped reality rather than declared ranges.
 */

import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TAURI_DIR = join(HERE, '..', 'src-tauri');
/** The surface bundled into this host, and therefore the JS half that ships. */
const JS_CONSUMER_DIR = join(HERE, '..', '..', 'whispering');

export type VersionPair = {
	plugin: string;
	rust: string;
	js: string;
};

/**
 * Every `tauri-plugin-*` crate and its resolved version, read from a Cargo.lock
 * body. Package blocks are `[[package]]` stanzas with `name` and `version` keys.
 */
export function parseCargoLockPlugins(lock: string): Map<string, string> {
	const versions = new Map<string, string>();
	for (const block of lock.split('[[package]]')) {
		const name = block.match(/^\s*name\s*=\s*"(tauri-plugin-[a-z0-9-]+)"/m)?.[1];
		if (!name) continue;
		const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
		if (!version) continue;
		versions.set(name.replace('tauri-plugin-', ''), version);
	}
	return versions;
}

/** The JS half's installed version, or undefined when this plugin has no JS half. */
function resolveJsVersion(plugin: string, fromDir: string): string | undefined {
	try {
		const manifest = Bun.resolveSync(
			`@tauri-apps/plugin-${plugin}/package.json`,
			fromDir,
		);
		return JSON.parse(require('node:fs').readFileSync(manifest, 'utf8')).version;
	} catch {
		return undefined;
	}
}

/** Pairs where both halves ship, and the subset whose versions disagree. */
export function findMismatches(pairs: VersionPair[]): VersionPair[] {
	return pairs.filter((pair) => pair.rust !== pair.js);
}

export async function collectPairs(): Promise<VersionPair[]> {
	const lock = await Bun.file(join(TAURI_DIR, 'Cargo.lock')).text();
	const pairs: VersionPair[] = [];
	for (const [plugin, rust] of parseCargoLockPlugins(lock)) {
		const js = resolveJsVersion(plugin, JS_CONSUMER_DIR);
		// A Rust-only plugin (updater, process, single-instance, autostart…) is
		// driven entirely from Rust and has no JS half to drift from.
		if (js === undefined) continue;
		pairs.push({ plugin, rust, js });
	}
	return pairs;
}

if (import.meta.main) {
	const pairs = await collectPairs();
	const mismatches = findMismatches(pairs);
	for (const { plugin, rust, js } of pairs) {
		const mark = rust === js ? 'ok  ' : 'DRIFT';
		console.log(`${mark} ${plugin.padEnd(20)} rust ${rust.padEnd(10)} js ${js}`);
	}
	if (mismatches.length > 0) {
		console.error(
			`\n${mismatches.length} Tauri plugin(s) have mismatched Rust and JS halves.\n` +
				'Pin both to the same version (Cargo.toml + the JS package.json / catalog).\n' +
				'A mismatched pair does not error — it silently breaks the feature.',
		);
		process.exit(1);
	}
	console.log(`\nAll ${pairs.length} Tauri plugin pairs are in lockstep.`);
}
