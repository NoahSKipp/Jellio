// Embeds a separately deployed Audiobookshelf instance inside Jellio's
// own shell, rather than handing off to a real new tab: real feedback
// was that leaving Jellio's own window entirely read as a dead end, an
// iframe keeps this rail/nav reachable the whole time a reader is in
// there, one click away rather than a real tab switch. Configuration/
// PluginConfiguration.cs's own real AudiobookshelfUrl, blank by
// default - components/sidebar.js's own Books entry only ever links
// here once an admin has actually set one, same graceful-blank
// reasoning every other optional integration in that config follows.
import { getAudiobookshelfUrl, loadAudiobookshelfSetting } from '../runtime/audiobookshelfSetting.js';
import { el } from '../runtime/dom.js';

export async function renderAudiobookshelf(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-audiobookshelf';

  // components/sidebar.js's own build already resolved this once, but
  // a reader can reach this route directly (a bookmark, a typed hash)
  // with that same fetch never having run yet on this exact page load.
  const url = getAudiobookshelfUrl() || (await loadAudiobookshelfSetting());
  if (!url) {
    root.appendChild(
      el(
        'p',
        'jellio-service-empty',
        'Audiobookshelf is not configured yet. Set its URL on the Jellio plugin’s Configuration page.',
      ),
    );
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.className = 'jellio-audiobookshelf-frame';
  iframe.src = url;
  iframe.title = 'Audiobookshelf';
  iframe.allow = 'fullscreen';
  root.appendChild(iframe);
}
