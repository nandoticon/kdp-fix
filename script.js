import { EPUBBook } from './js/epub-engine.js';
import { resolveEpubPath } from './js/utils.js';
import { I18N } from './js/constants.js';

let currentLang = ['en', 'pt', 'es'].includes(localStorage.getItem('kdp_lang'))
  ? localStorage.getItem('kdp_lang')
  : 'en';
let epubInstances = [];
let filenames = [];
let dlfilenames = [];
let resultCards = [];
let currentEditIdx = null;
let processingRun = 0;

const outputDiv = document.getElementById('output');
const mainStatusDiv = document.getElementById('main_status');
const fileInput = document.getElementById('file');
const dropZone = document.getElementById('drop-zone');
const btnDlAll = document.getElementById('btnDlAll');
const bulkEditContainer = document.getElementById('bulk-edit-container');

function t(key, n) {
  let text = I18N[currentLang][key] || I18N.en[key] || key;
  if (n !== undefined) text = text.replace('{n}', n);
  return text;
}

function applyI18N() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
}

function setStatus(message, state = 'info') {
  mainStatusDiv.style.display = 'block';
  mainStatusDiv.textContent = message;
  mainStatusDiv.dataset.state = state;
  mainStatusDiv.style.background = state === 'success'
    ? 'rgba(52, 199, 89, 0.1)'
    : state === 'error' ? 'rgba(255, 59, 48, 0.1)' : 'rgba(0, 122, 255, 0.1)';
  mainStatusDiv.style.color = state === 'success' ? '#34C759'
    : state === 'error' ? '#FF3B30' : 'var(--apple-blue)';
}

function createButton(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function setModalState(modalId, open) {
  const modal = document.getElementById(modalId);
  modal.classList.toggle('active', open);
  modal.setAttribute('aria-hidden', String(!open));
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function buildOutputHTML(idx) {
  const epub = epubInstances[idx];
  const card = document.createElement('div');
  card.className = 'result-card';

  const header = document.createElement('div');
  header.className = 'result-header';
  const heading = document.createElement('h3');
  heading.textContent = filenames[idx];
  header.appendChild(heading);
  card.appendChild(header);

  const coverContainer = document.createElement('div');
  coverContainer.className = 'cover-container';
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.hidden = true;
  coverInput.accept = 'image/jpeg,image/png';
  coverInput.addEventListener('change', event => handleCoverChange(idx, event.target.files[0]));
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
    createButton(t('edit_meta'), 'dl-btn btn-secondary', () => openEditor(idx)),
    createButton(t('preview'), 'dl-btn btn-secondary', () => openReader(idx)),
    createButton(t('download'), 'dl-btn', () => downloadEpub(idx))
  );
  card.appendChild(actions);

  return card;
}

function buildErrorCard(name, message) {
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

async function handleFiles(files) {
  const fileArray = Array.from(files).filter(file => /\.epub$/i.test(file.name));
  if (!fileArray.length) return;

  const run = ++processingRun;
  closeMetadataModal();
  closeReaderModal();
  epubInstances.forEach(epub => {
    if (epub.coverUrl) URL.revokeObjectURL(epub.coverUrl);
  });
  setStatus(t('processing'));
  outputDiv.replaceChildren();
  btnDlAll.style.display = 'none';
  bulkEditContainer.style.display = 'none';
  epubInstances = [];
  filenames = [];
  dlfilenames = [];
  resultCards = [];

  const startTime = performance.now();
  const results = await Promise.all(fileArray.map(async file => {
    let epub;
    try {
      epub = new EPUBBook();
      await epub.readEPUB(file);
      epub.parseMetadata();
      epub.findCover();
      await epub.runAllOptimizations();
      return { epub, name: file.name, error: null };
    } catch (error) {
      console.error('Error processing:', file.name, error);
      if (epub?.coverUrl) URL.revokeObjectURL(epub.coverUrl);
      return { epub: null, name: file.name, error: error.message };
    }
  }));
  if (run !== processingRun) {
    results.forEach(result => {
      if (result.epub?.coverUrl) URL.revokeObjectURL(result.epub.coverUrl);
    });
    return;
  }

  results.forEach(result => {
    if (!result.epub) {
      outputDiv.appendChild(buildErrorCard(result.name, result.error));
      return;
    }
    const idx = epubInstances.length;
    epubInstances.push(result.epub);
    filenames.push(result.name);
    dlfilenames.push(result.name);
    const card = buildOutputHTML(idx);
    resultCards.push(card);
    outputDiv.appendChild(card);
  });
  refreshIcons();

  setStatus(t('done'), 'success');
  if (fileArray.length > 1) {
    btnDlAll.style.display = 'flex';
    bulkEditContainer.style.display = 'block';
  }
  console.log(`Processed ${fileArray.length} files in ${(performance.now() - startTime).toFixed(2)}ms`);
}

async function downloadEpub(idx) {
  try {
    const blob = await epubInstances[idx].writeEPUB();
    saveAs(blob, dlfilenames[idx]);
  } catch (error) {
    console.error('EPUB download failed:', error);
    setStatus(`${t('err_download')}: ${error.message}`, 'error');
  }
}

function openEditor(idx) {
  currentEditIdx = idx;
  const metadata = epubInstances[idx].metadata;
  document.getElementById('edit-title').value = metadata.title || '';
  document.getElementById('edit-author').value = metadata.author || '';
  document.getElementById('edit-series').value = metadata.series || '';
  document.getElementById('edit-language').value = metadata.language || '';
  setModalState('modal-metadata', true);
}

function closeMetadataModal() {
  setModalState('modal-metadata', false);
  currentEditIdx = null;
}

function saveMetadataChanges() {
  if (currentEditIdx === null) return;
  const epub = epubInstances[currentEditIdx];
  try {
    epub.updateMetadata({
      title: document.getElementById('edit-title').value,
      author: document.getElementById('edit-author').value,
      series: document.getElementById('edit-series').value,
      language: document.getElementById('edit-language').value
    });
    const idx = currentEditIdx;
    const card = buildOutputHTML(idx);
    resultCards[idx].replaceWith(card);
    resultCards[idx] = card;
    refreshIcons();
    closeMetadataModal();
  } catch (error) {
    console.error('Metadata update failed:', error);
    setStatus(`${t('err_metadata')}: ${error.message}`, 'error');
  }
}

function getAssetMimeType(path) {
  const extension = path.split('.').pop().toLowerCase();
  return ({
    css: 'text/css', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', mp4: 'video/mp4'
  })[extension] || 'application/octet-stream';
}

function toDataUri(data, mimeType) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function makePreviewDocument(epub, chapterPath) {
  const parser = new DOMParser();
  const document = parser.parseFromString(epub.files[chapterPath], 'text/html');
  document.querySelectorAll('script,iframe,object,embed,form,base,meta[http-equiv]').forEach(element => element.remove());
  document.querySelectorAll('link:not([rel~="stylesheet"])').forEach(element => element.remove());

  const resourceUri = (baseFile, reference) => {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return '';
    const path = resolveEpubPath(baseFile, reference);
    const data = epub.files[path] ?? epub.binary_files[path];
    return data === undefined ? '' : toDataUri(data, getAssetMimeType(path));
  };
  const rewriteCss = (css, cssPath, visited = new Set()) => {
    if (visited.has(cssPath)) return '';
    visited.add(cssPath);
    const withImports = css.replace(/@import\s+(?:url\()?(['"]?)([^'")\s;]+)\1\)?[^;]*;/gi, (match, quote, reference) => {
      const path = resolveEpubPath(cssPath, reference);
      const imported = epub.files[path];
      return imported === undefined ? '' : rewriteCss(imported, path, visited);
    });
    return withImports.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, reference) => {
      const trimmedReference = reference.trim();
      if (trimmedReference.startsWith('#')) return match;
      const uri = resourceUri(cssPath, trimmedReference);
      return uri ? `url("${uri}")` : 'url("")';
    });
  };

  document.querySelectorAll('style').forEach(style => {
    style.textContent = rewriteCss(style.textContent, chapterPath);
  });
  document.querySelectorAll('[style]').forEach(element => {
    element.setAttribute('style', rewriteCss(element.getAttribute('style'), chapterPath));
  });
  document.querySelectorAll('link[rel~="stylesheet"]').forEach(link => {
    const path = resolveEpubPath(chapterPath, link.getAttribute('href') || '');
    const css = epub.files[path];
    if (css === undefined) {
      link.remove();
      return;
    }
    const style = document.createElement('style');
    style.textContent = rewriteCss(css, path);
    link.replaceWith(style);
  });

  document.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
      } else if (['src', 'poster', 'xlink:href'].includes(name)) {
        const uri = name === 'xlink:href' && attribute.value.startsWith('#')
          ? attribute.value
          : resourceUri(chapterPath, attribute.value);
        if (uri) element.setAttribute(attribute.name, uri);
        else element.removeAttribute(attribute.name);
      } else if (name === 'href') {
        if (element.tagName.toLowerCase() === 'a') {
          const value = attribute.value;
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) element.removeAttribute(attribute.name);
          else if (value.includes('#')) {
            const [path, fragment] = value.split('#', 2);
            if (!path || resolveEpubPath(chapterPath, path) === chapterPath) {
              element.setAttribute(attribute.name, `#${fragment}`);
            } else {
              element.removeAttribute(attribute.name);
            }
          }
          else element.removeAttribute(attribute.name);
        } else if (element.tagName.toLowerCase() !== 'link') {
          const uri = attribute.value.startsWith('#') ? attribute.value : resourceUri(chapterPath, attribute.value);
          if (uri) element.setAttribute(attribute.name, uri);
          else element.removeAttribute(attribute.name);
        }
      } else if (name === 'srcset') {
        const candidates = attribute.value.split(',').map(candidate => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          const uri = resourceUri(chapterPath, url);
          return uri ? `${uri} ${descriptor.join(' ')}`.trim() : '';
        }).filter(Boolean);
        if (candidates.length) element.setAttribute('srcset', candidates.join(', '));
        else element.removeAttribute('srcset');
      }
    }
  });

  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src data: blob:; img-src data: blob:; style-src data: 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";
  document.head.prepend(csp);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function openReader(idx) {
  const epub = epubInstances[idx];
  const chapterPath = epub.getFirstSpineFile();
  if (!chapterPath) {
    setStatus(t('err_no_preview'), 'error');
    return;
  }
  const frame = document.getElementById('reader-frame');
  frame.srcdoc = makePreviewDocument(epub, chapterPath);
  setModalState('modal-reader', true);
}

function closeReaderModal() {
  setModalState('modal-reader', false);
  document.getElementById('reader-frame').srcdoc = '';
}

async function handleCoverChange(idx, file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await epubInstances[idx].updateCover(bytes, file.type);
    const card = buildOutputHTML(idx);
    resultCards[idx].replaceWith(card);
    resultCards[idx] = card;
    refreshIcons();
  } catch (error) {
    console.error('Cover update failed:', error);
    setStatus(`${t('err_cover')}: ${error.message}`, 'error');
  }
}

function applyBulkMetadata() {
  const author = document.getElementById('bulk-author').value.trim();
  const series = document.getElementById('bulk-series').value.trim();
  if (!author && !series) return;

  try {
    epubInstances.forEach((epub, idx) => {
      const updates = {};
      if (author) updates.author = author;
      if (series) updates.series = series;
      epub.updateMetadata(updates);
      const card = buildOutputHTML(idx);
      resultCards[idx].replaceWith(card);
      resultCards[idx] = card;
      refreshIcons();
    });
    setStatus(t('bulk_meta_applied', epubInstances.length), 'success');
  } catch (error) {
    console.error('Bulk metadata update failed:', error);
    setStatus(`${t('err_metadata')}: ${error.message}`, 'error');
  }
}

fileInput.addEventListener('change', event => {
  handleFiles(event.target.files);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});
['dragleave', 'dragend'].forEach(type => dropZone.addEventListener(type, () => dropZone.classList.remove('drag-over')));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(event.dataTransfer.files);
});

document.getElementById('metadata-save').addEventListener('click', saveMetadataChanges);
document.getElementById('metadata-cancel').addEventListener('click', closeMetadataModal);
document.getElementById('reader-close').addEventListener('click', closeReaderModal);
document.getElementById('apply-bulk-metadata').addEventListener('click', applyBulkMetadata);

btnDlAll.addEventListener('click', async () => {
  const label = btnDlAll.querySelector('[data-i18n="download_all"]');
  const oldText = label.textContent;
  label.textContent = t('preparing_zip');
  btnDlAll.disabled = true;
  try {
    const blobWriter = new zip.BlobWriter('application/zip');
    const writer = new zip.ZipWriter(blobWriter, { extendedTimestamp: false });
    const names = new Set();
    for (let i = 0; i < epubInstances.length; i++) {
      const blob = await epubInstances[i].writeEPUB();
      let name = dlfilenames[i];
      let suffix = 1;
      while (names.has(name.toLowerCase())) {
        const dot = dlfilenames[i].lastIndexOf('.');
        name = dot > 0 ? `${dlfilenames[i].slice(0, dot)}-${suffix++}${dlfilenames[i].slice(dot)}` : `${dlfilenames[i]}-${suffix++}`;
      }
      names.add(name.toLowerCase());
      await writer.add(name, new zip.BlobReader(blob));
    }
    await writer.close();
    saveAs(await blobWriter.getData(), 'fixed-epubs.zip');
  } catch (error) {
    console.error('Bulk download failed:', error);
    setStatus(`${t('err_download')}: ${error.message}`, 'error');
  } finally {
    label.textContent = oldText;
    btnDlAll.disabled = false;
  }
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  currentLang = currentLang === 'en' ? 'pt' : currentLang === 'pt' ? 'es' : 'en';
  localStorage.setItem('kdp_lang', currentLang);
  applyI18N();
  resultCards.forEach((_, idx) => {
    const card = buildOutputHTML(idx);
    resultCards[idx].replaceWith(card);
    resultCards[idx] = card;
  });
  refreshIcons();
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('light-mode');
  localStorage.setItem('kdp_theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeMetadataModal();
    closeReaderModal();
  }
});

if (localStorage.getItem('kdp_theme') === 'light') document.body.classList.add('light-mode');
applyI18N();
if (window.lucide) window.lucide.createIcons();
