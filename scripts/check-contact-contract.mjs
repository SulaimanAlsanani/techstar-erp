import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync('index.html','utf8');
const core=readFileSync('backend/src/index.mjs','utf8');
const begin=html.indexOf('function contact(){');
const end=html.indexOf('function getParams(){',begin+1);
const section=html.slice(begin,end>begin?end:html.indexOf('function summary(',begin));
assert.ok(section.includes('id="quote-form"'),'Quotation form must render');

for(const field of ['name','business','email','phone','industry','package',
 'branches','pos','solution','notes','website']){
  assert.ok(section.includes('name="'+field+'"'),'Quote field missing: '+field);
}
assert.ok(section.includes('name="website" tabindex="-1"'),
 'Honeypot must remain outside normal tab order');
assert.ok(section.includes('id="quote-service-status"'),
 'Quote form must disclose whether online submission is enabled');
assert.ok(section.includes('href="#/privacy"'),'Privacy information must remain reachable');
assert.ok(html.includes('const remoteConfigured=Boolean(apiBase()&&turnstileKey())'),
 'Remote quote submissions must require both API URL and Turnstile key');
assert.ok(html.includes('if(canSend){'),
 'Remote requests must wait for successful challenge callback');
assert.ok(html.includes("callback(token){if(token&&document.contains(slot))onReady()}"),
 'Challenge must positively confirm a nonempty response');
assert.ok(html.includes('resetChallenge();'),
 'Turnstile must reset after use or rejection');
assert.ok(html.includes("sendBtn.disabled=true;"),
 'Challenge loading must not offer a premature remote submission');
assert.ok(html.includes('if(!response.ok||!result.received||!result.reference)'),
 'Success must depend on a real verified server receipt');
assert.ok(core.includes('if(env.LEAD_INGESTION_ENABLED!=="true")'),
 'Backend must fail closed until public ingestion is explicitly approved');
assert.ok(core.includes('return result.success===true && result.hostname===hostname'),
 'Turnstile backend must verify the challenge hostname');
assert.ok(core.includes('if(!isHuman)return respond({error:"challenge_failed"}'),
 'Server must reject invalid challenges');

// Validate API URL parsing behavior as a pure function, without a browser.
const apiStart=html.indexOf('function apiBase(){');
const apiEnd=html.indexOf('function turnstileKey(){',apiStart);
assert.ok(apiStart>=0&&apiEnd>apiStart,'API URL parser not found');
const parser=html.slice(apiStart,apiEnd);
const compute=address=>new Function('window','URL',parser+'return apiBase();')({
 TECHSTAR_CONFIG:{apiBaseUrl:address}
},URL);
assert.equal(compute(''),'');
assert.equal(compute('https://api.example.test/'),'https://api.example.test');
assert.equal(compute('https://api.example.test/base/'),'https://api.example.test/base');
assert.equal(compute('http://api.example.test'),'','Unencrypted public APIs must be rejected');
assert.equal(compute('javascript:alert(1)'),'','Unsafe scheme must be rejected');
assert.equal(compute('https://user:pass@api.example.test'),'', 'Credential-bearing URLs must be rejected');
assert.equal(compute('https://api.example.test/path?token=secret'),'', 'Query-bearing API base URLs must be rejected');

console.log('TechStar quote contract checks passed: fields, Turnstile gate, server receipt, HTTPS URLs.');
