import { resolveEpubPath } from './utils.js';

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

export function makePreviewDocument(epub, chapterPath) {
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
          } else element.removeAttribute(attribute.name);
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
        else element.removeAttribute(attribute.name);
      }
    }
  });

  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src data: blob:; img-src data: blob:; style-src data: 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";
  document.head.prepend(csp);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
