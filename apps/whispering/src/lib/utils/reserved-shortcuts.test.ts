/** Reserved global-chord policy and the shipped-default contract. */
import { expect, test } from 'bun:test';
import { validateGlobalBinding } from './reserved-shortcuts';

test('an empty binding is treated as unset and passes', () => {
	expect(validateGlobalBinding({ modifiers: [], keys: [] })).toBeNull();
});

test('shipped defaults pass the policy', () => {
	const shippedChords = [
		{ modifiers: ['meta', 'shift'], keys: ['space'] },
		{ modifiers: ['meta'], keys: ['dot'] },
		{ modifiers: ['ctrl', 'shift'], keys: ['space'] },
		{ modifiers: ['ctrl', 'shift'], keys: ['dot'] },
	] as const;
	for (const binding of shippedChords) {
		expect(validateGlobalBinding(binding)).toBeNull();
	}
});

test('Fn and modifier-only holds are refused', () => {
	expect(validateGlobalBinding({ modifiers: ['fn'], keys: [] })).toContain(
		'Only a chord',
	);
	expect(
		validateGlobalBinding({ modifiers: ['ctrl', 'meta'], keys: [] }),
	).toContain('Only a chord');
});

test('a reserved combo is refused with its label', () => {
	const reason = validateGlobalBinding({ modifiers: ['meta'], keys: ['keyR'] });
	expect(reason).toContain('Reload');
});

test('primary expands to control as well as command', () => {
	// Ctrl+R must be blocked too, not just Cmd+R, from the single `primary` entry.
	expect(
		validateGlobalBinding({ modifiers: ['ctrl'], keys: ['keyR'] }),
	).toContain('Reload');
});

test('literal meta+space (Spotlight) is reserved but meta+shift+space is not', () => {
	expect(
		validateGlobalBinding({ modifiers: ['meta'], keys: ['space'] }),
	).toContain('System search');
	// Adding Shift makes it a different set from the reserved Cmd+Space, so it
	// stays allowed (e.g. a user-bound Cmd+Shift+Space).
	expect(
		validateGlobalBinding({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBeNull();
});

test('a bare key with no modifier is refused', () => {
	const reason = validateGlobalBinding({ modifiers: [], keys: ['space'] });
	expect(reason).toContain('modifier');
});

test('a superset of a reserved chord is allowed (exact-set matching)', () => {
	// Ctrl+Shift+F is not the literal Ctrl+F "Find" chord.
	expect(
		validateGlobalBinding({ modifiers: ['ctrl', 'shift'], keys: ['keyF'] }),
	).toBeNull();
});

// Windows claims a swathe of chords before any application sees them, and
// `RegisterHotKey` then refuses them. Registration is replace-all with rollback,
// so one of these does not merely fail to bind — it fails the whole batch and
// leaves every other gesture unchanged, which reads as "the app is broken".
// These are refused at record time instead, naming what owns them. Each was
// confirmed against `RegisterHotKey` on Windows 11.
test('chords the Windows shell owns are refused by name', () => {
	const cases: [Parameters<typeof validateGlobalBinding>[0], string][] = [
		[{ modifiers: ['ctrl', 'meta'], keys: ['keyD'] }, 'virtual desktop'],
		[{ modifiers: ['ctrl', 'meta'], keys: ['space'] }, 'input method'],
		[{ modifiers: ['ctrl', 'meta'], keys: ['leftArrow'] }, 'virtual desktop'],
		[{ modifiers: ['ctrl', 'meta'], keys: ['f4'] }, 'virtual desktop'],
		[{ modifiers: ['meta'], keys: ['keyL'] }, 'Lock'],
		[{ modifiers: ['ctrl', 'shift'], keys: ['escape'] }, 'Task Manager'],
	];
	for (const [binding, expected] of cases) {
		expect(validateGlobalBinding(binding)).toContain(expected);
	}
});

test('the Ctrl+Win chords Windows leaves free stay bindable', () => {
	// Probed as available on Windows 11 while the ones above were taken; the
	// table must refuse what the OS owns without refusing the whole family.
	for (const key of ['keyX', 'keyZ', 'keyJ', 'keyK']) {
		expect(
			validateGlobalBinding({ modifiers: ['ctrl', 'meta'], keys: [key] }),
		).toBeNull();
	}
});

test('a plain Ctrl chord on a letter no app shortcut owns is allowed', () => {
	// The whole point of the policy: refuse what would be regretted (Ctrl+C,
	// Ctrl+S, Ctrl+Z) without blocking the letters left over for a dictation
	// gesture.
	for (const key of ['keyD', 'keyE', 'keyG', 'keyH', 'keyJ', 'keyK', 'keyM']) {
		expect(
			validateGlobalBinding({ modifiers: ['ctrl'], keys: [key] }),
		).toBeNull();
	}
});
