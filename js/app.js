import { EPUBBook } from './epub-engine.js';
import { I18N } from './constants.js';
import { buildConversionErrorCard, buildConvertedFileCard, buildErrorCard as renderErrorCard, buildOutputCard, refreshIcons, setModalState, setStatus as updateStatus } from './ui.js';
import { makePreviewDocument } from './preview.js';
import { isConverterAvailable, showConverterAvailability } from './converter-availability.js';

let currentLang = ['en', 'pt', 'es'].includes(localStorage.getItem('kdp_lang'))
  ? localStorage.getItem('kdp_lang')
  : 'en';
let epubInstances = [];
let filenames = [];
let dlfilenames = [];
let resultCards = [];
let convertedFiles = [];
let currentEditIdx = null;
let processingRun = 0;
let isProcessing = false;
let isDownloadingAll = false;
let converterAvailable = false;
const MAX_CONVERSION_BATCH = 5;

const outputDiv = document.getElementById('output');
const mainStatusDiv = document.getElementById('main_status');
const fileInput = document.getElementById('file');
const dropZone = document.getElementById('drop-zone');
const resultsToolbar = document.getElementById('results-toolbar');
const btnDlAll = document.getElementById('btnDlAll');
const btnClearResults = document.getElementById('btnClearResults');
const bulkEditContainer = document.getElementById('bulk-edit-container');
const processingMode = document.getElementById('processing-mode');
const conversionOptions = document.getElementById('conversion-options');

function t(key, n, errors, total) {
  let text = I18N[currentLang][key] || I18N.en[key] || key;
  if (n !== undefined) text = text.replaceAll('{n}', n);
  if (errors !== undefined) text = text.replaceAll('{errors}', errors);
  if (total !== undefined) text = text.replaceAll('{total}', total);
  return text;
}

function setStatus(message, state = 'info') {
  updateStatus(mainStatusDiv, message, state);
}

function buildOutputHTML(idx) {
  return buildOutputCard({
    epub: epubInstances[idx],
    filename: filenames[idx],
    t,
    onCoverChange: file => handleCoverChange(idx, file),
    onEdit: () => openEditor(idx),
    onPreview: () => openReader(idx),
    onDownload: () => downloadEpub(idx)
  });
}

function applyI18N() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}

function updateProcessingMode() {
  const converting = processingMode.value === 'convert';
  conversionOptions.hidden = !converting;
  fileInput.accept = converting ? '.epub,.mobi,.azw3' : '.epub';
  dropZone.querySelector('p').textContent = t(converting ? 'convert_upload' : 'upload');
  dropZone.dataset.mode = converting ? 'convert' : 'repair';
}

async function handleFiles(files) {
  if (processingMode.value === 'convert') {
    await handleConversionFiles(files);
    return;
  }
  const fileArray = Array.from(files).filter(file => /\.epub$/i.test(file.name));
  if (!fileArray.length || isProcessing || isDownloadingAll) return;

  isProcessing = true;
  const run = ++processingRun;
  fileInput.disabled = true;
  dropZone.setAttribute('aria-disabled', 'true');
  closeMetadataModal();
  closeReaderModal();
  epubInstances.forEach(epub => {
    if (epub.coverUrl) URL.revokeObjectURL(epub.coverUrl);
  });
  convertedFiles.forEach(url => URL.revokeObjectURL(url));
  convertedFiles = [];
  setStatus(t('processing'));
  outputDiv.replaceChildren();
  resultsToolbar.style.display = 'none';
  btnDlAll.style.display = 'none';
  btnClearResults.style.display = 'none';
  bulkEditContainer.style.display = 'none';
  epubInstances = [];
  filenames = [];
  dlfilenames = [];
  resultCards = [];

  const startTime = performance.now();
  const results = new Array(fileArray.length);
  let nextFile = 0;
  const processNextFile = async () => {
    while (nextFile < fileArray.length) {
      const index = nextFile++;
      const file = fileArray[index];
      let epub;
      try {
        epub = new EPUBBook();
        await epub.readEPUB(file);
        epub.parseMetadata();
        epub.findCover();
        await epub.runAllOptimizations();
        results[index] = { epub, name: file.name, error: null };
      } catch (error) {
        console.error('Error processing:', file.name, error);
        if (epub?.coverUrl) URL.revokeObjectURL(epub.coverUrl);
        results[index] = { epub: null, name: file.name, error: error.message };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(2, fileArray.length) }, processNextFile));
  } catch (error) {
    console.error('Batch processing failed:', error);
    setStatus(`${t('err_processing')}: ${error.message}`, 'error');
    return;
  } finally {
    isProcessing = false;
    fileInput.disabled = false;
    dropZone.removeAttribute('aria-disabled');
  }
  if (run !== processingRun) {
    results.forEach(result => {
      if (result.epub?.coverUrl) URL.revokeObjectURL(result.epub.coverUrl);
    });
    return;
  }

  results.forEach(result => {
    if (!result.epub) {
      outputDiv.appendChild(renderErrorCard(result.name, result.error, t));
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

  const failedCount = results.filter(result => !result.epub).length;
  const successCount = epubInstances.length;
  setStatus(failedCount ? t('done_with_errors', fileArray.length, failedCount) : t('done'), failedCount ? 'warning' : 'success');
  if (successCount > 1) {
    btnDlAll.style.display = 'flex';
  }
  if (successCount > 1) {
    bulkEditContainer.style.display = 'block';
  }
  if (results.length) {
    resultsToolbar.style.display = 'flex';
    btnClearResults.style.display = 'inline-flex';
  }
  console.log(`Processed ${fileArray.length} files in ${(performance.now() - startTime).toFixed(2)}ms`);
}

function filenameFromResponse(response, originalName, target) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Use a safe fallback when the response filename is malformed.
    }
  }
  return `${originalName.replace(/\.[^.]+$/, '')}.${target}`;
}

async function convertFile(file, target) {
  const endpoint = new URL('/api/converter/convert', window.location.origin);
  endpoint.searchParams.set('target', target);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 210_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Source-Filename': encodeURIComponent(file.name)
      },
      body: file,
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || t('conversion_failed'));
    }
    return {
      name: filenameFromResponse(response, file.name, target),
      blob: await response.blob()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleConversionFiles(files) {
  const selectedFiles = Array.from(files);
  const unsupportedFiles = selectedFiles.filter(file => !/\.(epub|mobi|azw3)$/i.test(file.name));
  if (!selectedFiles.length) return;
  if (isProcessing || isDownloadingAll) return;
  if (unsupportedFiles.length) {
    setStatus(t('conversion_unsupported_files', unsupportedFiles.length), 'error');
    return;
  }
  const fileArray = selectedFiles;
  if (fileArray.length > MAX_CONVERSION_BATCH) {
    setStatus(t('conversion_batch_too_large'), 'error');
    return;
  }
  if (fileArray.some(file => file.size > 4 * 1024 * 1024)) {
    setStatus(t('conversion_file_too_large'), 'error');
    return;
  }

  isProcessing = true;
  const run = ++processingRun;
  const target = document.getElementById('conversion-target').value;
  fileInput.disabled = true;
  processingMode.disabled = true;
  document.getElementById('conversion-target').disabled = true;
  dropZone.setAttribute('aria-disabled', 'true');
  let failureCount = 0;
  try {
    if (!converterAvailable) {
      converterAvailable = await isConverterAvailable();
      const statusElement = document.getElementById('conversion-status');
      statusElement.hidden = converterAvailable;
      if (!converterAvailable) {
        statusElement.querySelector('[data-converter-message]').textContent = t('conversion_unavailable');
        setStatus(t('conversion_unavailable_action'), 'error');
        return;
      }
    }

    closeMetadataModal();
    closeReaderModal();
    epubInstances.forEach(epub => {
      if (epub.coverUrl) URL.revokeObjectURL(epub.coverUrl);
    });
    convertedFiles.forEach(url => URL.revokeObjectURL(url));
    epubInstances = [];
    filenames = [];
    dlfilenames = [];
    resultCards = [];
    convertedFiles = [];
    outputDiv.replaceChildren();
    resultsToolbar.style.display = 'none';
    btnDlAll.style.display = 'none';
    btnClearResults.style.display = 'none';
    bulkEditContainer.style.display = 'none';
    setStatus(t('processing'));

    for (let index = 0; index < fileArray.length; index++) {
      const file = fileArray[index];
      setStatus(t('conversion_processing', index + 1, undefined, fileArray.length));
      try {
        const sourceFormat = file.name.split('.').pop().toLowerCase();
        if (sourceFormat === target) throw new Error(t('conversion_same_format'));
        const converted = await convertFile(file, target);
        if (run !== processingRun) return;
        const url = URL.createObjectURL(converted.blob);
        convertedFiles.push(url);
        const card = buildConvertedFileCard({ filename: converted.name, downloadUrl: url, t });
        outputDiv.appendChild(card);
      } catch (error) {
        console.error('E-book conversion failed:', file.name, error);
        failureCount++;
        outputDiv.appendChild(buildConversionErrorCard(file.name, error.message || t('conversion_failed')));
      }
    }
    setStatus(failureCount ? t('done_with_errors', fileArray.length, failureCount) : t('conversion_complete'), failureCount ? 'warning' : 'success');
    resultsToolbar.style.display = 'flex';
    btnClearResults.style.display = 'inline-flex';
  } catch (error) {
    console.error('Conversion batch failed:', error);
    setStatus(`${t('conversion_failed')}: ${error.message}`, 'error');
  } finally {
    isProcessing = false;
    fileInput.disabled = false;
    processingMode.disabled = false;
    document.getElementById('conversion-target').disabled = false;
    dropZone.removeAttribute('aria-disabled');
    refreshIcons();
  }
}

function clearResults() {
  if (isProcessing || isDownloadingAll) return;
  closeMetadataModal();
  closeReaderModal();
  epubInstances.forEach(epub => {
    if (epub.coverUrl) URL.revokeObjectURL(epub.coverUrl);
  });
  convertedFiles.forEach(url => URL.revokeObjectURL(url));
  epubInstances = [];
  convertedFiles = [];
  filenames = [];
  dlfilenames = [];
  resultCards = [];
  document.getElementById('bulk-author').value = '';
  document.getElementById('bulk-series').value = '';
  outputDiv.replaceChildren();
  resultsToolbar.style.display = 'none';
  btnDlAll.style.display = 'none';
  btnClearResults.style.display = 'none';
  bulkEditContainer.style.display = 'none';
  setStatus(t('results_cleared'), 'success');
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

processingMode.addEventListener('change', () => {
  updateProcessingMode();
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
btnClearResults.addEventListener('click', clearResults);

btnDlAll.addEventListener('click', async () => {
  if (isDownloadingAll || isProcessing) return;
  isDownloadingAll = true;
  const label = btnDlAll.querySelector('[data-i18n="download_all"]');
  const oldText = label.textContent;
  label.textContent = t('preparing_zip');
  btnDlAll.disabled = true;
  btnClearResults.disabled = true;
  fileInput.disabled = true;
  dropZone.setAttribute('aria-disabled', 'true');
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
    btnClearResults.disabled = false;
    fileInput.disabled = false;
    dropZone.removeAttribute('aria-disabled');
    isDownloadingAll = false;
  }
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  currentLang = currentLang === 'en' ? 'pt' : currentLang === 'pt' ? 'es' : 'en';
  localStorage.setItem('kdp_lang', currentLang);
  applyI18N();
  updateProcessingMode();
  resultCards.forEach((_, idx) => {
    const card = buildOutputHTML(idx);
    resultCards[idx].replaceWith(card);
    resultCards[idx] = card;
  });
  refreshIcons();
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('light-mode');
  const isLightMode = document.body.classList.contains('light-mode');
  localStorage.setItem('kdp_theme', isLightMode ? 'light' : 'dark');
  const icon = document.createElement('i');
  icon.id = 'theme-icon';
  icon.setAttribute('data-lucide', isLightMode ? 'sun' : 'moon');
  icon.setAttribute('aria-hidden', 'true');
  document.getElementById('theme-toggle').replaceChildren(icon);
  refreshIcons();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeMetadataModal();
    closeReaderModal();
  }
});

if (localStorage.getItem('kdp_theme') === 'light') {
  document.body.classList.add('light-mode');
  document.querySelector('#theme-toggle [data-lucide]').setAttribute('data-lucide', 'sun');
}
applyI18N();
updateProcessingMode();
refreshIcons();
void showConverterAvailability({
  t,
  refreshIcons,
  statusElement: document.getElementById('conversion-status')
}).then(available => {
  converterAvailable = available;
});
