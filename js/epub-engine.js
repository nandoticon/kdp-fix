import {
    encodeEpubPath,
    normalizeEpubPath,
    relativeEpubPath,
    resolveEpubPath,
    simplifyLanguage,
    perfomCompression
} from './utils.js';

export class EPUBBook {
    constructor() {
        this.optimizations = [];
        this.metadata = { title: '', author: '', language: '', series: '' };
        this.opfPath = '';
        this.coverUrl = null;
        this.coverPath = '';
        this.files = {};
        this.binary_files = {};
    }

    addOptimization(id, status, payload = null) {
        this.optimizations.push({ id, status, payload });
    }

    async readEPUB(blob) {
        const reader = new zip.ZipReader(new zip.BlobReader(blob));
        const entries = await reader.getEntries();

        for (const entry of entries) {
            const filename = entry.filename;
            if (entry.directory) continue;
            const ext = filename.split('.').pop().toLowerCase();
            if (filename === 'mimetype' || ['html', 'xhtml', 'htm', 'xml', 'svg', 'css', 'opf', 'ncx', 'txt'].includes(ext)) {
                this.files[filename] = await entry.getData(new zip.TextWriter('utf-8'));
            } else {
                this.binary_files[filename] = await entry.getData(new zip.Uint8ArrayWriter());
            }
        }
        await reader.close();
    }

    parseMetadata() {
        const parser = new DOMParser();
        if (!('META-INF/container.xml' in this.files)) return;
        const meta_inf = parser.parseFromString(this.files['META-INF/container.xml'], 'text/xml');

        for (const rootfile of meta_inf.getElementsByTagName('rootfile')) {
            if (rootfile.getAttribute('media-type') === 'application/oebps-package+xml') {
                this.opfPath = rootfile.getAttribute('full-path');
                break;
            }
        }

        if (!(this.opfPath in this.files)) return;

        try {
            const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');
            this.metadata.title = opf.getElementsByTagName('dc:title')[0]?.textContent || '';
            this.metadata.author = opf.getElementsByTagName('dc:creator')[0]?.textContent || '';
            this.metadata.language = opf.getElementsByTagName('dc:language')[0]?.textContent || '';

            const metaSeries = opf.querySelector('meta[name="calibre:series"]');
            if (metaSeries) this.metadata.series = metaSeries.getAttribute('content');
        } catch (e) {
            console.error('Error parsing metadata:', e);
        }
    }

    findCover() {
        const parser = new DOMParser();
        if (!(this.opfPath in this.files)) return;
        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');

        const metaCover = opf.querySelector('meta[name="cover"]');
        let coverId = metaCover?.getAttribute('content');

        let coverItem = opf.querySelector('item[properties~="cover-image"]');
        if (!coverItem && coverId) {
            coverItem = opf.getElementById(coverId);
        }

        if (coverItem) {
            this.coverPath = coverItem.getAttribute('href');
            const fullPath = resolveEpubPath(this.opfPath, this.coverPath);

            if (fullPath in this.binary_files) {
                const blob = new Blob([this.binary_files[fullPath]], { type: coverItem.getAttribute('media-type') || 'image/jpeg' });
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
        const metadata = opf.getElementsByTagName('metadata')[0];
        if (!metadata) throw new Error('Cannot update metadata: package metadata element is missing');

        const setTag = (tagName, value) => {
            let tag = opf.getElementsByTagName(tagName)[0];
            if (!tag) {
                tag = opf.createElementNS('http://purl.org/dc/elements/1.1/', tagName);
                metadata.appendChild(tag);
            }
            tag.textContent = value;
        };

        if (Object.hasOwn(newMeta, 'title')) setTag('dc:title', newMeta.title);
        if (Object.hasOwn(newMeta, 'author')) setTag('dc:creator', newMeta.author);
        if (Object.hasOwn(newMeta, 'language')) setTag('dc:language', newMeta.language);
        if (Object.hasOwn(newMeta, 'series')) {
            let series = opf.querySelector('meta[name="calibre:series"]');
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

        let sample = '';
        for (const f in this.files) {
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                sample += this.files[f].substring(0, 500);
                if (sample.length > 2000) break;
            }
        }

        let detected = 'en';
        if (sample.match(/\b(e|da|com|uma|pelo)\b/i)) detected = 'pt';
        else if (sample.match(/\b(el|la|los|las|por|con)\b/i)) detected = 'es';
        else if (sample.match(/\b(der|die|das|und|mit)\b/i)) detected = 'de';
        else if (sample.match(/\b(le|la|les|et|une)\b/i)) detected = 'fr';

        if (detected !== current) {
            this.metadata.language = detected;
            this.updateMetadata(this.metadata);
            this.addOptimization('opt_lang_applied', 'applied', detected);
        }
    }

    fixEncoding() {
        const decl = '<?xml version="1.0" encoding="utf-8"?>';
        let count = 0;
        for (const f in this.files) {
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                if (!this.files[f].includes('encoding="utf-8"') && !this.files[f].includes('encoding="UTF-8"')) {
                    this.files[f] = decl + '\n' + this.files[f];
                    count++;
                }
            }
        }
        if (count) this.addOptimization('opt_encoding_applied', 'applied', count);
        else this.addOptimization('opt_encoding_verified', 'verified');
    }

    fixBodyIdLink() {
        const parser = new DOMParser();
        const bodyIDList = [];

        for (const f in this.files) {
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                const dom = parser.parseFromString(this.files[f], 'text/html');
                const body = dom.getElementsByTagName('body')[0];
                if (body?.id) {
                    bodyIDList.push(`${normalizeEpubPath(f)}#${body.id}`);
                }
            }
        }

        let count = 0;
        for (const f in this.files) {
            if (!f.endsWith('.html') && !f.endsWith('.xhtml')) continue;
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
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
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
        const opf = parser.parseFromString(this.files[this.opfPath], 'text/xml');

        const items = Array.from(opf.getElementsByTagName('item'));
        const hasTOC = items.some(item =>
            item.getAttribute('properties')?.split(/\s+/).includes('nav') ||
            item.getAttribute('media-type') === 'application/x-dtbncx+xml'
        );

        if (hasTOC) {
            this.addOptimization('opt_toc_verified', 'verified');
            return;
        }

        const headings = [];
        for (const f in this.files) {
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                const hTags = doc.querySelectorAll('h1, h2, h3');
                hTags.forEach(h => {
                    if (h.textContent.trim()) {
                        if (!h.id) h.id = 'toc-' + Math.random().toString(36).substr(2, 9);
                        headings.push({ title: h.textContent.trim(), path: f, id: h.id });
                    }
                });
                if (hTags.length > 0) this.files[f] = new XMLSerializer().serializeToString(doc);
            }
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
            let manifest = opf.getElementsByTagName('manifest')[0];
            if (!manifest) {
                // Create manifest if it doesn't exist
                const packageEl = opf.getElementsByTagName('package')[0];
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
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                doc.querySelectorAll('[id]').forEach(el => allIds.add(`${normalizeEpubPath(f)}#${el.id}`));
                allIds.add(normalizeEpubPath(f));
            }
        }

        let fixedCount = 0;
        let unresolvedCount = 0;
        for (const f in this.files) {
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
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
        for (const f in this.files) {
            if (f.endsWith('.css')) {
                const original = this.files[f];
                this.files[f] = this.files[f]
                    .replace(/position:\s*fixed/gi, 'position: absolute')
                    .replace(/overflow:\s*hidden/gi, 'overflow: visible');
                if (this.files[f] !== original) count++;
            }
        }
        if (count) this.addOptimization('opt_css_applied', 'applied', count);
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
            if (f.endsWith('.html') || f.endsWith('.xhtml')) {
                const doc = parser.parseFromString(this.files[f], 'text/html');
                const imgs = doc.querySelectorAll('img:not([alt])');
                imgs.forEach(img => {
                    img.setAttribute('alt', 'Image');
                    count++;
                });
                if (imgs.length) this.files[f] = new XMLSerializer().serializeToString(doc);
            }
        }
        if (count) this.addOptimization('opt_a11y_applied', 'applied', count);
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
        const manifest = new Map();
        for (const item of opf.getElementsByTagName('item')) {
            manifest.set(item.getAttribute('id'), resolveEpubPath(this.opfPath, item.getAttribute('href') || ''));
        }
        for (const itemref of opf.getElementsByTagName('itemref')) {
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
        const mediaType = type === 'image/png' ? 'image/png' : type === 'image/jpeg' ? 'image/jpeg' : '';
        if (!mediaType) throw new Error('Cover image must be a JPEG or PNG');
        if (!this.opfPath || !(this.opfPath in this.files)) throw new Error('Cannot update cover: EPUB package document is missing');

        const opf = new DOMParser().parseFromString(this.files[this.opfPath], 'text/xml');
        const manifest = opf.getElementsByTagName('manifest')[0];
        if (!manifest) throw new Error('Cannot update cover: package manifest is missing');
        const metadata = opf.getElementsByTagName('metadata')[0];
        if (!metadata) throw new Error('Cannot update cover: package metadata element is missing');

        let coverItem = opf.querySelector('item[properties~="cover-image"]');
        if (!coverItem) {
            const coverMeta = opf.querySelector('meta[name="cover"]');
            const coverId = coverMeta?.getAttribute('content');
            if (coverId) coverItem = Array.from(opf.getElementsByTagName('item')).find(item => item.getAttribute('id') === coverId);
        }

        const extension = mediaType === 'image/png' ? '.png' : '.jpg';
        let itemId;
        let coverFile;
        if (coverItem) {
            itemId = coverItem.getAttribute('id');
            if (!itemId) {
                itemId = 'cover-image';
                let suffix = 1;
                while (Array.from(opf.getElementsByTagName('item')).some(item => item.getAttribute('id') === itemId)) {
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
            while (Array.from(opf.getElementsByTagName('item')).some(item => item.getAttribute('id') === itemId)) {
                itemId = `cover-image-${idSuffix++}`;
            }
            coverItem = opf.createElementNS(manifest.namespaceURI, 'item');
            coverItem.setAttribute('id', itemId);
            coverItem.setAttribute('properties', 'cover-image');
            coverItem.setAttribute('href', relativeEpubPath(this.opfPath, coverFile));
            coverItem.setAttribute('media-type', mediaType);
            manifest.appendChild(coverItem);
        }

        let coverMeta = opf.querySelector('meta[name="cover"]');
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
