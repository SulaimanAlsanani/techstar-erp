import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.mjs';

const ORIGIN = 'https://sulaimanalsanani.github.io';
const URL_ROOT = 'https://api.example.invalid';
const ID = '123e4567-e89b-42d3-a456-426614174000';

function request(path, method='GET', payload, origin=ORIGIN) {
  const headers = new Headers();
  if(origin) headers.set('origin',origin);
  if(payload!==undefined)headers.set('content-type','application/json');
  return new Request(URL_ROOT+path,{
    method,headers,body:payload===undefined?undefined:JSON.stringify(payload)
  });
}
function payload(overrides={}) {
  return {
    name:'Ahmed',business:'Example Store',email:'example@business.test',
    phone:'0501234567',industry:'سوبر ماركت',package:'gold',
    solution:'pos',branches:2,pos:4,notes:'Test quote request',
    requestId:ID,turnstileToken:'token-accepted',
    ...overrides
  };
}
function fakeD1(){
  const leads=new Map();
  return {
    leads,
    prepare(sql){
      let args;
      return {
        bind(...data){args=data;return this},
        async run(){
          if(!sql.startsWith('INSERT INTO leads'))throw Error('Unexpected insert query');
          const clientId=args[1];
          if(!leads.has(clientId))leads.set(clientId,{reference:args[2],business:args[4]});
          return {success:true};
        },
        async first(){
          if(!sql.startsWith('SELECT reference FROM leads'))throw Error('Unexpected select query');
          return leads.get(args[0])||null;
        }
      };
    }
  };
}
function configured(db=fakeD1()){
  return {DB:db,TURNSTILE_SECRET:'test-secret',ALLOWED_ORIGINS:ORIGIN,
    TURNSTILE_HOSTNAME:'sulaimanalsanani.github.io'};
}

test('health is readable but reports unconfigured readiness',async()=>{
  const response=await worker.fetch(request('/health','GET',undefined,null),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).ready,false);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('rejects malicious origins and permits exact origin only',async()=>{
  const response=await worker.fetch(request('/api/content','GET',undefined,'https://attacker.test'),configured());
  assert.equal(response.status,403);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  const allowed=await worker.fetch(request('/api/content'),configured());
  assert.equal(allowed.status,200);
  assert.deepEqual(await allowed.json(),{items:[]});
  assert.equal(allowed.headers.get('access-control-allow-origin'),ORIGIN);
});

test('CORS preflight allows public JSON API requests only for known origin',async()=>{
  const r=await worker.fetch(request('/api/leads','OPTIONS'),configured());
  assert.equal(r.status,204);
  assert.match(r.headers.get('access-control-allow-methods'),/POST/);
});

test('configured lead endpoint rejects invalid form data',async()=>{
  const db=fakeD1(),env=configured(db);
  const response=await worker.fetch(request('/api/leads','POST',payload({email:'not-an-email'})),env);
  assert.equal(response.status,422);
  assert.equal(db.leads.size,0);
});
test('rejects JSON null and arrays without throwing',async()=>{
  const env=configured(fakeD1());
  for(const data of [null,[],42]){
    const response=await worker.fetch(request('/api/leads','POST',data),env);
    assert.equal(response.status,422);
  }
});

test('does not store requests when service is not configured',async()=>{
  const response=await worker.fetch(request('/api/leads','POST',payload()),{});
  assert.equal(response.status,503);
});
test('rejects honeypot fields before storage',async()=>{
  const db=fakeD1(),env=configured(db);
  const response=await worker.fetch(request('/api/leads','POST',payload({website:'https://spam.invalid'})),env);
  assert.equal(response.status,422);
  assert.equal(db.leads.size,0);
});

test('valid Turnstile challenge stores a lead and retries remain idempotent',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async (_url,options)=>{
    assert.match(String(options.body),/secret=test-secret/);
    return new Response(JSON.stringify({success:true,hostname:'sulaimanalsanani.github.io'}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };
  try{
    const db=fakeD1(),env=configured(db);
    const first=await worker.fetch(request('/api/leads','POST',payload()),env);
    const a=await first.json();
    assert.equal(first.status,201);
    assert.equal(a.received,true);
    assert.match(a.reference,/^TS-/);
    const second=await worker.fetch(request('/api/leads','POST',payload()),env);
    const b=await second.json();
    assert.equal(second.status,201);
    assert.equal(b.reference,a.reference);
    assert.equal(db.leads.size,1);
  }finally{globalThis.fetch=old}
});

test('challenge from incorrect hostname is rejected',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    success:true,hostname:'not-techstar.invalid'
  }),{status:200,headers:{'content-type':'application/json'}});
  try{
    const db=fakeD1();
    const response=await worker.fetch(request('/api/leads','POST',payload()),configured(db));
    assert.equal(response.status,422);
    assert.equal(db.leads.size,0);
  }finally{globalThis.fetch=old}
});

test('database errors never present a false success',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    success:true,hostname:'sulaimanalsanani.github.io'
  }),{status:200,headers:{'content-type':'application/json'}});
  try{
    const broken={prepare(){throw Error('offline DB')}};
    const response=await worker.fetch(request('/api/leads','POST',payload()),configured(broken));
    assert.equal(response.status,503);
    assert.equal((await response.json()).received,undefined);
  }finally{globalThis.fetch=old}
});
