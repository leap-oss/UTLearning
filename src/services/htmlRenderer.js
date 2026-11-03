import fs from 'node:fs';
import path from 'node:path';

let cachedHtml = null;
let lastCacheTime = 0;

/**
 * Dynamically assembles modular partials into index.html
 * @param {string} publicDir
 * @param {boolean} [useCache=false]
 * @returns {string}
 */
export function renderModularHtml(publicDir, useCache = process.env.NODE_ENV === 'production') {
  if (useCache && cachedHtml && Date.now() - lastCacheTime < 30_000) {
    return cachedHtml;
  }

  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error('index.html not found');
  }

  let content = fs.readFileSync(indexPath, 'utf8');
  const includeRegex = /<!--\s*include:\s*([^\s]+)\s*-->/g;

  content = content.replace(includeRegex, (_match, relPath) => {
    const fullPath = path.join(publicDir, relPath);
    if (!fs.existsSync(fullPath)) {
      return `<!-- missing partial: ${relPath} -->`;
    }
    let partial = fs.readFileSync(fullPath, 'utf8');
    // Support nested includes
    partial = partial.replace(includeRegex, (_nestedMatch, nestedRelPath) => {
      const nestedFullPath = path.join(publicDir, nestedRelPath);
      return fs.existsSync(nestedFullPath) ? fs.readFileSync(nestedFullPath, 'utf8') : '';
    });
    return partial;
  });

  if (useCache) {
    cachedHtml = content;
    lastCacheTime = Date.now();
  }

  return content;
}
