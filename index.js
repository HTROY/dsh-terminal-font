/**
 * Host half of the terminal-font bundle.
 *
 * The whole feature is a browser-side rendering preference (the font must exist
 * on the machine that draws the terminal), so this half only claims the loader
 * row that carries the `dsh.client` bundle. It declares no Config, which keeps
 * the bundle free of any Host-side dependency.
 */
export function apply() {}
