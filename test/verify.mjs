/**
 * Mechanism test for the terminal-font client half.
 *
 * It boots `client.js` in a fake browser: a fake module loader, a fake React
 * module, a fake ResizeObserver, and a fake xterm instance assigned exactly the
 * way the shipped terminal chunk assigns it (`React.useRef()` + `.current =`).
 * The assertions cover the three things that can silently break:
 *
 * 1. the loader hook wraps the terminal chunk's factory,
 * 2. the React `useRef` spy captures the xterm instance and applies the font,
 * 3. the ResizeObserver hook replays the terminal's own fit callback.
 *
 * Run: node test/verify.mjs
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const DSH_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TERMINAL_PLUGIN = '@deepseek-ai/dsh-client-ui-sidebar-terminal';
const CHUNK = 'client.terminal.js';
const KEY = 'dsh-terminal-font.settings.v1';

let failures = 0;
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail === void 0 ? '' : ` — ${detail}`}`);
}

function makeReact() {
	return {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		useRef: (initial) => ({ current: initial }),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useId: () => 'dtf-id',
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		version: '18.2.0'
	};
}

/** Boot the client bundle over a fake browser and return its harness handles. */
function boot(stored) {
	const styleTags = [];
	let xtermNodes = [];
	const document = {
		createElement: () => ({
			dataset: {},
			textContent: '',
			remove() {
				const at = styleTags.indexOf(this);
				if (at >= 0) styleTags.splice(at, 1);
			}
		}),
		head: { appendChild: (node) => styleTags.push(node) },
		querySelector: () => null,
		querySelectorAll: (selector) => (selector === '.xterm' ? xtermNodes : [])
	};
	const storage = new Map();
	if (stored !== void 0) storage.set(KEY, JSON.stringify(stored));
	const localStorage = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key)
	};
	const frames = [];
	const requestAnimationFrame = (callback) => frames.push(callback);
	const timers = [];
	const registrations = [];
	const loader = { mode: 'live', load: (registration) => registrations.push(registration) };

	globalThis.window = globalThis;
	globalThis.__ModuleLoader__ = loader;
	globalThis.document = document;
	globalThis.localStorage = localStorage;
	globalThis.requestAnimationFrame = requestAnimationFrame;
	globalThis.setTimeout = (callback) => {
		timers.push(callback);
		return timers.length;
	};
	globalThis.clearTimeout = () => {};

	const observed = [];
	class FakeResizeObserver {
		constructor(callback) {
			this.callback = callback;
		}
		observe(target) {
			observed.push(target);
		}
		unobserve() {}
		disconnect() {}
	}
	globalThis.ResizeObserver = FakeResizeObserver;

	const run = new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'console', source);
	run(globalThis, document, localStorage, requestAnimationFrame, console);

	const registration = registrations.find((entry) => entry.id === 'dsh-terminal-font');
	const react = makeReact();
	const plugin = registration.factory((specifier) => {
		if (specifier === 'react') return react;
		throw new Error(`unexpected plugin require ${specifier}`);
	});

	const sections = [];
	const ctx = {
		effect: (fn) => fn(),
		locale: { bind: () => (key) => key, register: () => () => {} },
		slots: {
			inject: (_owner, callback) => callback(),
			register: (options, component) => {
				sections.push({ options, component });
				return () => {};
			}
		}
	};
	plugin.apply(ctx);

	return {
		loader,
		registrations,
		sections,
		storage,
		react,
		observed,
		runFrames() {
			const batch = [...frames];
			frames.length = 0;
			for (const frame of batch) frame();
		},
		runTimers() {
			const batch = [...timers];
			timers.length = 0;
			for (const timer of batch) timer();
		},
		/** Make the DOM report these `.xterm` elements to the fiber fallback. */
		setXtermNodes(nodes) {
			xtermNodes = nodes;
		},
		/** Register the shipped terminal chunk the way the loader reports it, then materialize it. */
		runChunk(body) {
			const index = registrations.length;
			loader.load({ id: TERMINAL_PLUGIN, chunk: CHUNK, factory: body });
			const captured = registrations[index];
			return captured ? captured.factory((specifier) => {
				if (specifier === 'react') return react;
				if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
				if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {};
				throw new Error(`unexpected chunk require ${specifier}`);
			}) : void 0;
		}
	};
}

console.log('registration');
{
	const app = boot({ enabled: true, fontFamily: '', fontSize: 0 });
	check('client module registers dsh-terminal-font', app.registrations.some((entry) => entry.id === 'dsh-terminal-font'));
	check(
		'settings section registered',
		app.sections.some((entry) => entry.options.name === 'settings.section' && entry.options.id === 'terminal-font'),
		JSON.stringify(app.sections.map((entry) => entry.options.id))
	);
	check('section label is localized through the thunk', typeof app.sections[0]?.options.label === 'function' && app.sections[0].options.label() === 'nav');
}

console.log('\nchunk wrapping and capture');
{
	const app = boot({ enabled: true, fontFamily: '', fontSize: 0 });
	let measureCalls = 0;
	let xterm;
	const exportsOfChunk = app.runChunk((require) => {
		const React = require('react');
		xterm = { options: { fontFamily: DSH_STACK, fontSize: 13 }, write() {}, resize() {} };
		const screen = { parentElement: null };
		xterm.element = { parentElement: screen };
		const observer = new ResizeObserver(() => {
			measureCalls += 1;
		});
		observer.observe(screen);
		React.useRef(null).current = screen;
		const terminal = React.useRef();
		terminal.current = xterm;
		React.useRef().current = { proposeDimensions: () => ({ cols: 80, rows: 24 }), fit() {}, _terminal: xterm };
		return { TerminalBody: () => null };
	});
	check('chunk materialized through the hook', exportsOfChunk !== null && exportsOfChunk !== void 0 && typeof exportsOfChunk.TerminalBody === 'function');
	check('ResizeObserver was observed', app.observed.length === 1, String(app.observed.length));
	check('Nerd Font family applied to the xterm instance', String(xterm.options.fontFamily).includes('Nerd Font Mono'), String(xterm.options.fontFamily));
	check('default size preserved', xterm.options.fontSize === 13, String(xterm.options.fontSize));
	app.runFrames();
	check('terminal fit callback replayed after the font change', measureCalls > 0, `measureCalls=${measureCalls}`);
}

console.log('\nconfigured family and size');
{
	const app = boot({ enabled: true, fontFamily: 'Hack Nerd Font Mono', fontSize: 16 });
	let xterm;
	app.runChunk((require) => {
		const React = require('react');
		xterm = { options: { fontFamily: DSH_STACK, fontSize: 13 }, write() {}, resize() {} };
		xterm.element = { parentElement: { parentElement: null } };
		React.useRef().current = xterm;
		return { TerminalBody: () => null };
	});
	check('configured family leads the stack', String(xterm.options.fontFamily).startsWith('"Hack Nerd Font Mono"'), String(xterm.options.fontFamily));
	check('configured size is applied', xterm.options.fontSize === 16, String(xterm.options.fontSize));
}

console.log('\ndisabled');
{
	const app = boot({ enabled: false, fontFamily: 'Hack Nerd Font Mono', fontSize: 20 });
	let xterm;
	app.runChunk((require) => {
		const React = require('react');
		xterm = { options: { fontFamily: '"Other Font", serif', fontSize: 9 }, write() {}, resize() {} };
		xterm.element = { parentElement: { parentElement: null } };
		React.useRef().current = xterm;
		return { TerminalBody: () => null };
	});
	check('disabled restores the terminal’s own font stack', xterm.options.fontFamily === '"Other Font", serif', String(xterm.options.fontFamily));
	check('disabled restores the terminal’s own size', xterm.options.fontSize === 9, String(xterm.options.fontSize));
}

console.log('\nadopts a terminal that mounted before the plugin');
{
	const app = boot({ enabled: true, fontFamily: 'Hack Nerd Font Mono', fontSize: 16 });
	const resizes = [];
	let fitCalls = 0;
	const xterm = {
		options: { fontFamily: DSH_STACK, fontSize: 13 },
		write() {},
		resize: (cols, rows) => resizes.push(['xterm', cols, rows])
	};
	xterm.element = { parentElement: { parentElement: null } };
	const addon = {
		proposeDimensions: () => ({ cols: 100, rows: 30 }),
		fit: () => {
			fitCalls += 1;
		},
		_terminal: xterm
	};
	// The shape the built terminal leaves behind: a host-div fiber whose parent is
	// TerminalScreen, whose hooks are [useState, ref -> xterm, ref -> FitAddon].
	const hooks = {
		memoizedState: { memoizedState: 0, queue: {} },
		next: { memoizedState: { current: xterm }, next: { memoizedState: { current: addon }, next: null } }
	};
	const screen = {
		memoizedState: hooks,
		memoizedProps: { state: { environment: { maxCols: 80, maxRows: 24 } }, model: { resize: (cols, rows) => resizes.push(['model', cols, rows]) } },
		return: { memoizedState: null, memoizedProps: null, return: null }
	};
	const host = { memoizedState: null, memoizedProps: { className: 'screen' }, return: screen };
	const screenNode = { parentElement: null, __reactFiber$test: host };
	app.setXtermNodes([{ parentElement: screenNode }]);
	app.runTimers();
	check('pre-existing terminal adopted through the fiber fallback', String(xterm.options.fontFamily).startsWith('"Hack Nerd Font Mono"'), String(xterm.options.fontFamily));
	check('fallback applies the configured size too', xterm.options.fontSize === 16, String(xterm.options.fontSize));
	app.runFrames();
	check(
		'fallback refits xterm and the PTY through the fiber props',
		resizes.some((entry) => entry[0] === 'xterm' && entry[1] === 80 && entry[2] === 24) &&
			resizes.some((entry) => entry[0] === 'model' && entry[1] === 80 && entry[2] === 24),
		JSON.stringify(resizes)
	);
	check('the grid-only fallback was not used', fitCalls === 0, `fitCalls=${fitCalls}`);
}

console.log('\npasses unrelated registrations through untouched');
{
	const app = boot({ enabled: true, fontFamily: '', fontSize: 0 });
	const other = { id: 'some-other-plugin', factory: () => ({}) };
	const otherChunk = { id: TERMINAL_PLUGIN, chunk: 'client.pdf.js', factory: () => ({}) };
	app.loader.load(other);
	app.loader.load(otherChunk);
	const stored = app.registrations.slice(-2);
	check('a foreign bundle keeps its registration object', stored[0] === other);
	check('a foreign chunk of the same package keeps its registration object', stored[1] === otherChunk);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
