const PANOPTIC_TITLE = 'PANOPTIC';
const PANOPTIC_SUBTITLE = 'GLOBAL SITUATIONAL INTELLIGENCE';

/**
 * Apply the PANOPTIC product identity to the existing God's Eye View shell
 * without changing any underlying globe, layer, cockpit, or data behaviour.
 * Keeping the rebrand isolated makes upstream merges easier while the fork is
 * still close to its source project.
 *
 * @param {Document} [root=document] DOM document to update.
 */
export function applyPanopticBranding(root = document) {
  if (!root) return;

  root.title = PANOPTIC_TITLE;

  const title = root.querySelector('#title-bar h1 > span:last-child');
  if (title) {
    title.innerHTML = '<span>PAN<span class="title-accent">OPTIC</span></span>';
  }

  const subtitle = root.querySelector('#title-bar .subtitle');
  if (subtitle) subtitle.textContent = PANOPTIC_SUBTITLE;

  const loadingTitle = root.querySelector('#loading-screen .loader-content h2');
  if (loadingTitle) {
    loadingTitle.innerHTML = 'PAN<span class="title-accent">OPTIC</span>';
  }
}
