import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const html = readFileSync('index.html', 'utf8');
assert.match(html, /^<!doctype html>/i, 'HTML5 doctype required');
assert.match(html, /<html[^>]*lang="ar"[^>]*dir="rtl"/i, 'Arabic RTL document required');
assert.match(html, /id="app"/, 'Application root missing');

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) && body.trim())
  .map(([, , body]) => body);
assert.ok(scripts.length >= 1, 'Inline application script missing');

const dir = mkdtempSync(join(tmpdir(), 'techstar-check-'));
try {
  for (let i = 0; i < scripts.length; i++) {
    const file = join(dir, 'script-' + i + '.js');
    writeFileSync(file, scripts[i]);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, 'JavaScript syntax error in inline script ' + i + '\n' + check.stderr);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const bundleSource = html.match(/const bundles=\[([\s\S]*?)\];/);
assert.ok(bundleSource, 'Package catalogue missing');
const planIds = [...bundleSource[1].matchAll(/\bid:'([^']+)'/g)].map(m => m[1]);
assert.deepEqual(planIds, ['basic','bronze','silver','gold','platinum','diamond'],
  'The six plan IDs and their order must be preserved');

const homeStart = html.indexOf('function home(){');
const homeEnd = html.indexOf('function solutionsPage(){');
assert.ok(homeStart >= 0 && homeEnd > homeStart, 'Homepage component missing');
const home = html.slice(homeStart, homeEnd);
assert.ok(home.includes("$"+"{bundles.map(pkgCard).join('')}"),
  'Homepage must render all six plans');
assert.ok(home.includes('id="home-package-search"'),
  'Homepage package search missing');
assert.ok(home.includes('id="home-packages-grid"'),
  'Homepage package grid missing');
assert.ok(home.includes('id="home-packages-section"'), 'Homepage package section anchor missing');
assert.ok(home.includes('id="browse-home-packages"'), 'Hero browse-packages button missing');
assert.ok(html.includes("scrollIntoView({behavior:'smooth',block:'start'})"),
  'Hero button must scroll to the package section');
assert.ok(html.includes('function initHomePackageSearch()'),
  'Package search behavior missing');
assert.ok(html.includes('function normalizeSearch(text)'), 'Arabic search normalization missing');
assert.ok(html.includes('function packageSearchIndex(p)'), 'Package search index missing');
assert.ok(html.includes("['المتجر الإلكتروني','متجر إلكتروني','ecommerce','online store']"),
  'Store synonyms should be searchable without renaming e-commerce applications');
assert.ok(html.includes('id="compare-differences-only"'), 'Package comparison filter missing');
assert.ok(html.includes('function initPackageComparison()'), 'Comparison filter behavior missing');
assert.ok(html.includes('data-shared='), 'Shared application rows must be identified');
assert.ok(html.includes('initPackageComparison();'), 'Comparison filter must initialize when route changes');
const jsSource = scripts.join('\n');
const normalizeMatch = jsSource.match(/function normalizeSearch\(text\)\{[\s\S]*?\n\}/);
assert.ok(normalizeMatch, 'Arabic normalizer function missing');
const normalizeSearch = new Function(normalizeMatch[0] + '\nreturn normalizeSearch;')();
assert.equal(normalizeSearch('المُتْجر الإلِكتروني'),normalizeSearch('المتجر الالكتروني'));
assert.equal(normalizeSearch('الأساسية'),normalizeSearch('الاساسيه'));
assert.equal(normalizeSearch('الإدارة'),normalizeSearch('الاداره'));
assert.ok(html.includes('initHomePackageSearch();initPackageComparison();initSolutions();'),
  'Package search must initialize after rendering');
assert.ok(html.includes('.package-card[hidden]'),
  'Filtered cards must be visually hidden');
assert.ok(html.includes('المتجر الإلكتروني'),
  'Keep the established e-commerce terminology');
assert.ok(html.includes('لإدارة نشاطك وتوسّعك.'),
  'Business wording should remain as requested');
assert.ok(html.includes("--techstar-font:'TechStar DIN Next Arabic'"), 'DIN Next Arabic CSS variable missing');
assert.ok(html.includes('font-family:var(--techstar-font)'), 'DIN Next Arabic not applied to document');
assert.ok(html.includes('href="./assets/din-next-arabic.css"'), 'DIN Next Arabic stylesheet link missing');
const fontCss = readFileSync('assets/din-next-arabic.css','utf8');
assert.ok(fontCss.includes("@font-face"), 'Local DIN Next Arabic face not declared');
assert.ok(fontCss.includes("local('DIN Next Arabic')"), 'Local DIN Next Arabic source missing');

assert.ok(!html.includes('100,000 ر.س'), 'Do not publish fictional sales totals');
assert.ok(!html.includes('نسبة هدر</small><b>1.8%'), 'Do not publish fictional shrinkage rates');
assert.ok(html.includes('واجهة توضيحية وليست بيانات تشغيل حقيقية'),
  'Illustrative dashboard must be clearly labeled');
assert.ok(html.includes('function loadQuoteDraft()'), 'Quote draft expiration logic missing');
assert.ok(html.includes('function saveQuoteDraft(form)'), 'Expiring draft save helper missing');
assert.ok(html.includes('حفظ مسودة لمدة 7 أيام'), 'Draft retention notice missing');
const draftStart = jsSource.indexOf('const DRAFT_MAX_AGE=');
const draftEnd = jsSource.indexOf('function apiBase(){',draftStart);
assert.ok(draftStart >= 0 && draftEnd > draftStart, 'Expected draft helpers in application source');
const draftCode = jsSource.slice(draftStart,draftEnd);
const map = new Map();
const store = {
  getItem: key => map.has(key) ? map.get(key) : null,
  setItem: (key,value) => map.set(key,value),
  removeItem: key => map.delete(key)
};
const now = 1_800_000_000_000;
const loadDraft = new Function('localStorage','Date',draftCode + '\nreturn loadQuoteDraft;')(store,{now:()=>now});
const key='techstar_quote_draft';
map.set(key,JSON.stringify({version:2,savedAt:now-1000,fields:{business:'فعال'}}));
assert.equal(loadDraft().business,'فعال');
map.set(key,JSON.stringify({version:2,savedAt:now-8*24*60*60*1000,fields:{business:'قديم'}}));
assert.equal(loadDraft(),null,'Expired drafts must be discarded');
assert.ok(!map.has(key),'Expired drafts must be removed');
map.set(key,JSON.stringify({business:'مسودة سابقة'}));
assert.equal(loadDraft().business,'مسودة سابقة');
assert.equal(JSON.parse(map.get(key)).version,2,'Legacy drafts should be migrated');
assert.ok(html.includes('id="skip-to-content"'), 'Accessible skip-to-content button missing');
assert.ok(!html.includes('href="#main"'), 'Skip button must not change the hash router');
assert.ok(html.includes('try{raw=decodeURIComponent'), 'Malformed hash protection missing');
assert.ok(html.includes('function privacyPage(){'), 'Privacy information page missing');
assert.ok(html.includes("path==='/privacy'?privacyPage():notFound()"), 'Privacy route missing');
assert.ok(html.includes("link('/privacy','الخصوصية')"), 'Footer privacy navigation missing');
assert.ok(html.includes("link('/privacy','اطّلع على معلومات الخصوصية'"), 'Quote form privacy notice missing');
assert.ok(html.includes('حفظ المسودة اختياري'), 'Privacy page must describe local draft storage');
assert.ok(html.includes('function render({resetScroll=true}={})'), 'Render must support preserving scroll');
assert.ok(html.includes("render({resetScroll:false});"), 'Catalogue refresh must not reset scroll position');
for (const file of ['assets/techstar-icon.svg','assets/din-next-arabic.css','404.html','robots.txt','sitemap.xml','site.webmanifest']) {
  assert.ok(readFileSync(file, 'utf8').trim().length > 0, 'Missing or empty website asset: ' + file);
}
assert.ok(html.includes('href="./assets/techstar-icon.svg"'), 'Website favicon link missing');
assert.ok(html.includes('href="./site.webmanifest"'), 'Website manifest link missing');
assert.ok(html.includes('href="https://sulaimanalsanani.github.io/techstar-erp/"'), 'Canonical URL missing');
assert.match(readFileSync('sitemap.xml','utf8'), /https:\/\/sulaimanalsanani\.github\.io\/techstar-erp\//);
console.log('TechStar checks passed: JavaScript syntax, six plans, home search, SEO and static assets.');