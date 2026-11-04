// Settings for the download provider key.
//
// Search, browsing and playback all work with no configuration. The provider key
// is only used when a download cannot be served by a public mirror.
//
// A built-in key ships with the app so downloads work on a fresh install. A key
// the user saves overrides it; clearing the field falls back to the built-in one
// rather than disabling downloads.

import { SETTINGS_KEY, DEFAULT_PROVIDER_KEY } from './config.js';
import { load, store } from './util.js';
import { emit } from './events.js';

const defaults = {
  // Empty means "use the built-in key". Keeping the custom key separate from the
  // default is what makes Reset meaningful without losing the working default.
  providerKey: '',
  format: 'mp3',

  // Where the DownVid API is reached. DownVid sends no CORS headers, so it can
  // only be called through a relay that adds them (see relay/README.md). Empty
  // means the same-origin development relay at `/__relay`; a deployed Worker URL
  // goes here once the app is hosted.
  downvidRelay: '',
};

const settings = Object.assign({}, defaults, load(SETTINGS_KEY, {}));

export function getSettings() {
  return { ...settings };
}

export function updateSettings(patch) {
  Object.assign(settings, patch || {});
  store(SETTINGS_KEY, settings);
  emit('settings-changed', getSettings());
  return getSettings();
}

/** The custom key the user saved, if any. */
export const customProviderKey = () => String(settings.providerKey || '').trim();

/** The key actually used: the user's own, else the built-in default. */
export const providerKey = () => customProviderKey() || DEFAULT_PROVIDER_KEY;

/** True whenever a key is available — which is always, thanks to the default. */
export const hasProviderKey = () => !!providerKey();

/** True when the active key is the shipped one rather than the user's own. */
export const usingDefaultProviderKey = () => !customProviderKey();
