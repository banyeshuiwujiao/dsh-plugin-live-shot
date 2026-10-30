/**
 * Host half of the DSH image annotator.
 *
 * Upstream this file started an Electron helper that captured the live Windows
 * desktop and drew the annotation overlay in its own window. The DSH web
 * profile runs as plain Node, so the whole capture-and-draw path moved into
 * the browser: the client bundle renders the editor over the page and talks to
 * the composer through the standard conversation service.
 *
 * The host half therefore has nothing to start. It stays in the bundle so the
 * plugin keeps its own row, title, description, and icon in the plugin
 * inventory.
 */

/** No host-side service is required. */
export const inject = [];

/** Nothing to mount on the Host. */
export function apply() {
  // The annotator is entirely browser-side.
}
