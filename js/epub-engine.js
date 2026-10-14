import {
    encodeEpubPath,
    normalizeEpubPath,
    relativeEpubPath,
    resolveEpubPath,
    decodeEpubText,
    normalizeTextEncoding,
    simplifyLanguage,
    sniffImageMimeType,
    perfomCompression
} from './utils.js';

const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_ARCHIVE_ENTRIES = 20000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function elementsByLocalName(root, localName) {
    return Array.from(root.getElementsByTagName('*')).filter(element => element.localName === localName);
}

function firstByLocalName(root, localName) {
    return elementsByLocalName(root, localName)[0] || null;
}

function getTextByLocalName(root, localName) {
    return elementsByLocalName(root, localName)
        .find(element => element.namespaceURI === DC_NAMESPACE)?.textContent?.trim() || '';
}

export class EPUBBook {
    constructor() {
        this.optimizations = [];
        this.metadata = { title: '', author: '', language: '', series: '' };
        this.opfPath = '';
        this.coverUrl = null;
        this.coverPath = '';
        this.files = Object.create(null);
        this.binary_files = Object.create(null);
    }

    addOptimization(id, status, payload = null) {
        this.optimizations.push({ id, status, payload });
    }

    async readEPUB(blob) {
        const reader = new zip.ZipReader(new zip.BlobReader(blob));
        try {
            const entries = await reader.getEntries();
            if (entries.length > MAX_ARCHIVE_ENTRIES) {
                throw new Error(`EPUB contains too many archive entries (limit: ${MAX_ARCHIVE_ENTRIES})`);
            }

            let totalUncompressedBytes = 0;
            for (const entry of entries) {
                const filename = entry.filename;
                if (entry.directory) continue;
                const uncompressedSize = Number(entry.uncompressedSize);
                if (Number.isFinite(uncompressedSize) && uncompressedSize > 0) {
                    totalUncompressedBytes += uncompressedSize;
                    if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
                        throw new Error('EPUB expands beyond the 512 MiB processing limit');
                    }
                }
                const ext = filename.split('.').pop().toLowerCase();
                if (filename === 'mimetype' || ['html', 'xhtml', 'htm', 'xml', 'svg', 'css', 'opf', 'ncx', 'txt'].includes(ext)) {
                    const bytes = await entry.getData(new zip.Uint8ArrayWriter());
                    this.files[filename] = decodeEpubText(bytes);
                } else {
                    this.binary_files[filename] = await entry.getData(new zip.Uint8ArrayWriter());
                }
            }
        } finally {
            await reader.close();
        }
    }

    parseMetadata() {
        const parser = new DOMParser();
        if (!('META-INF/container.xml' in this.files)) throw new Error('EPUB is missing META-INF/container.xml');
        const meta_inf = parser.parseFromString(this.files['META-INF/container.xml'], 'text/xml');
        if (firstByLocalName(meta_inf, 'parsererror')) throw new Error('EPUB container.xml is not valid XML');

        for (const rootfile of elementsByLocalName(meta_inf, 'rootfile')) {
            if (rootfile.getAttribute('media-type') === 'application/oebps-package+xml') {
                this.opfPath = normalizeEpubPath(rootfile.getAttribute('full-path') || '');
                break;
            }
        }

        if (!this.opfPath || !(this.opfPath in this.files)) {
            throw new Error('EPUB container does not reference a readable package document');
        }

        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');
        if (firstByLocalName(opf, 'parsererror')) throw new Error('EPUB package document is not valid XML');
        this.metadata.title = getTextByLocalName(opf, 'title');
        this.metadata.author = getTextByLocalName(opf, 'creator');
        this.metadata.language = getTextByLocalName(opf, 'language');

        const metaSeries = elementsByLocalName(opf, 'meta').find(meta => meta.getAttribute('name') === 'calibre:series');
        if (metaSeries) this.metadata.series = metaSeries.getAttribute('content') || '';
    }

    findCover() {
        const parser = new DOMParser();
        if (!(this.opfPath in this.files)) return;
        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');

        if (firstByLocalName(opf, 'parsererror')) throw new Error('EPUB package document is not valid XML');
        const metaCover = elementsByLocalName(opf, 'meta').find(meta => meta.getAttribute('name') === 'cover');
        let coverId = metaCover?.getAttribute('content');

        let coverItem = elementsByLocalName(opf, 'item')
            .find(item => item.getAttribute('properties')?.split(/\s+/).includes('cover-image'));
        if (!coverItem && coverId) {
            coverItem = elementsByLocalName(opf, 'item').find(item => item.getAttribute('id') === coverId);
        }

        if (coverItem) {
            this.coverPath = coverItem.getAttribute('href');
            const fullPath = resolveEpubPath(this.opfPath, this.coverPath);

            if (fullPath in this.binary_files) {
                const mediaType = coverItem.getAttribute('media-type') || 'image/jpeg';
                const blob = new Blob([this.binary_files[fullPath]], { type: mediaType });
                if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
                this.coverUrl = URL.createObjectURL(blob);
            }
        }
    }

    async runAllOptimizations() {
        this.detectAndFixLanguage();
        this.fixEncoding();
        this.fixBodyIdLink();
        this.fixStrayIMG();
        this.generateTOC();
        this.validateLinks();
        this.filterCSS();
        await this.splitChapters();
        this.optimizePageFlip();
        this.runA11yAssistant();
        await this.compressImages();
        this.preserveFonts();
    }

    updateMetadata(newMeta) {
        if (!this.opfPath || !(this.opfPath in this.files)) {
            throw new Error('Cannot update metadata: EPUB package document is missing');
        }
        const parser = new DOMParser();
        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');
        if (firstByLocalName(opf, 'parsererror')) throw new Error('Cannot update metadata: package document is not valid XML');
        const metadata = firstByLocalName(opf, 'metadata');
        if (!metadata) throw new Error('Cannot update metadata: package metadata element is missing');

        const setTag = (tagName, value) => {
            const localName = tagName.slice(tagName.indexOf(':') + 1);
            let tag = elementsByLocalName(metadata, localName)
                .find(element => element.namespaceURI === DC_NAMESPACE);
            if (!tag) {
                let prefix = opf.lookupPrefix(DC_NAMESPACE);
                if (!prefix) {
                    prefix = 'dc';
                    opf.documentElement.setAttributeNS(XMLNS_NAMESPACE, `xmlns:${prefix}`, DC_NAMESPACE);
                }
                tag = opf.createElementNS(DC_NAMESPACE, `${prefix}:${localName}`);
                metadata.appendChild(tag);
            }
            tag.textContent = value;
        };

        if (Object.hasOwn(newMeta, 'title')) setTag('dc:title', newMeta.title);
        if (Object.hasOwn(newMeta, 'author')) setTag('dc:creator', newMeta.author);
        if (Object.hasOwn(newMeta, 'language')) setTag('dc:language', newMeta.language);
        if (Object.hasOwn(newMeta, 'series')) {
            let series = elementsByLocalName(metadata, 'meta')
                .find(meta => meta.getAttribute('name') === 'calibre:series');
            if (!series) {
                series = opf.createElementNS(metadata.namespaceURI, 'meta');
                series.setAttribute('name', 'calibre:series');
                metadata.appendChild(series);
            }
            series.setAttribute('content', newMeta.series);
        }

        this.metadata = { ...this.metadata, ...newMeta };
        this.files[this.opfPath] = new XMLSerializer().serializeToString(opf);
        this.addOptimization('opt_metadata', 'applied');
    }

    detectAndFixLanguage() {
        const allowed = ['af', 'ar', 'az', 'be', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'kn', 'ko', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'nb', 'nl', 'nn', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh'];

        let current = simplifyLanguage(this.metadata.language || '');
        if (allowed.includes(current)) {
            this.addOptimization('opt_lang_verified', 'verified', current);
            return;
        }

        this.addOptimization('opt_lang_warning', 'warning');
    }

    fixEncoding() {
        let count = 0;
        for (const f in this.files) {
            const original = this.files[f];
            const content = normalizeTextEncoding(original, f);
            this.files[f] = content;
            if (content !== original) count++;
        }
        if (count) this.addOptimization('opt_encoding_applied', 'applied', count);
        else this.addOptimization('opt_encoding_verified', 'verified');
    }

    fixBodyIdLink() {
        const parser = new DOMParser();
        const bodyIDList = [];

        for (const f in this.files) {
            if (/\.(?:html?|xhtml)$/i.test(f)) {
                const dom = parser.parseFromString(this.files[f], 'text/html');
                const body = dom.getElementsByTagName('body')[0];
                if (body?.id) {
                    bodyIDList.push(`${normalizeEpubPath(f)}#${body.id}`);
                }
            }
        }

        let count = 0;
        for (const f in this.files) {
            if (!/\.(?:html?|xhtml)$/i.test(f)) continue;
            const doc = parser.parseFromString(this.files[f], 'text/html');
            let changed = false;
            doc.querySelectorAll('a[href]').forEach(link => {
                const href = link.getAttribute('href');
                if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
                const [pathPart, fragment] = href.split('#', 2);
                if (!fragment) return;
                const targetPath = pathPart ? resolveEpubPath(f, pathPart) : normalizeEpubPath(f);
                let decodedFragment = fragment;
                try {
                    decodedFragment = decodeURIComponent(fragment);
                } catch {
                    return;
                }
                if (!bodyIDList.includes(`${targetPath}#${decodedFragment}`)) return;
                link.setAttribute('href', encodeEpubPath(relativeEpubPath(f, targetPath)));
                changed = true;
                count++;
            });
            if (changed) this.files[f] = new XMLSerializer().serializeToString(doc);
        }
        if (count) this.addOptimization('opt_body_id_applied', 'applied', count);
        else this.addOptimization('opt_body_id_verified', 'verified');
    }

    fixStrayIMG() {
        const parser = new DOMParser();
        let count = 0;
        for (const f in this.files) {
            if (/\.(?:html?|xhtml)$/i.test(f)) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                const imgs = doc.querySelectorAll('img:not([src])');
                if (imgs.length) {
                    imgs.forEach(img => img.remove());
                    this.files[f] = new XMLSerializer().serializeToString(doc);
                    count += imgs.length;
                }
            }
        }
        if (count) this.addOptimization('opt_stray_img_applied', 'applied', count);
        else this.addOptimization('opt_stray_img_verified', 'verified');
    }

    generateTOC() {
        const parser = new DOMParser();
        if (!this.opfPath || !(this.opfPath in this.files)) {
            this.addOptimization('opt_toc_warning', 'warning');
            return;
        }
        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');
        if (firstByLocalName(opf, 'parsererror')) {
            this.addOptimization('opt_toc_warning', 'warning');
            return;
        }

        const items = elementsByLocalName(opf, 'item');
        const hasTOC = items.some(item =>
            item.getAttribute('properties')?.split(/\s+/).includes('nav') ||
            item.getAttribute('media-type') === 'application/x-dtbncx+xml'
        );

        if (hasTOC) {
            this.addOptimization('opt_toc_verified', 'verified');
            return;
        }

        const manifest = new Map(items.map(item => [
            item.getAttribute('id'),
            resolveEpubPath(this.opfPath, item.getAttribute('href') || '')
        ]));
        const spine = elementsByLocalName(opf, 'spine')[0];
        const readingOrder = spine
            ? elementsByLocalName(spine, 'itemref')
                .filter(itemref => itemref.getAttribute('linear') !== 'no')
                .map(itemref => manifest.get(itemref.getAttribute('idref')))
                .filter(path => path && this.files[path] !== undefined)
            : [];
        const headings = [];
        let generatedId = 0;
        for (const f of readingOrder) {
            if (!/\.(?:html?|xhtml)$/i.test(f)) continue;
            const doc = parser.parseFromString(this.files[f], 'text/html');
            const hTags = doc.querySelectorAll('h1, h2, h3');
            hTags.forEach(h => {
                if (h.textContent.trim()) {
                    if (!h.id) {
                        const ids = new Set(Array.from(doc.querySelectorAll('[id]'), element => element.id));
                        do {
                            h.id = `kdp-toc-${++generatedId}`;
                        } while (ids.has(h.id));
                    }
                    headings.push({ title: h.textContent.trim(), path: f, id: h.id });
                }
            });
            if (hTags.length > 0) this.files[f] = new XMLSerializer().serializeToString(doc);
        }

        if (headings.length === 0) {
            this.addOptimization('opt_toc_warning', 'warning');
            return;
        }

        const opfDir = this.opfPath.includes('/') ? this.opfPath.substring(0, this.opfPath.lastIndexOf('/') + 1) : '';
        const navPath = normalizeEpubPath(opfDir + 'nav.xhtml');
        const escapeHtml = value => value.replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;'
        })[char]);
        const navHtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      ${headings.map(h => {
            const link = `${encodeEpubPath(relativeEpubPath(navPath, h.path))}#${encodeURIComponent(h.id)}`;
            return `<li><a href="${escapeHtml(link)}">${escapeHtml(h.title)}</a></li>`;
        }).join('\n      ')}
    </ol>
  </nav>
</body>
</html>`;

        this.files[navPath] = navHtml;

        // Try to register in manifest, but don't fail if OPF is broken
        try {
            let manifest = firstByLocalName(opf, 'manifest');
            if (!manifest) {
                // Create manifest if it doesn't exist
                const packageEl = opf.documentElement;
                if (packageEl) {
                    manifest = opf.createElementNS(packageEl.namespaceURI, 'manifest');
                    packageEl.appendChild(manifest);
                }
            }

            if (manifest) {
                let navItem = items.find(item =>
                    item.getAttribute('properties')?.split(/\s+/).includes('nav') ||
                    normalizeEpubPath(resolveEpubPath(this.opfPath, item.getAttribute('href') || '')) === navPath
                );
                if (!navItem) {
                    navItem = opf.createElementNS(manifest.namespaceURI, 'item');
                    let id = 'nav';
                    let suffix = 1;
                    while (opf.getElementById(id) || items.some(item => item.getAttribute('id') === id)) {
                        id = `nav-${suffix++}`;
                    }
                    navItem.setAttribute('id', id);
                    manifest.appendChild(navItem);
                } else if (!navItem.getAttribute('id')) {
                    let suffix = items.length + 1;
                    let id = `nav-${suffix++}`;
                    while (items.some(item => item.getAttribute('id') === id)) {
                        id = `nav-${suffix++}`;
                    }
                    navItem.setAttribute('id', id);
                }
                navItem.setAttribute('href', relativeEpubPath(this.opfPath, navPath));
                navItem.setAttribute('media-type', 'application/xhtml+xml');
                const properties = new Set((navItem.getAttribute('properties') || '').split(/\s+/).filter(Boolean));
                properties.add('nav');
                navItem.setAttribute('properties', [...properties].join(' '));

                this.files[this.opfPath] = new XMLSerializer().serializeToString(opf);
                this.addOptimization('opt_toc_applied', 'applied', headings.length);
            } else {
                this.addOptimization('opt_toc_applied_skip', 'warning', headings.length);
            }
        } catch (e) {
            console.error('Unable to register generated EPUB navigation:', e);
            this.addOptimization('opt_toc_applied_fail', 'warning', headings.length);
        }
    }

    validateLinks() {
        const parser = new DOMParser();
        const allIds = new Set();

        for (const f in this.files) {
            if (/\.(?:html?|xhtml)$/i.test(f)) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                doc.querySelectorAll('[id]').forEach(el => allIds.add(`${normalizeEpubPath(f)}#${el.id}`));
                allIds.add(normalizeEpubPath(f));
            }
        }

        let fixedCount = 0;
        let unresolvedCount = 0;
        for (const f in this.files) {
            if (/\.(?:html?|xhtml)$/i.test(f)) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                const links = doc.querySelectorAll('a[href]');
                let changed = false;

                links.forEach(link => {
                    const href = link.getAttribute('href');
                    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
                    const [pathPart, fragment = ''] = href.split('#', 2);
                    const targetFile = pathPart ? resolveEpubPath(f, pathPart) : normalizeEpubPath(f);
                    let decodedFragment = fragment;
                    try {
                        decodedFragment = decodeURIComponent(fragment);
                    } catch {
                        return;
                    }
                    const target = decodedFragment ? `${targetFile}#${decodedFragment}` : targetFile;
                    if (allIds.has(target)) return;

                    if (allIds.has(targetFile)) {
                        link.setAttribute('href', `${encodeEpubPath(relativeEpubPath(f, targetFile))}${decodedFragment ? `#${encodeURIComponent(decodedFragment)}` : ''}`);
                        changed = true;
                        fixedCount++;
                    } else if (fragment && !pathPart) {
                        link.removeAttribute('href');
                        changed = true;
                        fixedCount++;
                    } else {
                        unresolvedCount++;
                    }
                });

                if (changed) this.files[f] = new XMLSerializer().serializeToString(doc);
            }
        }

        if (fixedCount > 0) this.addOptimization('opt_links_applied', 'applied', fixedCount);
        if (unresolvedCount > 0) this.addOptimization('opt_links_warning', 'warning', unresolvedCount);
        if (!fixedCount && !unresolvedCount) this.addOptimization('opt_links_verified', 'verified');
    }

    filterCSS() {
        let count = 0;
        for (const f in this.files) if (f.toLowerCase().endsWith('.css')) count++;
        if (count) this.addOptimization('opt_css_skipped', 'skipped', count);
        else this.addOptimization('opt_css_verified', 'verified');
    }

    async splitChapters() {
        this.addOptimization('opt_split_skipped', 'skipped');
    }

    optimizePageFlip() {
        this.addOptimization('opt_page_flip_skipped', 'skipped');
    }

    runA11yAssistant() {
        const parser = new DOMParser();
        let count = 0;
        for (const f in this.files) {
            if (/\.(?:html?|xhtml)$/i.test(f)) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                count += doc.querySelectorAll('img:not([alt])').length;
            }
        }
        if (count) this.addOptimization('opt_a11y_warning', 'warning', count);
        else this.addOptimization('opt_a11y_verified', 'verified');
    }

    async compressImages() {
        let count = 0;
        let failed = 0;
        for (const f in this.binary_files) {
            if (f.match(/\.(jpg|jpeg|png)$/i) && this.binary_files[f].length > 1024 * 500) {
                try {
                    const type = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
                    const original = this.binary_files[f];
                    const compressed = await perfomCompression(new Blob([original], { type }));
                    if (compressed.length < original.length) {
                        this.binary_files[f] = compressed;
                        count++;
                    }
                } catch (e) {
                    console.error('Compression failed:', f, e);
                    failed++;
                }
            }
        }
        if (count) this.addOptimization('opt_images_applied', 'applied', count);
        if (failed) this.addOptimization('opt_images_failed', 'warning', failed);
        if (!count && !failed) this.addOptimization('opt_images_verified', 'verified');
    }

    preserveFonts() {
        let count = 0;
        const fontExts = ['.ttf', '.otf', '.woff', '.woff2'];
        for (const f in this.binary_files) {
            if (fontExts.some(ext => f.toLowerCase().endsWith(ext))) {
                count++;
            }
        }
        if (count) this.addOptimization('opt_fonts_skipped', 'skipped', count);
        else this.addOptimization('opt_fonts_verified', 'verified');
    }

    getFirstSpineFile() {
        if (!this.opfPath || !(this.opfPath in this.files)) return '';
        const opf = new DOMParser().parseFromString(this.files[this.opfPath], 'text/xml');
        if (firstByLocalName(opf, 'parsererror')) return '';
        const manifest = new Map();
        for (const item of elementsByLocalName(opf, 'item')) {
            manifest.set(item.getAttribute('id'), resolveEpubPath(this.opfPath, item.getAttribute('href') || ''));
        }
        const spine = elementsByLocalName(opf, 'spine')[0];
        if (!spine) return '';
        for (const itemref of elementsByLocalName(spine, 'itemref')) {
            if (itemref.getAttribute('linear') === 'no') continue;
            const path = manifest.get(itemref.getAttribute('idref'));
            if (path && (this.files[path] !== undefined) && /\.(?:html?|xhtml)$/i.test(path)) return path;
        }
        return '';
    }

    async writeEPUB() {
        if (this.files.mimetype?.trim() !== 'application/epub+zip') {
            throw new Error('Cannot create EPUB: required mimetype entry is missing or invalid');
        }
        const blobWriter = new zip.BlobWriter('application/epub+zip');
        const writer = new zip.ZipWriter(blobWriter, { extendedTimestamp: false });

        if ('mimetype' in this.files) {
            await writer.add('mimetype', new zip.TextReader('application/epub+zip'), { level: 0 });
        }
        for (const f in this.files) {
            if (f !== 'mimetype') await writer.add(f, new zip.TextReader(this.files[f]));
        }
        for (const f in this.binary_files) {
            await writer.add(f, new zip.Uint8ArrayReader(this.binary_files[f]));
        }
        await writer.close();
        return blobWriter.getData();
    }

    async updateCover(uint8, type) {
        const mediaType = sniffImageMimeType(uint8);
        if (!mediaType) throw new Error('Cover image data must be a valid JPEG or PNG');
        if (type && type !== mediaType) throw new Error('Cover image type does not match its file contents');
        if (!this.opfPath || !(this.opfPath in this.files)) throw new Error('Cannot update cover: EPUB package document is missing');

        const opf = new DOMParser().parseFromString(this.files[this.opfPath], 'text/xml');
        if (firstByLocalName(opf, 'parsererror')) throw new Error('Cannot update cover: package document is not valid XML');
        const manifest = firstByLocalName(opf, 'manifest');
        if (!manifest) throw new Error('Cannot update cover: package manifest is missing');
        const metadata = firstByLocalName(opf, 'metadata');
        if (!metadata) throw new Error('Cannot update cover: package metadata element is missing');

        let coverItem = elementsByLocalName(opf, 'item')
            .find(item => item.getAttribute('properties')?.split(/\s+/).includes('cover-image'));
        if (!coverItem) {
            const coverMeta = elementsByLocalName(metadata, 'meta').find(meta => meta.getAttribute('name') === 'cover');
            const coverId = coverMeta?.getAttribute('content');
            if (coverId) coverItem = elementsByLocalName(opf, 'item').find(item => item.getAttribute('id') === coverId);
        }

        const extension = mediaType === 'image/png' ? '.png' : '.jpg';
        let itemId;
        let coverFile;
        if (coverItem) {
            itemId = coverItem.getAttribute('id');
            if (!itemId) {
                itemId = 'cover-image';
                let suffix = 1;
                while (elementsByLocalName(opf, 'item').some(item => item.getAttribute('id') === itemId)) {
                    itemId = `cover-image-${suffix++}`;
                }
                coverItem.setAttribute('id', itemId);
            }
            const oldFile = resolveEpubPath(this.opfPath, coverItem.getAttribute('href') || '');
            const oldExtension = oldFile.match(/\.[^.]+$/)?.[0].toLowerCase();
            coverFile = oldExtension === extension ? oldFile : normalizeEpubPath(oldFile.replace(/\.[^.]+$/, '') + extension);
            coverItem.setAttribute('href', relativeEpubPath(this.opfPath, coverFile));
            coverItem.setAttribute('media-type', mediaType);
            const properties = new Set((coverItem.getAttribute('properties') || '').split(/\s+/).filter(Boolean));
            properties.add('cover-image');
            coverItem.setAttribute('properties', [...properties].join(' '));
        } else {
            const opfDir = this.opfPath.includes('/') ? this.opfPath.slice(0, this.opfPath.lastIndexOf('/') + 1) : '';
            coverFile = normalizeEpubPath(`${opfDir}cover${extension}`);
            let suffix = 1;
            while (this.binary_files[coverFile] || this.files[coverFile]) {
                coverFile = normalizeEpubPath(`${opfDir}cover-${suffix++}${extension}`);
            }
            itemId = 'cover-image';
            let idSuffix = 1;
            while (elementsByLocalName(opf, 'item').some(item => item.getAttribute('id') === itemId)) {
                itemId = `cover-image-${idSuffix++}`;
            }
            coverItem = opf.createElementNS(manifest.namespaceURI, 'item');
            coverItem.setAttribute('id', itemId);
            coverItem.setAttribute('properties', 'cover-image');
            coverItem.setAttribute('href', relativeEpubPath(this.opfPath, coverFile));
            coverItem.setAttribute('media-type', mediaType);
            manifest.appendChild(coverItem);
        }

        let coverMeta = elementsByLocalName(metadata, 'meta').find(meta => meta.getAttribute('name') === 'cover');
        if (!coverMeta) {
            coverMeta = opf.createElementNS(metadata.namespaceURI, 'meta');
            coverMeta.setAttribute('name', 'cover');
            metadata.appendChild(coverMeta);
        }
        if (coverMeta) coverMeta.setAttribute('content', itemId);
        this.coverPath = coverItem.getAttribute('href');
        this.binary_files[coverFile] = uint8;
        this.files[this.opfPath] = new XMLSerializer().serializeToString(opf);
        this.findCover();
        this.addOptimization('opt_cover_applied', 'applied');
    }
}
