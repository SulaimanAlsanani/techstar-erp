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


// Exercise the challenge callbacks with a simulated browser and no network.
const turnstileStart=html.indexOf('function turnstileKey(){',apiEnd);
const contactStart=html.indexOf('function initContact(){',turnstileStart);
assert.ok(turnstileStart>=apiEnd && contactStart>turnstileStart);
const js=html.slice(apiStart,contactStart);
const slot={nodeType:1};
let challengeOptions,rendered=0,enabled=0,disabled=[];
const browser={
 TECHSTAR_CONFIG:{apiBaseUrl:'https://secure.example.test',turnstileSiteKey:'public-test-key'},
 turnstile:{
   render(element,options){assert.equal(element,slot);challengeOptions=options;rendered++;return 4}
 }
};
const fakeDoc={contains:element=>element===slot,head:{appendChild(){}}};
const makeChallenge=new Function('window','document','$','URL',
 js+'return {initTurnstile,apiBase,turnstileKey};');
const challenge=makeChallenge(browser,fakeDoc,selector=>selector==='#turnstile-slot'?slot:null,URL);
challenge.initTurnstile(()=>enabled++,message=>disabled.push(message));
assert.equal(rendered,1);
challengeOptions.callback('challenge-response');
assert.equal(enabled,1,'Only a solved challenge enables remote send');
challengeOptions.callback('');
assert.equal(enabled,1,'Empty response must not enable send');
challengeOptions['expired-callback']();
assert.equal(disabled.length,1,'Expired challenges must close remote send');
challengeOptions['error-callback']();
assert.equal(disabled.length,2,'Failed challenges must close remote send');
assert.equal(challengeOptions.sitekey,'public-test-key');
let createdScript;
const unavailableBrowser={TECHSTAR_CONFIG:browser.TECHSTAR_CONFIG};
const docWithoutScript={
 contains:fakeDoc.contains,
 createElement(tag){assert.equal(tag,'script');createdScript={};return createdScript},
 head:{appendChild(script){assert.equal(script,createdScript)}}
};
let failMessage='';
makeChallenge(unavailableBrowser,docWithoutScript,()=>slot,URL)
 .initTurnstile(()=>{throw Error('Unavailable widget must not report ready')},value=>{failMessage=value});
assert.match(createdScript.src,/challenges\.cloudflare\.com\/turnstile/);
createdScript.onerror();
assert.match(failMessage,/تعذر تحميل اختبار الحماية/);

console.log('TechStar quote contract checks passed: fields, Turnstile gate, server receipt, HTTPS URLs.');
