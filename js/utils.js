export function basename(path) {
    return path.split('/').pop();
}

export function decodeEpubText(bytes) {
    let encoding = 'utf-8';
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
    } else {
        if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) {
            encoding = 'utf-16le';
        } else if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) {
            encoding = 'utf-16be';
        }
        const prefix = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 512)));
        if (encoding === 'utf-8') {
            const declared = prefix.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]
                || prefix.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([^"'\s/>;]+)/i)?.[1]
                || prefix.match(/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*?charset\s*=\s*([^"';\s]+)/i)?.[1]
                || prefix.match(/^@charset\s+["']([^"']+)["']/i)?.[1];
            if (declared) encoding = declared;
        }
    }

    try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch (error) {
        throw new Error(`Unable to decode EPUB text using ${encoding}: ${error.message}`, { cause: error });
    }
}

export function normalizeTextEncoding(text, path) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (extension !== '.css' &&
        !['.html', '.htm', '.xhtml', '.xml', '.opf', '.ncx', '.svg'].includes(extension)) {
        return text;
    }

    let content = text.replace(/^\uFEFF/, '').replace(/<\?xml\b[^?]*\?>/gi, '');
    content = content.replace(/(<meta\b[^>]*\bcharset\s*=\s*["']?)[^"'\s/>]+/gi, '$1utf-8');
    content = content.replace(/(<meta\b[^>]*\bcontent\s*=\s*["'][^"']*?charset\s*=\s*)[^"']+/gi, '$1utf-8');
    if (extension === '.css') {
        return content.replace(/@charset\s+["'][^"']+["']\s*;/i, '@charset "UTF-8";');
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${content.trimStart()}`;
}

export function normalizeEpubPath(path) {
    const parts = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (parts.length) parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join('/');
}

export function resolveEpubPath(baseFile, href) {
    const path = href.split(/[?#]/, 1)[0];
    let decodedPath = path;
    try {
        decodedPath = decodeURIComponent(path);
    } catch {
        // Preserve malformed escapes as literal archive path characters.
    }
    const base = decodedPath.startsWith('/') ? '' : baseFile.includes('/')
        ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1)
        : '';
    return normalizeEpubPath(base + decodedPath);
}

export function relativeEpubPath(fromFile, toFile) {
    const from = normalizeEpubPath(fromFile).split('/');
    from.pop();
    const to = normalizeEpubPath(toFile).split('/');
    while (from.length && to.length && from[0] === to[0]) {
        from.shift();
        to.shift();
    }
    return [...from.map(() => '..'), ...to].join('/') || basename(toFile);
}

export function encodeEpubPath(path) {
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function simplifyLanguage(lang) {
    return (lang || '').split('-').shift().toLowerCase();
}

export function sniffImageMimeType(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return 'image/png';
    }
    return '';
}

export function sanitizeHtml(html) {
    // Basic sanitization or regex cleanup
    return html.trim();
}

export async function perfomCompression(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            if (width > 2000 || height > 2000) {
                const ratio = Math.min(2000 / width, 2000 / height);
                width *= ratio;
                height *= ratio;
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Unable to create image canvas'));
                return;
            }
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((result) => {
                URL.revokeObjectURL(objectUrl);
                if (!result) {
                    reject(new Error('Unable to encode compressed image'));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(new Uint8Array(reader.result));
                reader.onerror = () => reject(reader.error || new Error('Unable to read compressed image'));
                reader.readAsArrayBuffer(result);
            }, blob.type === 'image/png' ? 'image/png' : 'image/jpeg', blob.type === 'image/png' ? undefined : 0.8);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Unable to load image for compression'));
        };
        img.src = objectUrl;
    });
}
