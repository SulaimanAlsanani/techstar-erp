import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeStagingUrl,checkStagingWorker} from '../scripts/smoke-staging-worker.mjs';

const TARGET='https://techstar-public-api-staging.example-account.workers.dev';
const ORIGIN='https://sulaimanalsanani.github.io';
const json=(data,code=200,extra={})=>new Response(JSON.stringify(data),{
  status:code,headers:{'content-type':'application/json',...extra}
});
function fake(overrides={}){
  const calls=[];
  const fetcher=async(url,opts)=>{
    const path=new URL(url).pathname;
    calls.push({path,...opts});
    if(overrides[path])return overrides[path](opts);
    const cors={'access-control-allow-origin':ORIGIN};
    if(path==='/health')return json({status:'ok',ready:false},200,
      {...cors,'cache-control':'no-store'});
    if(path==='/api/content')return opts.headers.origin===ORIGIN
      ?json({items:[]},200,cors):json({error:'origin_not_allowed'},403);
    if(path==='/api/leads'&&opts.method==='OPTIONS')
      return new Response(null,{status:204,headers:cors});
    if(path==='/api/leads'&&opts.method==='POST')
      return json({error:'lead_ingestion_disabled'},503,cors);
    if(path.startsWith('/admin/'))return json({error:'admin_not_configured'},503);
    throw Error('Unexpected endpoint '+path);
  };
  return {fetcher,calls};
}
test('staging URL rejects production, plain HTTP, paths, query and credentials',()=>{
  assert.equal(normalizeStagingUrl(TARGET+'/'),TARGET);
  for(const bad of [
    'http://techstar-public-api-staging.example-account.workers.dev',
    'https://techstar-public-api.example-account.workers.dev',
    'https://sulaimanalsanani.github.io',
    TARGET+'/admin/',TARGET+'?token=x',
    'https://user:pass@techstar-public-api-staging.example-account.workers.dev'
  ])assert.throws(()=>normalizeStagingUrl(bad),bad);
});
test('remote staging acceptance checks seven safeguards without PII',async()=>{
  const {fetcher,calls}=fake();
  const result=await checkStagingWorker(TARGET,fetcher);
  assert.equal(result.checks,7);
  assert.equal(calls.length,7);
  assert.equal(calls.find(c=>c.path==='/api/leads'&&c.method==='POST')?.body,'{}');
  assert.ok(calls.every(c=>c.redirect==='manual'));
});
test('detects lead ingestion enabled in staging',async()=>{
  const {fetcher}=fake({'/health':()=>json({status:'ok',ready:true},200,{
    'access-control-allow-origin':ORIGIN,'cache-control':'no-store'
  })});
  await assert.rejects(checkStagingWorker(TARGET,fetcher),/never accept real leads/);
});
test('detects release gate returning 422 instead of 503',async()=>{
  const {fetcher}=fake({'/api/leads':opts=>opts.method==='OPTIONS'
    ?new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGIN}})
    :json({error:'invalid_fields'},422,{'access-control-allow-origin':ORIGIN})});
  await assert.rejects(checkStagingWorker(TARGET,fetcher),/unexpected HTTP 422/);
});
test('detects wildcard CORS and public admin',async()=>{
  const {fetcher}=fake({'/api/content':()=>json({items:[]},200,{
    'access-control-allow-origin':'*'
  })});
  await assert.rejects(checkStagingWorker(TARGET,fetcher),/unsafe\/missing CORS/);
  const {fetcher:publicAdmin}=fake({'/admin/':()=>new Response('private',{status:200})});
  await assert.rejects(checkStagingWorker(TARGET,publicAdmin),/admin must deny/);
});
test('accepts Cloudflare Access redirects but rejects arbitrary redirects',async()=>{
  const access=()=>new Response(null,{status:302,headers:{
    location:'https://company.cloudflareaccess.com/cdn-cgi/access/login/app'
  }});
  const {fetcher}=fake({'/admin/':access,'/admin/api/me':access});
  assert.equal((await checkStagingWorker(TARGET,fetcher)).admin,'protected');
  const {fetcher:bad}=fake({'/admin/':()=>new Response(null,{status:302,
    headers:{location:'https://phishing.example.invalid/login'}})});
  await assert.rejects(checkStagingWorker(TARGET,bad),/admin must deny/);
});
