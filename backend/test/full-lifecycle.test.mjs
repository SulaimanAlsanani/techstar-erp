import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import worker from "../src/index.mjs";

// Real migrated SQLite + actual Worker request handlers. No external requests,
// customer records, Cloudflare secrets, or production ingestion.
const issuer="https://techstar-isolated-e2e.cloudflareaccess.com";
const origin="https://sulaimanalsanani.github.io";
const base="https://crm-test.example.invalid";
const admin="admin@sample.test",viewer="viewer@sample.test";

function createDB(){
 const sql=new DatabaseSync(":memory:");
 sql.exec("PRAGMA foreign_keys=ON");
 const directory=new URL("../migrations/",import.meta.url);
 const migrations=readdirSync(directory).filter(p=>/^\d{4}_.+\.sql$/.test(p)).sort();
 assert.ok(migrations.length>=6);
 for(const name of migrations)sql.exec(readFileSync(new URL(name,directory),"utf8"));
 const statement=(text,args=[])=>({
   bind(...values){return statement(text,values)},
   async first(){return sql.prepare(text).get(...args)??null},
   async all(){return {results:sql.prepare(text).all(...args)}},
   execute(){const info=sql.prepare(text).run(...args);return {meta:{changes:Number(info.changes)}}},
   async run(){return this.execute()}
 });
 const db={
   prepare(text){return statement(text)},
   async batch(items){
     sql.exec("BEGIN IMMEDIATE");
     try{const result=items.map(p=>p.execute());sql.exec("COMMIT");return result}
     catch(error){sql.exec("ROLLBACK");throw error}
   }
 };
 return {db,sql,migrations};
}
function b64(value){return Buffer.from(value).toString("base64url")}
async function identity(){
 const pair=await crypto.subtle.generateKey({
   name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
   publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"
 },true,["sign","verify"]);
 const jwk={...await crypto.subtle.exportKey("jwk",pair.publicKey),
   kid:"isolated-test",alg:"RS256",use:"sig"};
 async function token(email){
   const now=Math.floor(Date.now()/1000);
   const head=b64(JSON.stringify({alg:"RS256",kid:"isolated-test"}));
   const body=b64(JSON.stringify({iss:issuer,aud:"test-audience",email,
     iat:now,nbf:now-2,exp:now+1800}));
   const raw=head+"."+body;
   const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,new TextEncoder().encode(raw));
   return raw+"."+b64(sig);
 }
 return {token,jwk};
}
function request(path,{method="GET",body,token,origin:from}={}){
 const headers=new Headers();
 if(body!==undefined)headers.set("content-type","application/json");
 if(token)headers.set("cf-access-jwt-assertion",token);
 if(from)headers.set("origin",from);
 return new Request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
async function api(env,path,options,status){
 const result=await worker.fetch(request(path,options),env);
 assert.equal(result.status,status,(options?.method||"GET")+" "+path);
 return result.json();
}
function count(sql,table){
 const valid=new Set(["leads","lead_audit","lead_followup_audit",
   "lead_notes","lead_followup_completions","crm_export_audit"]);
 assert.ok(valid.has(table));
 return Number(sql.prepare("SELECT COUNT(*) AS n FROM "+table).get().n);
}

test("entire lead -> signed CRM -> follow-up -> completion -> export lifecycle on real SQLite",async()=>{
 const {sql,db,migrations}=createDB();
 const oldFetch=globalThis.fetch;
 const {token,jwk}=await identity();
 const env={
   DB:db,ALLOWED_ORIGINS:origin,LEAD_INGESTION_ENABLED:"false",
   TURNSTILE_SECRET:"fake-secret-for-test-only",
   TURNSTILE_HOSTNAME:"sulaimanalsanani.github.io",
   LEAD_RATE_LIMITER:{async limit(){return {success:true}}},
   ACCESS_ISSUER:issuer,ACCESS_AUD:"test-audience",
   CRM_ADMIN_EMAILS:admin,CRM_VIEWER_EMAILS:viewer
 };
 let verifyCount=0;
 globalThis.fetch=async(url,options={})=>{
   if(String(url)===issuer+"/cdn-cgi/access/certs")
     return new Response(JSON.stringify({keys:[jwk]}));
   if(String(url)==="https://challenges.cloudflare.com/turnstile/v0/siteverify"){
     verifyCount++;
     assert.equal(options.body.get("secret"),env.TURNSTILE_SECRET);
     return new Response(JSON.stringify({
       success:options.body.get("response")==="verified-token",
       hostname:"sulaimanalsanani.github.io"
     }));
   }
   throw Error("Unexpected external request");
 };
 try{
   assert.ok(migrations.includes("0006_followup_completions.sql"));
   const body={
     name:"Fictional Customer",business:"Fictional Retail Shop",
     email:"customer@sample.test",phone:"0501234567",
     industry:"retail",package:"gold",solution:"pos",branches:2,pos:3,
     notes:"Synthetic test only",
     requestId:"d02b5df8-d0c0-4ac3-af65-60f013f0a411",
     turnstileToken:"verified-token"
   };
   let answer=await api(env,"/api/leads",{method:"POST",origin,body},503);
   assert.equal(answer.error,"lead_ingestion_disabled");
   assert.equal(count(sql,"leads"),0);
   assert.equal(verifyCount,0);
   env.LEAD_INGESTION_ENABLED="true"; // Test-only in-memory environment.
   answer=await api(env,"/api/leads",{method:"POST",origin,body:{...body,turnstileToken:"invalid-token"}},422);
   assert.equal(answer.error,"challenge_failed");
   assert.equal(count(sql,"leads"),0);
   await api(env,"/api/leads",{method:"POST",origin:"https://attacker.test",body},403);
   const first=await api(env,"/api/leads",{method:"POST",origin,body},201);
   assert.equal(first.received,true);
   const repeated=await api(env,"/api/leads",{method:"POST",origin,body},201);
   assert.equal(repeated.reference,first.reference);
   assert.equal(count(sql,"leads"),1,"Idempotent retry must not duplicate the request");

   const boss=await token(admin),readonly=await token(viewer);
   const path="/admin/api/leads";
   await api(env,path,{},401);
   const list=await api(env,path,{token:readonly},200);
   assert.equal(list.total,1);
   assert.equal(list.items[0].reference,first.reference);
   const id=list.items[0].id;
   await api(env,path+"/"+id,{method:"PATCH",token:readonly,
     body:{previousStatus:"new",status:"in_progress"}},403);
   const changed=await api(env,path+"/"+id,{method:"PATCH",token:boss,
     body:{previousStatus:"new",status:"in_progress"}},200);
   assert.equal(changed.updated,true);
   assert.equal(count(sql,"lead_audit"),1);
   const dueDate=new Date(Date.now()+2*86400000);
   dueDate.setUTCMilliseconds(0);
   const due=dueDate.toISOString();
   const follow=await api(env,path+"/"+id+"/followup",{method:"PATCH",token:boss,
     body:{assignedTo:viewer,followUpAt:due,revision:1}},200);
   assert.equal(follow.revision,2);
   assert.equal(count(sql,"lead_followup_audit"),1);
   const conflict=await api(env,path+"/"+id+"/followup",{method:"PATCH",token:boss,
     body:{assignedTo:admin,followUpAt:due,revision:1}},409);
   assert.equal(conflict.error,"revision_conflict");
   await api(env,path+"/"+id+"/notes",{method:"POST",token:boss,
     body:{text:"Synthetic call note, no personal data."}},201);
   assert.equal(count(sql,"lead_notes"),1);
   const queue=await api(env,path+"?due=upcoming7&assigned=mine",{token:readonly},200);
   assert.equal(queue.total,1);
   const before=await api(env,path+"/"+id+"/timeline",{token:readonly},200);
   assert.deepEqual(new Set(before.events.map(e=>e.kind)),
     new Set(["status","assignment","note"]));
   const finished=await api(env,path+"/"+id+"/complete-followup",{method:"POST",
     token:boss,body:{revision:2}},200);
   assert.equal(finished.revision,3);
   assert.equal(count(sql,"lead_followup_completions"),1);
   assert.equal(sql.prepare("SELECT follow_up_at FROM leads WHERE id=?").get(id).follow_up_at,"");
   const timeline=await api(env,path+"/"+id+"/timeline",{token:readonly},200);
   assert.ok(timeline.events.some(e=>e.kind==="completion"));
   assert.equal((await api(env,path+"?due=upcoming7",{token:readonly},200)).total,0);
   await api(env,path+"/export.csv",{token:readonly},403);
   const csvResponse=await worker.fetch(request(path+"/export.csv",{token:boss}),env);
   assert.equal(csvResponse.status,200);
   const csv=await csvResponse.text();
   assert.ok(csv.includes(first.reference));
   assert.ok(csv.includes("Fictional Retail Shop"));
   assert.equal(count(sql,"crm_export_audit"),1);
   const exports=await api(env,"/admin/api/exports",{token:boss},200);
   assert.equal(exports.events[0].actor,admin);
   assert.equal(exports.events[0].count,1);
   env.LEAD_INGESTION_ENABLED="false";
   assert.equal((await api(env,"/health",{origin},200)).ready,false);
   console.log("Full CRM lifecycle passed with",migrations.length,"real SQLite migrations");
 }finally{
   globalThis.fetch=oldFetch;
   sql.close();
 }
});
