import assert from "node:assert/strict";
import {before,test} from "node:test";
import worker from "../src/index.mjs";
import {authenticateAdmin} from "../src/admin-auth.mjs";
import {adminApp} from "../src/admin-app.mjs";
import {adminPage} from "../src/admin-page.mjs";
import {readFileSync} from "node:fs";

const ISSUER="https://techstar-test.cloudflareaccess.com";
const AUD="test-access-app-audience";
const ROOT="https://api.example.invalid";
const LEAD_ID="8a1ff77e-6ebf-4b11-9d7c-7a47bef5747a";
const ADMIN="admin@company.test",VIEWER="viewer@company.test",OTHER="other@company.test";
let keys,privateKey;

function base64url(value){
  return Buffer.from(value).toString("base64url");
}
async function sign(email,alter={}){
  const now=Math.floor(Date.now()/1000);
  const header={alg:"RS256",kid:"crm-2026",typ:"JWT"};
  const claims={iss:ISSUER,aud:[AUD],email,iat:now,nbf:now-10,exp:now+1800,...alter};
  const unsigned=base64url(JSON.stringify(header))+"."+base64url(JSON.stringify(claims));
  const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",privateKey,new TextEncoder().encode(unsigned));
  return unsigned+"."+base64url(Buffer.from(sig));
}
function env(db){
  return {DB:db,ACCESS_ISSUER:ISSUER,ACCESS_AUD:AUD,
    CRM_ADMIN_EMAILS:ADMIN,CRM_VIEWER_EMAILS:VIEWER};
}
function request(path,method="GET",token,body,origin){
  const headers=new Headers();
  if(token)headers.set("cf-access-jwt-assertion",token);
  if(body!==undefined)headers.set("content-type","application/json");
  if(origin)headers.set("origin",origin);
  return new Request(ROOT+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body)});
}
const seed={
  id:LEAD_ID,reference:"TS-EXAMPLE",name:"User",business:"Test",
  email:"client@business.test",phone:"0500000000",industry:"store",package_id:"gold",
  solution_id:"pos",branches:2,pos_count:3,notes:"Test note",status:"new",
  created_at:"2026-11-14 00:00:00",updated_at:""
};
function fakeDB(){
 const lead={...seed};
 const audit=[];
 let lastUpdate=0;
 return {
  lead,audit,
  prepare(sql){
   let args=[];
   return {
    bind(...x){args=x;return this},
    async first(){
      if(sql.includes("SELECT COUNT(*)"))return {total:1};
      if(sql.includes("SELECT id FROM leads"))return args[0]===lead.id?{id:lead.id}:null;
      if(sql.includes("SELECT * FROM leads"))return args[0]===lead.id?lead:null;
      if(sql.includes("SELECT status FROM leads"))return args[0]===lead.id?{status:lead.status}:null;
      throw Error("Unexpected first() query: "+sql);
    },
    async all(){
      if(sql.includes("GROUP BY status"))return {results:[{status:lead.status,total:1}]};
      if(sql.includes("FROM lead_audit"))return {results:audit};
      if(sql.includes("FROM leads")&&sql.includes("ORDER BY"))
        return {results:[{...lead}]};
      throw Error("Unexpected all() query: "+sql);
    },
    async run(){
      throw Error("Unexpected run() query: "+sql);
    },
    sql,args
   };
  },
  async batch(statements){
   assert.equal(statements.length,2);
   const [update,insert]=statements;
   if(lead.id===update.args[1]&&lead.status===update.args[2]){
     lead.status=update.args[0];
     lead.updated_at="2026-11-14 12:00:00";
     lastUpdate=1;
   }else lastUpdate=0;
   if(lastUpdate){
     audit.push({
       id:insert.args[0],actor_email:insert.args[1],action:"status_changed",
       previous_status:insert.args[2],new_status:insert.args[3],
       created_at:"2026-11-14 12:00:00"
     });
   }
   return [{meta:{changes:lastUpdate}},{meta:{changes:lastUpdate}}];
  }
 };
}

before(async()=>{
 keys=await crypto.subtle.generateKey(
   {name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},
   true,["sign","verify"]);
 privateKey=keys.privateKey;
 const jwk=await crypto.subtle.exportKey("jwk",keys.publicKey);
 const realFetch=globalThis.fetch;
 globalThis.fetch=async url=>{
   if(String(url)!==ISSUER+"/cdn-cgi/access/certs")return realFetch(url);
   return new Response(JSON.stringify({keys:[{...jwk,kid:"crm-2026",alg:"RS256",use:"sig"}]}),{
     status:200,headers:{"content-type":"application/json"}
   });
 };
});

test("admin interface source and browser script are separated and valid",()=>{
 assert.match(adminPage,/<html lang="ar" dir="rtl">/);
 assert.match(adminPage,/id="leads-body"/);
 assert.match(adminPage,/id="audit"/);
 assert.match(adminPage,/src="\/admin\/assets\/app.js"/);
 assert.equal(adminApp,readFileSync(new URL("../src/admin-app.js",import.meta.url),"utf8"));
 assert.doesNotThrow(()=>new Function(adminApp));
 assert.ok(!adminApp.includes("localStorage"));
});

test("unconfigured administration fails closed",async()=>{
 const response=await worker.fetch(request("/admin/"),{});
 assert.equal(response.status,503);
 const data=await response.json();
 assert.equal(data.error,"admin_not_configured");
});

test("signed Access JWT is mandatory, not origin or email header alone",async()=>{
 const db=fakeDB();
 const without=await worker.fetch(request("/admin/api/leads","GET",null,undefined),env(db));
 assert.equal(without.status,401);
 const forged=request("/admin/api/leads");
 forged.headers.set("cf-access-authenticated-user-email",ADMIN);
 const response=await worker.fetch(forged,env(db));
 assert.equal(response.status,401);
});

test("valid viewer JWT allows read-only CRM access",async()=>{
 const token=await sign(VIEWER);
 const db=fakeDB();
 const page=await worker.fetch(request("/admin/","GET",token),env(db));
 assert.equal(page.status,200);
 assert.match(page.headers.get("content-security-policy"),/frame-ancestors 'none'/);
 assert.equal(page.headers.get("access-control-allow-origin"),null);
 const script=await worker.fetch(request("/admin/assets/app.js","GET",token),env(db));
 assert.equal(script.status,200);
 assert.match(script.headers.get("content-type"),/javascript/);
 const who=await worker.fetch(request("/admin/api/me","GET",token),env(db));
 assert.deepEqual(await who.json(),{email:VIEWER,role:"viewer"});
 const list=await worker.fetch(request("/admin/api/leads","GET",token),env(db));
 const result=await list.json();
 assert.equal(result.items?.length,1);
 assert.equal(result.items?.[0]?.email,undefined,"List response minimizes contact data");
 const detail=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"GET",token),env(db));
 const data=await detail.json();
 assert.equal(data.lead.email,seed.email);
});

test("viewer cannot change status or write an audit event",async()=>{
 const token=await sign(VIEWER);
 const db=fakeDB();
 const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,{
   previousStatus:"new",status:"in_progress"
 }),env(db));
 assert.equal(response.status,403);
 assert.equal(db.lead.status,"new");
 assert.equal(db.audit.length,0);
});

test("admin can update a lead once with an audit trail",async()=>{
 const token=await sign(ADMIN);
 const db=fakeDB();
 const body={previousStatus:"new",status:"in_progress"};
 const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,body),env(db));
 assert.equal(response.status,200);
 assert.equal((await response.json()).updated,true);
 assert.equal(db.lead.status,"in_progress");
 assert.equal(db.audit.length,1);
 assert.equal(db.audit[0].actor_email,ADMIN);
 const stale=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,body),env(db));
 assert.equal(stale.status,409);
 assert.equal(db.audit.length,1);
 const audit=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/audit","GET",token),env(db));
 const data=await audit.json();
 assert.equal(data.events[0].actor,ADMIN);
});

test("admin must use a permitted status transition",async()=>{
 const token=await sign(ADMIN),db=fakeDB();
 const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,{
   previousStatus:"new",status:"won"
 }),env(db));
 assert.equal(response.status,422);
 assert.equal(db.audit.length,0);
});

test("state-changing requests with hostile Origin are rejected",async()=>{
 const token=await sign(ADMIN),db=fakeDB();
 const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,
   {previousStatus:"new",status:"in_progress"},"https://attacker.invalid"),env(db));
 assert.equal(response.status,403);
 assert.equal(db.lead.status,"new");
});

test("invalid, expired, unauthorized, tampered or wrong-audience JWTs fail",async()=>{
 const db=fakeDB();
 const valid=await sign(OTHER);
 assert.equal((await worker.fetch(request("/admin/api/me","GET",valid),env(db))).status,403);
 const expired=await sign(ADMIN,{exp:Math.floor(Date.now()/1000)-10});
 assert.equal((await worker.fetch(request("/admin/api/me","GET",expired),env(db))).status,401);
 const wrong=await sign(ADMIN,{aud:["other-app"]});
 assert.equal((await worker.fetch(request("/admin/api/me","GET",wrong),env(db))).status,401);
 const good=await sign(ADMIN);
 const tampered=good.slice(0,-5)+"AAAAA";
 assert.equal((await worker.fetch(request("/admin/api/me","GET",tampered),env(db))).status,401);
});
