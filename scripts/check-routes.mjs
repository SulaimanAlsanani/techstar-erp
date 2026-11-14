import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) && body.trim())
  .map(([, , body]) => body);

assert.ok(scripts.length >= 2, 'Expected configuration and application scripts');
const sandbox = {
  window: { addEventListener() {}, TECHSTAR_CONFIG: {} },
  document: { addEventListener() {} },
  location: { hash: '#/' },
  URLSearchParams,
  Date,
  console,
  setTimeout() { return 0; },
  clearTimeout() {}
};
const context = vm.createContext(sandbox);
scripts.forEach((source, i) => vm.runInContext(source, context, { filename: 'inline-'+i+'.js' }));
const get = expression => vm.runInContext(expression, context);

const home = get('home()');
assert.ok(home.includes('لإدارة نشاطك وتوسّعك.'), 'Homepage copy changed');
assert.equal((home.match(/data-package-id="/g) || []).length, 6,
  'Homepage must render exactly six package cards');
assert.ok(home.includes('id="home-packages-section"'), 'Package section missing');
assert.ok(home.includes('id="home-package-search"'), 'Package search missing');

const packages = get('packagesPage()');
assert.equal((packages.match(/data-package-id="/g) || []).length, 6,
  'Packages view must render exactly six cards');
assert.ok(packages.includes('id="compare-differences-only"'),
  'Differences-only comparison missing');

const privacy = get('privacyPage()');
assert.ok(privacy.includes('Local Storage') && privacy.includes('7 أيام'),
  'Privacy page must explain draft retention');
assert.ok(privacy.includes('لا يعتبر تجهيز الملخص') ||
          privacy.includes('لا يعتبر تجهيز'),
  'Privacy page must not misrepresent offline submissions');

const footer = get("layout('TEST')");
assert.ok(footer.includes('href="#/privacy"'), 'Privacy footer link missing');
assert.ok(footer.includes('TEST'), 'Layout must include routed content');

sandbox.location.hash = '#/contact?package=diamond';
const quote = get('contact()');
assert.ok(quote.includes('name="package"'), 'Quote form must include package selection');
assert.ok(quote.includes('value="diamond" selected'),
  'Selected package link must pre-select the requested package');
assert.ok(quote.includes('id="quote-form"'), 'Quote form missing');
assert.ok(quote.includes('target="_blank" rel="noopener noreferrer"'),
  'Privacy notice should not erase partially entered quote data');

sandbox.location.hash = '#/%ZZ';
assert.equal(get('route()'), '/', 'Malformed route should fail safely');

const escaping = get('pkgCard({id:"test",name:"<script>alert(1)</script>",tag:"Test",for:"Test",apps:[]})');
assert.ok(!escaping.includes('<script>'), 'Package card must escape unsafe API text');
assert.ok(escaping.includes('&lt;script&gt;'), 'Package card text must be HTML escaped');

console.log('TechStar route tests passed: homepage, six packages, comparison, privacy, form selection and HTML escaping.');
