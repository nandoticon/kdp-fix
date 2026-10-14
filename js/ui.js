export function setStatus(element, message, state = 'info') {
  element.style.display = 'block';
  element.textContent = message;
  element.dataset.state = state;
  element.style.background = state === 'success'
    ? 'rgba(52, 199, 89, 0.1)'
    : state === 'error' ? 'rgba(255, 59, 48, 0.1)'
      : state === 'warning' ? 'rgba(255, 159, 10, 0.12)' : 'rgba(0, 122, 255, 0.1)';
  element.style.color = state === 'success' ? '#34C759'
    : state === 'error' ? '#FF3B30' : state === 'warning' ? '#FF9F0A' : 'var(--apple-blue)';
}

export function setModalState(modalId, open) {
  const modal = document.getElementById(modalId);
  if (!modal) throw new Error(`Missing modal: #${modalId}`);
  modal.classList.toggle('active', open);
  modal.setAttribute('aria-hidden', String(!open));
}

export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function createButton(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

export function buildOutputCard({ epub, filename, t, onCoverChange, onEdit, onPreview, onDownload }) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const header = document.createElement('div');
  header.className = 'result-header';
  const heading = document.createElement('h3');
  heading.textContent = filename;
  header.appendChild(heading);
  card.appendChild(header);

  const coverContainer = document.createElement('div');
  coverContainer.className = 'cover-container';
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.hidden = true;
  coverInput.accept = 'image/jpeg,image/png';
  coverInput.addEventListener('change', event => onCoverChange(event.target.files[0]));
  card.appendChild(coverInput);

  const coverButton = document.createElement('button');
  coverButton.type = 'button';
  coverButton.className = 'cover-preview';
  coverButton.setAttribute('aria-label', t('change_cover'));
  coverButton.addEventListener('click', () => coverInput.click());
  if (epub.coverUrl) {
    const image = document.createElement('img');
    image.src = epub.coverUrl;
    image.alt = t('cover_image');
    coverButton.appendChild(image);
  } else {
    coverButton.textContent = t('no_cover');
  }
  coverContainer.appendChild(coverButton);

  const coverInfo = document.createElement('div');
  coverInfo.className = 'cover-info';
  const metaInfo = document.createElement('div');
  metaInfo.className = 'meta-info';
  for (const value of [epub.metadata.title, epub.metadata.author, epub.metadata.language]) {
    const badge = document.createElement('span');
    badge.className = 'meta-badge';
    badge.textContent = value || t('unknown');
    metaInfo.appendChild(badge);
  }
  coverInfo.appendChild(metaInfo);

  const icons = { applied: 'check-circle', verified: 'circle-check', warning: 'alert-triangle', skipped: 'minus-circle' };
  const checklist = document.createElement('ul');
  checklist.className = 'optimization-checklist';
  for (const optimization of epub.optimizations) {
    const item = document.createElement('li');
    item.className = `opt-item ${optimization.status}`;
    item.title = t(`tooltip_${optimization.status}`);
    const iconContainer = document.createElement('div');
    iconContainer.className = 'opt-status';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', icons[optimization.status] || 'circle');
    iconContainer.appendChild(icon);
    const label = document.createElement('span');
    label.textContent = t(optimization.id, optimization.payload);
    item.append(iconContainer, label);
    checklist.appendChild(item);
  }
  coverInfo.append(metaInfo, checklist);
  coverContainer.appendChild(coverInfo);
  card.appendChild(coverContainer);

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  actions.append(
    createButton(t('edit_meta'), 'dl-btn btn-secondary', onEdit),
    createButton(t('preview'), 'dl-btn btn-secondary', onPreview),
    createButton(t('download'), 'dl-btn', onDownload)
  );
  card.appendChild(actions);
  return card;
}

export function buildErrorCard(name, message, t) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.borderColor = '#FF3B30';
  const heading = document.createElement('h3');
  heading.style.color = '#FF3B30';
  heading.textContent = `❌ ${name}`;
  const detail = document.createElement('p');
  detail.style.color = 'var(--text-secondary)';
  detail.textContent = `${t('err_processing')}: ${message || t('err_unknown')}`;
  card.append(heading, detail);
  return card;
}
