export function basename(path) {
    return path.split('/').pop();
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
