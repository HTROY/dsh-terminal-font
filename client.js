/**
 * Terminal font — client half.
 *
 * The shipped sidebar terminal builds its xterm instance with a hard-coded
 * `fontFamily` / `fontSize` and exposes no configuration seam, so glyphs that
 * only a Nerd Font carries (oh-my-posh separators, powerline, PUA icons) fall
 * back to a monospace font without them and render as boxes.
 *
 * This plugin adds a Settings page for the family and size and then applies the
 * chosen values to every terminal xterm instance:
 *
 * 1. `window.__ModuleLoader__.load` is wrapped so the lazy
 *    `@deepseek-ai/dsh-client-ui-sidebar-terminal/client.terminal.js` chunk gets a
 *    `require` whose `react` module hands the chunk a `useRef` proxy. The chunk
 *    stores its xterm instance and its FitAddon in refs, so capturing them at
 *    assignment time is the one seam that reaches the instance without patching
 *    any file on disk.
 * 2. `window.ResizeObserver` is wrapped so the terminal's own `measure` callback
 *    (which resizes both xterm and the PTY) can be replayed after a font change.
 *
 * Both wrappers are transparent, are installed from `apply`, and are removed by
 * their `ctx.effect` cleanup.
 */
window.__ModuleLoader__.load({
	id: 'dsh-terminal-font',
	factory(require) {
		/** The terminal plugin whose lazy chunk creates the xterm instance. */
		const TERMINAL_PLUGIN_ID = '@deepseek-ai/dsh-client-ui-sidebar-terminal';
		/** The package-local chunk that owns xterm. */
		const TERMINAL_CHUNK = 'client.terminal.js';
		/** Client preference key; the value lives where the font is used — this browser. */
		const STORAGE_KEY = 'dsh-terminal-font.settings.v1';
		/** The font stack the shipped terminal hard-codes. */
		const DSH_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
		/** The size the shipped terminal hard-codes. */
		const DSH_FONT_SIZE = 13;
		/** Locale namespace owned by this plugin. */
		const NS = 'terminal-font';
		/** Recommended stack, used while no explicit family is configured. */
		const RECOMMENDED_FONT_STACK =
			'"CaskaydiaCove Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "CaskaydiaMono Nerd Font Mono", ' +
			'"Hack Nerd Font Mono", "MesloLGS NF", ' +
			DSH_FONT_STACK;
		/** Font families offered as suggestions; any installed family name is accepted. */
		const FONT_SUGGESTIONS = [
			'CaskaydiaCove Nerd Font Mono',
			'CaskaydiaMono Nerd Font Mono',
			'JetBrainsMono Nerd Font Mono',
			'JetBrainsMonoNL Nerd Font Mono',
			'Hack Nerd Font Mono',
			'FiraCode Nerd Font Mono',
			'MesloLGS NF',
			'SauceCodePro Nerd Font Mono',
			'DejaVuSansM Nerd Font Mono',
			'SpaceMono Nerd Font Mono',
			'UbuntuMono Nerd Font Mono',
			'RobotoMono Nerd Font Mono',
			'VictorMono Nerd Font Mono',
			'Iosevka Nerd Font Mono',
			'Mononoki Nerd Font Mono',
			'Symbols Nerd Font Mono',
			'Cascadia Mono',
			'Consolas'
		];
		const FONT_SIZE_MIN = 10;
		const FONT_SIZE_MAX = 24;

		const React = require('react');

		/* ------------------------------------------------------------------ *
		 * Settings
		 * ------------------------------------------------------------------ */

		/** @returns {{enabled: boolean, fontFamily: string, fontSize: number}} */
		function readSettings() {
			const fallback = { enabled: true, fontFamily: '', fontSize: 0 };
			try {
				const raw = window.localStorage?.getItem(STORAGE_KEY);
				if (typeof raw !== 'string' || raw === '') return fallback;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== 'object') return fallback;
				return {
					enabled: parsed.enabled !== false,
					fontFamily: typeof parsed.fontFamily === 'string' ? parsed.fontFamily : '',
					fontSize: Number.isFinite(parsed.fontSize) ? Math.round(parsed.fontSize) : 0
				};
			} catch {
				return fallback;
			}
		}

		let settings = readSettings();
		let snapshot = Object.freeze({ ...settings });
		const listeners = new Set();

		const store = {
			getSnapshot: () => snapshot,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}
		};

		function publish(next) {
			settings = next;
			snapshot = Object.freeze({ ...next });
			try {
				window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				/* a browser that refuses storage keeps the live values for this session */
			}
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					console.warn('dsh-terminal-font: settings subscriber failed', error);
				}
			}
		}

		/** The xterm `fontFamily` the current settings ask for. */
		function resolvedFontFamily() {
			const chosen = settings.fontFamily.trim();
			if (chosen === '') return RECOMMENDED_FONT_STACK;
			return chosen.includes(',') ? chosen : `"${chosen}", ${DSH_FONT_STACK}`;
		}

		/* ------------------------------------------------------------------ *
		 * xterm instances
		 * ------------------------------------------------------------------ */

		/** Weak references to every live xterm instance so a settings change reaches open terminals. */
		const terminals = new Set();
		/** ResizeObserver callback of each observed element, so DSH's own refit path can be replayed. */
		const measuredNodes = new WeakMap();
		/** FitAddon of each xterm instance, used when no measure callback was captured. */
		const fitAddons = new WeakMap();
		/** Fit built from a React fiber for terminals adopted after the fact. */
		const fiberRefits = new WeakMap();
		/** Instances waiting for the next animation frame's refit. */
		const pendingRefit = new Set();
		let refitFrame = 0;

		function isXterm(value) {
			if (value === null || typeof value !== 'object') return false;
			try {
				if (typeof value.write !== 'function' || typeof value.resize !== 'function') return false;
				const options = value.options;
				if (options === null || typeof options !== 'object') return false;
				return 'fontFamily' in options && 'fontSize' in options;
			} catch {
				return false;
			}
		}

		function isFitAddon(value) {
			return (
				value !== null &&
				typeof value === 'object' &&
				typeof value.proposeDimensions === 'function' &&
				typeof value.fit === 'function'
			);
		}

		/** The font values a terminal carried before this plugin first touched it. */
		const originalFonts = new WeakMap();

		/**
		 * Read (once) the values the shipped terminal chose for this instance, so
		 * "disabled" and "auto size" restore what the terminal had rather than
		 * pinning a copy of today's constants.
		 */
		function originalOf(xterm) {
			let record = originalFonts.get(xterm);
			if (record === void 0) {
				record = { fontFamily: xterm.options.fontFamily, fontSize: xterm.options.fontSize };
				originalFonts.set(xterm, record);
			}
			return record;
		}

		function applyToTerminal(xterm, scheduleRefit) {
			try {
				const original = originalOf(xterm);
				const family = settings.enabled ? resolvedFontFamily() : original.fontFamily;
				const size = settings.enabled && settings.fontSize > 0 ? settings.fontSize : original.fontSize;
				if (xterm.options.fontFamily !== family) xterm.options.fontFamily = family;
				if (xterm.options.fontSize !== size) xterm.options.fontSize = size;
			} catch (error) {
				console.warn('dsh-terminal-font: could not apply the font to a terminal', error);
			}
			if (scheduleRefit) queueRefit(xterm);
		}

		function queueRefit(xterm) {
			if (typeof window.requestAnimationFrame !== 'function') return;
			pendingRefit.add(xterm);
			if (refitFrame !== 0) return;
			refitFrame = window.requestAnimationFrame(() => {
				refitFrame = 0;
				const batch = [...pendingRefit];
				pendingRefit.clear();
				for (const target of batch) refit(target);
			});
		}

		/** Replay the terminal's own fit, which resizes xterm and tells the PTY. */
		function refit(xterm) {
			const node = findMeasuredNode(xterm);
			if (node !== null) {
				try {
					measuredNodes.get(node)();
					return;
				} catch (error) {
					console.warn('dsh-terminal-font: terminal refit failed', error);
				}
			}
			const fromFiber = fiberRefits.get(xterm);
			if (fromFiber !== void 0) {
				try {
					if (fromFiber()) return;
				} catch (error) {
					console.warn('dsh-terminal-font: fiber refit failed', error);
				}
			}
			const addon = fitAddons.get(xterm);
			if (addon !== void 0) {
				try {
					addon.fit();
				} catch (error) {
					console.warn('dsh-terminal-font: fit addon refit failed', error);
				}
			}
		}

		/** Climb from xterm's own element to the container its ResizeObserver watches. */
		function findMeasuredNode(xterm) {
			let node = xterm.element ?? null;
			for (let depth = 0; node !== null && depth < 8; depth += 1) {
				if (measuredNodes.has(node)) return node;
				node = node.parentElement ?? null;
			}
			return null;
		}

		/** Instances already adopted, so the fiber fallback cannot apply twice. */
		const adopted = new WeakSet();

		function captureTerminal(xterm) {
			if (adopted.has(xterm)) return;
			adopted.add(xterm);
			terminals.add(new WeakRef(xterm));
			applyToTerminal(xterm, true);
		}

		/**
		 * Adopt terminals that were already mounted when this plugin loaded.
		 *
		 * The React module proxy only sees chunks materialized after the hook is
		 * installed, so a terminal opened earlier in the same page needs the other
		 * way back to its instance: React keeps a fiber on every DOM node it
		 * rendered, and `TerminalScreen` keeps xterm in a hook. Guarded and bounded,
		 * because it reads React internals rather than a public API.
		 */
		function scanMountedTerminals() {
			let nodes;
			try {
				nodes = document.querySelectorAll('.xterm');
			} catch {
				return;
			}
			for (const node of nodes) {
				const parent = node.parentElement;
				if (parent === null || parent === void 0) continue;
				const xterm = terminalFromFiber(parent);
				if (xterm !== null) captureTerminal(xterm);
			}
		}

		function terminalFromFiber(node) {
			try {
				const key = Object.keys(node).find(
					(name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
				);
				if (key === void 0) return null;
				let fiber = node[key];
				for (let depth = 0; fiber !== null && fiber !== void 0 && depth < 40; depth += 1) {
					let xterm = null;
					let addon = null;
					let hook = fiber.memoizedState;
					for (let index = 0; hook !== null && hook !== void 0 && index < 40; index += 1) {
						const value = hook.memoizedState;
						if (value !== null && typeof value === 'object' && 'current' in value) {
							if (xterm === null && isXterm(value.current)) xterm = value.current;
							else if (addon === null && isFitAddon(value.current)) addon = value.current;
						}
						hook = hook.next;
					}
					if (xterm !== null) {
						if (addon !== null) fitAddons.set(xterm, addon);
						fiberRefits.set(xterm, () => fiberRefit(fiber, xterm));
						return xterm;
					}
					fiber = fiber.return;
				}
			} catch {
				return null;
			}
			return null;
		}

		/**
		 * The terminal's own fit, rebuilt for a terminal whose ResizeObserver
		 * predates this plugin: `TerminalScreen` holds its model and environment in
		 * `memoizedProps`, so xterm and the PTY can still be resized together
		 * instead of only re-fitting the grid.
		 * @returns whether a resize was performed.
		 */
		function fiberRefit(fiber, xterm) {
			const props = fiber.memoizedProps;
			if (props === null || typeof props !== 'object') return false;
			const addon = fitAddons.get(xterm);
			const environment = props.state?.environment;
			const model = props.model;
			if (addon === void 0 || environment === void 0 || model === void 0 || typeof model.resize !== 'function') return false;
			const dimensions = addon.proposeDimensions();
			if (dimensions === void 0) return false;
			const cols = Math.min(dimensions.cols, environment.maxCols);
			const rows = Math.min(dimensions.rows, environment.maxRows);
			if (cols < 2 || rows < 1) return false;
			xterm.resize(cols, rows);
			model.resize(cols, rows);
			return true;
		}

		function forEachLiveTerminal(each) {
			for (const reference of [...terminals]) {
				const xterm = reference.deref();
				if (xterm === void 0) {
					terminals.delete(reference);
					continue;
				}
				each(xterm);
			}
		}

		/* ------------------------------------------------------------------ *
		 * Runtime hooks
		 * ------------------------------------------------------------------ */

		/** Wrap the module loader so the terminal chunk receives a React with a `useRef` spy. */
		function installLoaderHook() {
			const loader = globalThis.__ModuleLoader__;
			if (loader === void 0 || typeof loader.load !== 'function') return () => {};
			const previous = loader.load;
			if (previous.__dshTerminalFont === true) return () => {};

			const hooked = function (registration) {
				if (registration !== null && typeof registration === 'object' && registration.chunk === TERMINAL_CHUNK) {
					const id = typeof registration.id === 'string' ? registration.id : '';
					if (id === TERMINAL_PLUGIN_ID || id === `${TERMINAL_PLUGIN_ID}/client`) {
						return previous.call(this, {
							...registration,
							factory: (chunkRequire) => registration.factory(hookedRequire(chunkRequire))
						});
					}
				}
				return previous.call(this, registration);
			};
			hooked.__dshTerminalFont = true;
			loader.load = hooked;
			return () => {
				if (loader.load === hooked) loader.load = previous;
			};
		}

		/** The chunk's own require, with the React module proxied for one hook. */
		function hookedRequire(chunkRequire) {
			const patched = (specifier) => {
				const value = chunkRequire(specifier);
				return specifier === 'react' ? reactWithRefSpy(value) : value;
			};
			if (typeof chunkRequire.async === 'function') patched.async = chunkRequire.async;
			return patched;
		}

		const reactProxies = new WeakMap();

		/**
		 * A React module whose `useRef` returns an assignment-observing ref.
		 *
		 * xterm's instance never touches the DOM it renders into, so the component
		 * state is the only way back to it. The proxy is per-module-object, keeps
		 * every other export identical, and the ref it returns stores values in the
		 * same object React keeps, so later renders read them normally.
		 */
		function reactWithRefSpy(react) {
			if (react === null || typeof react !== 'object') return react;
			const cached = reactProxies.get(react);
			if (cached !== void 0) return cached;
			if (typeof react.useRef !== 'function') return react;
			const useRef = react.useRef;
			const proxied = new Proxy(react, {
				get(target, property) {
					if (property === 'useRef') return spyingUseRef;
					return Reflect.get(target, property, target);
				}
			});
			reactProxies.set(react, proxied);
			return proxied;

			function spyingUseRef(initialValue) {
				const ref = useRef(initialValue);
				if (ref === null || typeof ref !== 'object') return ref;
				return new Proxy(ref, {
					get(target, property) {
						return Reflect.get(target, property, target);
					},
					set(target, property, value) {
						Reflect.set(target, property, value);
						if (property === 'current') captureRefValue(value);
						return true;
					}
				});
			}
		}

		function captureRefValue(value) {
			try {
				if (isXterm(value)) captureTerminal(value);
				else if (isFitAddon(value)) {
					const terminal = value._terminal;
					if (terminal !== null && typeof terminal === 'object') fitAddons.set(terminal, value);
				}
			} catch (error) {
				console.warn('dsh-terminal-font: ref capture failed', error);
			}
		}

		/** Wrap ResizeObserver so the terminal's fit callback can be replayed on demand. */
		function installResizeObserverHook() {
			const Native = globalThis.ResizeObserver;
			if (typeof Native !== 'function') return () => {};
			const patched = class TerminalFontResizeObserver extends Native {
				constructor(callback) {
					super(callback);
					this.__terminalFontCallback = callback;
					this.__terminalFontTargets = new Set();
				}
				observe(target, options) {
					this.__terminalFontTargets.add(target);
					measuredNodes.set(target, () => this.__terminalFontCallback([], this));
					return super.observe(target, options);
				}
				unobserve(target) {
					this.__terminalFontTargets.delete(target);
					measuredNodes.delete(target);
					return super.unobserve(target);
				}
				disconnect() {
					for (const target of this.__terminalFontTargets) measuredNodes.delete(target);
					this.__terminalFontTargets.clear();
					return super.disconnect();
				}
			};
			globalThis.ResizeObserver = patched;
			return () => {
				if (globalThis.ResizeObserver === patched) globalThis.ResizeObserver = Native;
			};
		}

		/* ------------------------------------------------------------------ *
		 * Copy
		 * ------------------------------------------------------------------ */

		const zh = {
			nav: '终端',
			title: '终端字体',
			intro: '设置右侧边栏终端使用的字体与字号。oh-my-posh、Powerline 与 Nerd Font 图标需要 Nerd Font 字体才能正确显示。',
			enable: '启用自定义字体',
			enableHint: '关闭后终端恢复 DeepSeek Harness 的内置字体。',
			family: '字体',
			familyHint: '填写已安装的字体名称；留空使用推荐字体。含逗号的写法会作为完整的 CSS 字体列表使用。',
			familyPlaceholder: '例如 CaskaydiaCove Nerd Font Mono',
			familySuggestions: '常用 Nerd Font',
			size: '字号（px）',
			sizeHint: '自动表示沿用终端内置字号（13px）。',
			auto: '自动',
			reset: '恢复默认',
			decrease: '减小字号',
			increase: '增大字号',
			preview: '预览',
			previewHint: '若下方图标显示为方块，说明该字体未安装或名称不正确。',
			previewText: 'PS C:\\Users\\you> git status',
			applied: '更改会立即应用到已打开的终端；字号变化会自动重新适配列宽。',
			on: '已开启',
			off: '已关闭'
		};

		const en = {
			nav: 'Terminal',
			title: 'Terminal font',
			intro: 'Choose the font family and size of the right sidebar terminal. oh-my-posh, Powerline and Nerd Font glyphs need a Nerd Font to render.',
			enable: 'Use a custom font',
			enableHint: 'When off, terminals fall back to the built-in DeepSeek Harness font.',
			family: 'Font family',
			familyHint: 'An installed family name; leave empty for the recommended stack. A value containing a comma is used as the complete CSS font list.',
			familyPlaceholder: 'e.g. CaskaydiaCove Nerd Font Mono',
			familySuggestions: 'Common Nerd Fonts',
			size: 'Font size (px)',
			sizeHint: 'Auto keeps the terminal’s built-in size (13px).',
			auto: 'Auto',
			reset: 'Reset',
			decrease: 'Decrease font size',
			increase: 'Increase font size',
			preview: 'Preview',
			previewHint: 'Boxes below mean the family is not installed or the name is wrong.',
			previewText: 'PS C:\\Users\\you> git status',
			applied: 'Changes apply to open terminals immediately; a size change refits the columns.',
			on: 'On',
			off: 'Off'
		};

		/* ------------------------------------------------------------------ *
		 * Styles
		 * ------------------------------------------------------------------ */

		const CSS = `
.dtf-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.dtf-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dtf-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dtf-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:4px;padding:4px 16px;display:flex}
.dtf-row{align-items:center;gap:16px;padding:14px 0;display:flex}
.dtf-row+.dtf-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.dtf-rowText{flex:1;min-width:0;flex-direction:column;gap:4px;display:flex}
.dtf-label{font-size:14px;line-height:22px}
.dtf-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dtf-control{flex:none;align-items:center;gap:8px;display:inline-flex}
.dtf-input{box-sizing:border-box;width:260px;max-width:44vw;height:32px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;background:var(--dsw-alias-bg-l1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);outline:none;padding:0 8px}
.dtf-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dtf-button{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l3);padding:0 10px}
.dtf-button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dtf-stepper{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);align-items:center;height:36px;display:inline-flex;position:relative}
.dtf-step{color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm);justify-content:center;align-items:center;width:28px;height:28px;margin:0 4px;font-size:16px;line-height:1;display:inline-flex}
.dtf-step:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dtf-step:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dtf-value{text-align:center;font-variant-numeric:tabular-nums;min-width:52px;font-size:14px;line-height:22px}
.dtf-switch{border-radius:999px;background:var(--dsw-alias-border-l2);border:0;flex:none;width:38px;height:22px;cursor:pointer;padding:2px;display:inline-flex;align-items:center;transition:background-color .12s}
.dtf-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary);justify-content:flex-end}
.dtf-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dtf-thumb{corner-shape:round;background:var(--dsw-static-neutral-00);border-radius:50%;width:18px;height:18px;display:block}
.dtf-preview{margin:0 0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-l1));color:var(--dsw-alias-label-primary);white-space:pre;overflow-x:auto;padding:12px}
.dtf-previewLine{display:block;line-height:1.3}
.dtf-previewDim{color:var(--dsw-alias-label-tertiary)}
.dtf-status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
`;

		/* ------------------------------------------------------------------ *
		 * View
		 * ------------------------------------------------------------------ */

		const useSyncStore =
			typeof React.useSyncExternalStore === 'function'
				? (target) => React.useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot)
				: (target) => {
						const [value, setValue] = React.useState(target.getSnapshot);
						React.useEffect(() => target.subscribe(() => setValue(target.getSnapshot())), [target]);
						return value;
					};

		const GLYPHS = [
			{ text: '\uE0B0\uE0B2', name: 'powerline' },
			{ text: '\uE0A0 \uE0B1', name: 'branch' },
			{ text: '\uF1D3 \uE73C \uF115 \uF00C \uF071', name: 'icons' }
		];

		function TerminalFontSection(props) {
			const t = typeof props.t === 'function' ? props.t : (key) => key;
			const state = useSyncStore(store);
			const [draft, setDraft] = React.useState(state.fontFamily);
			React.useEffect(() => {
				setDraft(state.fontFamily);
			}, [state.fontFamily]);

			const family = draft.trim() === '' ? RECOMMENDED_FONT_STACK : draft.includes(',') ? draft : `"${draft}", ${DSH_FONT_STACK}`;
			const size = draftSize(state);
			const listId = React.useId();

			const commitFamily = (next) => {
				if (next === state.fontFamily) return;
				publish({ ...settings, fontFamily: next });
			};
			const setSize = (next) => {
				const clamped = Math.min(FONT_SIZE_MAX, Math.max(0, next));
				if (clamped === state.fontSize) return;
				publish({ ...settings, fontSize: clamped });
			};
			const toggle = () => publish({ ...settings, enabled: !state.enabled });

			return React.createElement(
				'div',
				{ className: 'dtf-section' },
				React.createElement('h2', { className: 'dtf-heading' }, t('title')),
				React.createElement('p', { className: 'dtf-intro' }, t('intro')),
				React.createElement(
					'div',
					{ className: 'dtf-card' },
					React.createElement(
						'div',
						{ className: 'dtf-row' },
						React.createElement(
							'div',
							{ className: 'dtf-rowText' },
							React.createElement('div', { className: 'dtf-label' }, t('enable')),
							React.createElement('div', { className: 'dtf-hint' }, t('enableHint'))
						),
						React.createElement(
							'div',
							{ className: 'dtf-control' },
							React.createElement(
								'button',
								{
									type: 'button',
									role: 'switch',
									className: 'dtf-switch',
									'aria-checked': state.enabled,
									'aria-label': t('enable'),
									onClick: toggle
								},
								React.createElement('span', { className: 'dtf-thumb' })
							)
						)
					),
					React.createElement(
						'div',
						{ className: 'dtf-row' },
						React.createElement(
							'div',
							{ className: 'dtf-rowText' },
							React.createElement('div', { className: 'dtf-label' }, t('family')),
							React.createElement('div', { className: 'dtf-hint' }, t('familyHint'))
						),
						React.createElement(
							'div',
							{ className: 'dtf-control' },
							React.createElement('input', {
								className: 'dtf-input',
								type: 'text',
								list: listId,
								value: draft,
								placeholder: t('familyPlaceholder'),
								'aria-label': t('family'),
								disabled: !state.enabled,
								onChange: (event) => setDraft(event.currentTarget.value),
								onBlur: (event) => commitFamily(event.currentTarget.value.trim()),
								onKeyDown: (event) => {
									if (event.key === 'Enter') event.currentTarget.blur();
								}
							}),
							React.createElement(
								'datalist',
								{ id: listId },
								FONT_SUGGESTIONS.map((familyName) => React.createElement('option', { key: familyName, value: familyName }))
							),
							React.createElement(
								'button',
								{
									type: 'button',
									className: 'dtf-button',
									disabled: !state.enabled,
									onClick: () => {
										setDraft('');
										commitFamily('');
										setSize(0);
									}
								},
								t('reset')
							)
						)
					),
					React.createElement(
						'div',
						{ className: 'dtf-row' },
						React.createElement(
							'div',
							{ className: 'dtf-rowText' },
							React.createElement('div', { className: 'dtf-label' }, t('size')),
							React.createElement('div', { className: 'dtf-hint' }, t('sizeHint'))
						),
						React.createElement(
							'div',
							{ className: 'dtf-control' },
							React.createElement(
								'div',
								{ className: 'dtf-stepper' },
								React.createElement(
									'button',
									{
										type: 'button',
										className: 'dtf-step',
										'aria-label': t('decrease'),
										disabled: !state.enabled || state.fontSize <= FONT_SIZE_MIN,
										onClick: () => setSize(state.fontSize <= 0 ? DSH_FONT_SIZE - 1 : state.fontSize - 1)
									},
									'\u2212'
								),
								React.createElement('span', { className: 'dtf-value' }, state.fontSize <= 0 ? t('auto') : String(state.fontSize)),
								React.createElement(
									'button',
									{
										type: 'button',
										className: 'dtf-step',
										'aria-label': t('increase'),
										disabled: !state.enabled || state.fontSize >= FONT_SIZE_MAX,
										onClick: () => setSize(state.fontSize <= 0 ? DSH_FONT_SIZE + 1 : state.fontSize + 1)
									},
									'+'
								)
							)
						)
					)
				),
				React.createElement(
					'div',
					null,
					React.createElement('div', { className: 'dtf-label' }, t('preview')),
					React.createElement(
						'div',
						{
							className: 'dtf-preview',
							style: {
								fontFamily: state.enabled ? family : DSH_FONT_STACK,
								fontSize: `${state.enabled ? size : DSH_FONT_SIZE}px`
							}
						},
						GLYPHS.map((glyph) =>
							React.createElement(
								'span',
								{ className: 'dtf-previewLine', key: glyph.name },
								glyph.text,
								'  ',
								React.createElement('span', { className: 'dtf-previewDim' }, t('previewText'))
							)
						)
					),
					React.createElement('p', { className: 'dtf-hint' }, t('previewHint')),
					React.createElement('p', { className: 'dtf-status' }, t('applied'))
				)
			);
		}

		function draftSize(state) {
			if (!state.enabled) return DSH_FONT_SIZE;
			return state.fontSize > 0 ? state.fontSize : DSH_FONT_SIZE;
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'terminal-font: dictionaries');
			ctx.effect(() => installLoaderHook(), 'terminal-font: terminal chunk hook');
			ctx.effect(() => installResizeObserverHook(), 'terminal-font: resize observer hook');
			ctx.effect(
				() => ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'terminal-font',
							order: 18,
							label: () => t('nav'),
							locale: NS
						},
						TerminalFontSection
					)
				),
				'terminal-font: settings section'
			);
			ctx.effect(
				() =>
					store.subscribe(() => {
						forEachLiveTerminal((xterm) => applyToTerminal(xterm, true));
						scanMountedTerminals();
					}),
				'terminal-font: apply changes'
			);
			ctx.effect(() => {
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-terminal-font';
				tag.dataset.pluginCss = 'dsh-terminal-font/section.css';
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, 'terminal-font: styles');
			ctx.effect(() => {
				// A terminal that mounted before this bundle loaded has no future ref
				// assignment to observe, so adopt whatever is on screen once the shell
				// has painted.
				const timer = window.setTimeout(scanMountedTerminals, 800);
				return () => window.clearTimeout(timer);
			}, 'terminal-font: adopt mounted terminals');
			forEachLiveTerminal((xterm) => applyToTerminal(xterm, false));
		}

		return { apply, inject };
	}
});
