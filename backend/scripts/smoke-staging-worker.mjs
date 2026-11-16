#!/usr/bin/env node
/* Remote STAGING acceptance checks. Sends no real customer information. */
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function normalizeStagingUrl(input) {
  assert.equal(typeof input, 'string', 'A staging Worker URL is required');
  const url = new URL(input);
  assert.equal(url.protocol, 'https:', 'Staging checks require HTTPS');
  assert.match(url.hostname, /^techstar-public-api-staging\.[a-z0-9-]+\.workers\.dev$/i,
    'Target must be dedicated techstar-public-api-staging workers.dev host');
  assert.equal(url.port, '', 'Custom ports are not permitted');
  assert.equal(url.username, '', 'Credentials must not be embedded in URLs');
  assert.equal(url.password, '', 'Credentials must not be embedded in URLs');
  assert.equal(url.pathname, '/', 'Use the Worker base URL without a path');
  assert.equal(url.search, '', 'No query parameters in Worker URL');
  assert.equal(url.hash, '', 'No fragments in Worker URL');
  return url.origin;
}

const ORIGIN='https://sulaimanalsanani.github.io';
const BAD_ORIGIN='https://untrusted.example.invalid';

export async function checkStagingWorker(input, fetcher=globalThis.fetch) {
  const base=normalizeStagingUrl(input);
  const check=async(path,method='GET',headers={},body)=>{
    const r=await fetcher(base+path,{
      method,headers,body,redirect:'manual',signal:AbortSignal.timeout(10000)
    });
    assert.ok(r instanceof Response,'Expected HTTP Response');
    return r;
  };
  const status=(r,expected,name)=>assert.equal(r.status,expected,name+': unexpected HTTP '+r.status);
  const cors=(r,expected,name)=>assert.equal(r.headers.get('access-control-allow-origin'),expected,
    name+': unsafe/missing CORS');
  const json=async(r,name)=>{
    assert.match(r.headers.get('content-type')||'',/^application\/json\b/i,name+': expected JSON');
    return r.json();
  };

  const health=await check('/health','GET',{origin:ORIGIN});
  status(health,200,'Health'); cors(health,ORIGIN,'Health');
  assert.equal(health.headers.get('cache-control'),'no-store');
  const h=await json(health,'Health');
  assert.equal(h.status,'ok');
  assert.equal(h.ready,false,'FAIL CLOSED: staging must never accept real leads');

  const content=await check('/api/content','GET',{origin:ORIGIN});
  status(content,200,'Public content'); cors(content,ORIGIN,'Public content');
  assert.deepEqual(await json(content,'Public content'),{items:[]});

  const blocked=await check('/api/content','GET',{origin:BAD_ORIGIN});
  status(blocked,403,'Untrusted origin'); cors(blocked,null,'Untrusted origin');
  assert.equal((await json(blocked,'Untrusted origin')).error,'origin_not_allowed');

  const options=await check('/api/leads','OPTIONS',{
    origin:ORIGIN,'access-control-request-method':'POST',
    'access-control-request-headers':'content-type'
  });
  status(options,204,'Preflight'); cors(options,ORIGIN,'Preflight');

  // Deliberately empty JSON, never PII. A 422 would indicate that the release
  // gate is open; require a 503 before request validation.
  const lead=await check('/api/leads','POST',{
    origin:ORIGIN,'content-type':'application/json'
  },'{}');
  status(lead,503,'Lead gate'); cors(lead,ORIGIN,'Lead gate');
  assert.equal((await json(lead,'Lead gate')).error,'lead_ingestion_disabled');

  for(const path of ['/admin/','/admin/api/me']){
    const r=await check(path);
    if([401,403,503].includes(r.status))continue;
    const location=r.headers.get('location');
    const redirect=location?new URL(location,base):null;
    const access=redirect&&redirect.protocol==='https:'&&
      (redirect.hostname.endsWith('.cloudflareaccess.com')||
       (redirect.origin===base&&redirect.pathname.startsWith('/cdn-cgi/access/')));
    assert.ok([302,303,307,308].includes(r.status)&&access,
      path+': admin must deny unauthenticated requests or redirect to Cloudflare Access');
  }
  return {base,checks:7,leadIngestion:'disabled',admin:'protected'};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const target=process.argv[2]||process.env.TECHSTAR_STAGING_WORKER_URL;
  try {
    const result=await checkStagingWorker(target);
    console.log('Remote staging checks PASSED: '+result.checks+
      ' safeguards, lead ingestion '+result.leadIngestion+', admin '+result.admin+'.');
  } catch(error){
    console.error('Remote staging checks FAILED:',error.message);
    process.exitCode=1;
  }
}
