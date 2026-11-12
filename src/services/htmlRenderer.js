import fs from 'node:fs';
import path from 'node:path';

let cachedHtml = null;
let lastCacheTime = 0;
let cachedJs = null;
let lastJsCacheTime = 0;

const FRONTEND_JS_MODULES = [
  'js/modules/state.js',
  'js/modules/apiAndJobs.js',
  'js/modules/coursesAndModules.js',
  'js/modules/sourcesAndExtraction.js',
  'js/modules/studyPackAndReader.js',
  'js/modules/quizAndRemedial.js',
  'js/modules/mathAndFormatters.js',
  'js/app.js',
];

/**
 * Dynamically assembles modular frontend JS modules + app.js entry point
 * @param {string} publicDir
 * @param {boolean} [useCache=false]
 * @returns {string}
 */
export function renderModularJs(publicDir, useCache = process.env.NODE_ENV === 'production') {
  if (useCache && cachedJs && Date.now() - lastJsCacheTime < 30_000) {
    return cachedJs;
  }

  const parts = [];
  for (const relPath of FRONTEND_JS_MODULES) {
    const fullPath = path.join(publicDir, relPath);
    if (fs.existsSync(fullPath)) {
      parts.push(`/* === ${relPath} === */\n${fs.readFileSync(fullPath, 'utf8')}`);
    }
  }

  const bundle = parts.join('\n\n');
  if (useCache) {
    cachedJs = bundle;
    lastJsCacheTime = Date.now();
  }
  return bundle;
}

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
