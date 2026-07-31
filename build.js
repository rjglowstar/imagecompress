/*
 * build.js - produces an obfuscated dist/ for deployment.
 *
 * The files in the project root stay readable so they can be edited and
 * debugged. Nothing here is a security boundary: browser code is always
 * readable by whoever runs it, and any obfuscation can be undone with effort.
 * The point is to make casual copying not worth the trouble.
 *
 *   npm run build       balanced - strong renaming, no control flow rewriting
 *                       in the pixel loops
 *   npm run build:max   adds control flow flattening and dead code everywhere,
 *                       including the encoder. Hardest to read, and measurably
 *                       slower on large images.
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const MAX = process.argv.includes('--max');

const BANNER = '/*! Image Compressor - Copyright (c) ' + new Date().getFullYear() +
  ' rjglowstar. All rights reserved. Unauthorised copying or redistribution prohibited. */\n';

/* --------------------------------------------------------------- options */

// renameGlobals MUST stay false: index.html calls the global `Imgmin`, and the
// two files are obfuscated separately, so a renamed global would never match.
const BASE = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: false,
  reservedNames: ['^Imgmin$', '^jic$'],
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  // Deliberately off. debugProtection freezes the tab in a debugger loop and
  // punishes anyone who simply opens devtools; selfDefending breaks the file
  // if anything downstream reformats it.
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false
};

// Control flow flattening rewrites loops into dispatch tables. On the PNG
// quantizer - which touches every pixel of a 37 megapixel image - that is a
// real slowdown, so it is off for the encoder unless --max is passed.
const HOT_PATH = Object.assign({}, BASE, {
  controlFlowFlattening: MAX,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  // transformObjectKeys on the encoder's palette/box objects costs measurable
  // time in inner loops.
  transformObjectKeys: false,
  numbersToExpressions: false
});

// The UI script is event driven and never hot, so it takes the full treatment.
const UI = Object.assign({}, BASE, {
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: MAX ? 1 : 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: MAX ? 0.4 : 0.2
});

/* ----------------------------------------------------------------- utils */

function obfuscate(code, options, label) {
  const before = Buffer.byteLength(code);
  const result = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  const after = Buffer.byteLength(result);
  console.log(
    '  ' + label.padEnd(26) +
    (before / 1024).toFixed(1) + ' KB -> ' + (after / 1024).toFixed(1) + ' KB' +
    '  (x' + (after / before).toFixed(1) + ')'
  );
  return result;
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/* ----------------------------------------------------------------- build */

// Exported so the test suite can obfuscate with the exact settings used here,
// rather than a copy that could drift out of sync.
module.exports = { BASE: BASE, HOT_PATH: HOT_PATH, UI: UI, BANNER: BANNER };
if (require.main !== module) return;

console.log('\nBuilding ' + (MAX ? 'dist (max obfuscation)' : 'dist') + '\n');

rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 1. The standalone library.
const imgmin = fs.readFileSync(path.join(ROOT, 'imgmin.js'), 'utf8');
fs.writeFileSync(
  path.join(DIST, 'imgmin.js'),
  BANNER + obfuscate(imgmin, HOT_PATH, 'imgmin.js')
);

// 2. The inline application script inside index.html.
const inlineScript = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/;
const match = html.match(inlineScript);
if (!match) {
  console.error('ERROR: no inline <script> found in index.html - aborting.');
  process.exit(1);
}
const obfuscatedInline = obfuscate(match[2], UI, 'index.html inline script');
html = html.replace(inlineScript, function () {
  return '<script' + match[1] + '>' + obfuscatedInline + '</script>';
});

// Strip HTML comments, which otherwise explain the very code being hidden.
// The doctype and any conditional comments are left alone.
html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
fs.writeFileSync(path.join(DIST, 'index.html'), html);
console.log('  index.html'.padEnd(28) + 'written');

// 3. Copy every local asset the page actually references.
const referenced = new Set();
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
  referenced.add(ref.split(/[?#]/)[0]);
}

let copied = 0;
for (const asset of referenced) {
  if (asset === 'index.html' || asset === 'imgmin.js') continue;
  const from = path.join(ROOT, asset);
  if (!fs.existsSync(from)) {
    console.log('  WARNING: referenced but missing - ' + asset);
    continue;
  }
  const to = path.join(DIST, asset);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}
console.log('  assets copied'.padEnd(28) + copied);

fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(DIST, 'LICENSE'));

console.log('\nDone. Publish directory: dist/\n');
