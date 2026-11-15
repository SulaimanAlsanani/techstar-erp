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
  created_at:"2026-11-14 00:00:00",updated_at:"",assigned_to:"",follow_up_at:"",revision:0
};
function fakeDB(){
 const lead={...seed};
 const audit=[];
 const followupAudit=[];
 let lastUpdate=0;
 return {
  lead,audit,followupAudit,
  prepare(sql){
   let args=[];
   return {
    bind(...x){args=x;this.args=x;return this},
    async first(){
      if(sql.includes("SELECT COUNT(*)"))return {total:1};
      if(sql.includes("SELECT id FROM leads"))return args[0]===lead.id?{id:lead.id}:null;
      if(sql.includes("SELECT * FROM leads"))return args[0]===lead.id?lead:null;
      if(sql.includes("SELECT status FROM leads"))return args[0]===lead.id?{status:lead.status}:null;
      if(sql.includes("SELECT assigned_to,follow_up_at,revision FROM leads"))
        return args[0]===lead.id?{assigned_to:lead.assigned_to,follow_up_at:lead.follow_up_at,revision:lead.revision}:null;
      throw Error("Unexpected first() query: "+sql);
    },
    async all(){
      if(sql.includes("GROUP BY status"))return {results:[{status:lead.status,total:1}]};
      if(sql.includes("FROM lead_audit"))return {results:audit};
      if(sql.includes("FROM lead_followup_audit"))return {results:followupAudit};
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
   if(update.sql.includes("SET assigned_to")){
     const changed=lead.id===update.args[2]&&lead.revision===update.args[3];
     if(changed){
       followupAudit.push({id:insert.args[0],actor_email:insert.args[1],
         previous_assignee:insert.args[2],new_assignee:insert.args[3],
         previous_due:insert.args[4],new_due:insert.args[5],
         created_at:"2026-11-14 12:00:00"});
       lead.assigned_to=update.args[0];lead.follow_up_at=update.args[1];
       lead.revision++;
     }
     return [{meta:{changes:changed?1:0}},{meta:{changes:changed?1:0}}];
   }
   if(lead.id===update.args[1]&&lead.status===update.args[2]){
     lead.status=update.args[0];
     lead.updated_at="2026-11-14 12:00:00";
     lead.revision++;
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
 assert.ok(!adminApp.includes("localStorage.setItem")&&!adminApp.includes("localStorage.getItem"),"CRM app must not persist sensitive data");
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


test("admin can assign a lead and set a UTC follow-up with revision and audit",async()=>{
 const token=await sign(ADMIN),db=fakeDB();
 const due="2026-12-11T11:30:00.000Z";
 const requestBody={assignedTo:VIEWER,followUpAt:due,revision:0};
 const result=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,requestBody),env(db));
 assert.equal(result.status,200);
 assert.deepEqual(await result.json(),{updated:true,id:LEAD_ID,assignedTo:VIEWER,followUpAt:due,revision:1});
 assert.equal(db.lead.assigned_to,VIEWER);
 assert.equal(db.lead.follow_up_at,due);
 assert.equal(db.followupAudit.length,1);
 assert.equal(db.followupAudit[0].actor_email,ADMIN);
 const history=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup-history",
   "GET",token),env(db));
 assert.equal(history.status,200);
 const events=(await history.json()).events;
 assert.equal(events[0].toAssignee,VIEWER);
 assert.equal(events[0].toDue,due);
 const repeat=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,requestBody),env(db));
 assert.equal(repeat.status,409);
 assert.equal(db.followupAudit.length,1);
});

test("viewer cannot assign a lead, but can inspect its follow-up history",async()=>{
 const token=await sign(VIEWER),db=fakeDB();
 const denied=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,{assignedTo:ADMIN,followUpAt:"",revision:0}),env(db));
 assert.equal(denied.status,403);
 assert.equal(db.followupAudit.length,0);
 const history=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup-history",
   "GET",token),env(db));
 assert.equal(history.status,200);
 assert.deepEqual(await history.json(),{events:[]});
});

test("follow-up input blocks invalid dates, non-staff emails, no-op and bad Origin",async()=>{
 const token=await sign(ADMIN),db=fakeDB();
 for(const requestBody of [
   {assignedTo:"outsider@example.test",followUpAt:"",revision:0},
   {assignedTo:ADMIN,followUpAt:"2026-02-31T09:00:00.000Z",revision:0},
   {assignedTo:ADMIN,followUpAt:"2026-11-20",revision:0},
   {assignedTo:ADMIN,followUpAt:"",revision:-1}
 ]){
   const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
     "PATCH",token,requestBody),env(db));
   assert.equal(response.status,422);
 }
 const noChange=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,{assignedTo:"",followUpAt:"",revision:0}),env(db));
 assert.equal(noChange.status,422);
 const crossSite=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,{assignedTo:ADMIN,followUpAt:"",revision:0},
   "https://attacker.invalid"),env(db));
 assert.equal(crossSite.status,403);
 assert.equal(db.followupAudit.length,0);
});

test("status changes increment revision so stale follow-up edits are rejected",async()=>{
 const token=await sign(ADMIN),db=fakeDB();
 const changed=await worker.fetch(request("/admin/api/leads/"+LEAD_ID,"PATCH",token,
   {previousStatus:"new",status:"in_progress"}),env(db));
 assert.equal(changed.status,200);
 assert.equal(db.lead.revision,1);
 const stale=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/followup",
   "PATCH",token,{assignedTo:ADMIN,followUpAt:"",revision:0}),env(db));
 assert.equal(stale.status,409);
});


test("CRM follow-up filtering is parameterized, scoped to signed-in user",async()=>{
 const token=await sign(VIEWER);
 const calls=[];
 const database={prepare(sql){
   const entry={sql,args:[]};calls.push(entry);
   return {
     bind(...args){entry.args=args;return this},
     async all(){return {results:[]}},
     async first(){return {total:0}}
   };
 }};
 const url="/admin/api/leads?due=overdue&assigned=mine&status=in_progress&q=100%25%27&limit=10&offset=0";
 const response=await worker.fetch(request(url,"GET",token),env(database));
 assert.equal(response.status,200);
 const result=await response.json();
 assert.equal(result.items.length,0);
 assert.equal(calls.length,2);
 assert.match(calls[0].sql,/assigned_to = \?/);
 assert.match(calls[0].sql,/follow_up_at < strftime/);
 assert.match(calls[0].sql,/status NOT IN/);
 assert.ok(!calls[0].sql.includes("100%"));
 assert.ok(calls[0].args.includes(VIEWER));
 assert.ok(calls[0].args.some(x=>String(x).includes("100")));
 assert.equal(result.limit,10);
});

test("CRM follow-up and assignment filters reject unsupported values",async()=>{
 const token=await sign(ADMIN);
 let calls=0;
 const db={prepare(){calls++;throw Error("Unexpected query")}};
 for(const path of [
   "/admin/api/leads?due=yesterday",
   "/admin/api/leads?assigned=anybody",
   "/admin/api/leads?due=overdue&limit=999"
 ]){
   const response=await worker.fetch(request(path,"GET",token),env(db));
   assert.equal(response.status,422);
 }
 assert.equal(calls,0);
});

test("unassigned and unscheduled filters use fixed SQL without user interpolation",async()=>{
 const token=await sign(ADMIN);
 const calls=[];
 const db={prepare(sql){
   calls.push(sql);
   return {bind(){return this},async all(){return {results:[]}},
     async first(){return {total:0}}};
 }};
 const response=await worker.fetch(request(
   "/admin/api/leads?assigned=unassigned&due=unscheduled",
   "GET",token),env(db));
 assert.equal(response.status,200);
 assert.match(calls[0],/assigned_to = ''/);
 assert.match(calls[0],/follow_up_at = ''/);
});


test("CSV export is forbidden to viewers even with signed Access JWT",async()=>{
 const token=await sign(VIEWER),db=fakeDB();
 const response=await worker.fetch(request("/admin/api/leads/export.csv","GET",token),env(db));
 assert.equal(response.status,403);
 assert.equal((await response.json()).error,"permission_denied");
});

function exportDB(rows,{auditChanges=1}={}){
 const statements=[];
 return {
   statements,
   prepare(sql){
     const item={sql,args:[]};statements.push(item);
     return {
       bind(...values){item.args=values;return this},
       async all(){
         if(!sql.includes("FROM leads")||!sql.includes("LIMIT 501"))throw Error("Unbounded export query");
         return {results:rows};
       },
       async run(){
         if(!sql.includes("INSERT INTO crm_export_audit"))throw Error("Audit statement missing");
         return {meta:{changes:auditChanges}};
       }
     };
   }
 };
}
test("administrator export quotes CSV, neutralizes spreadsheet formulas and writes audit",async()=>{
 const token=await sign(ADMIN);
 const db=exportDB([
   {...seed,name:'=HYPERLINK("https://danger.test")',business:'Company, "North"',
     email:"user@company.test",notes:"\t+SUM(1,2)\nContinued",assigned_to:VIEWER},
   {...seed,id:"other",name:"علي",business:"شركة تجريبية",notes:"-42",
     reference:"TS-2"}
 ]);
 const response=await worker.fetch(request(
   "/admin/api/leads/export.csv?assigned=mine&status=new&q=needle","GET",token),env(db));
 assert.equal(response.status,200);
 assert.match(response.headers.get("content-type"),/text\/csv/);
 assert.match(response.headers.get("content-disposition"),/attachment/);
 assert.equal(response.headers.get("cache-control"),"no-store, private");
 assert.equal(response.headers.get("access-control-allow-origin"),null);
 const csv=await response.text();
 assert.ok(csv.includes('"\'=HYPERLINK('), "Excel formula must be prefixed");
 assert.ok(csv.includes('"Company, ""North"""'), "Comma and double quote must be escaped");
 assert.ok(csv.includes('"\'-42"'), "Numeric-looking formulas must be prefixed");
 assert.ok(!csv.includes("\nContinued"), "Raw newline inside customer fields must be flattened");
 assert.equal(db.statements.length,2);
 assert.ok(db.statements[0].sql.includes("assigned_to = ?"));
 assert.ok(db.statements[0].args.includes(ADMIN));
 assert.equal(db.statements[1].args[1],ADMIN);
 assert.equal(db.statements[1].args[2],2);
 const auditFilters=JSON.parse(db.statements[1].args[3]);
 assert.deepEqual(auditFilters,{status:"new",due:"",assigned:"mine",searched:true});
 assert.ok(!db.statements[1].args[3].includes("needle"),"Search values must not be logged");
});

test("CSV export refuses more than 500 records without writing audit",async()=>{
 const token=await sign(ADMIN);
 const db=exportDB(Array.from({length:501},(_,i)=>({...seed,id:String(i)})));
 const response=await worker.fetch(request("/admin/api/leads/export.csv","GET",token),env(db));
 assert.equal(response.status,413);
 assert.equal((await response.json()).error,"export_limit_exceeded");
 assert.equal(db.statements.length,1);
});

test("CSV export fails closed when audit cannot be persisted",async()=>{
 const token=await sign(ADMIN),db=exportDB([seed],{auditChanges:0});
 const response=await worker.fetch(request("/admin/api/leads/export.csv","GET",token),env(db));
 assert.equal(response.status,503);
 assert.equal((await response.json()).error,"audit_unavailable");
 assert.equal(response.headers.get("content-type").includes("csv"),false);
});

test("CSV export rejects invalid filters before accessing the database",async()=>{
 const token=await sign(ADMIN);
 let accessed=false;
 const db={prepare(){accessed=true;throw Error("Unexpected database access")}};
 const response=await worker.fetch(request("/admin/api/leads/export.csv?due=tomorrow","GET",token),env(db));
 assert.equal(response.status,422);
 assert.equal(accessed,false);
});


test("CRM export history is restricted to administrators",async()=>{
 const viewer=await sign(VIEWER);
 const db=exportDB([]);
 const denied=await worker.fetch(request("/admin/api/exports","GET",viewer),env(db));
 assert.equal(denied.status,403);
 assert.equal(db.statements.length,0);
 const admin=await sign(ADMIN);
 const result=await worker.fetch(request("/admin/api/exports","GET",admin),env({
   prepare(sql){
     assert.match(sql,/FROM crm_export_audit/);
     assert.match(sql,/LIMIT 50/);
     return {async all(){return {results:[{
       id:"export-record",actor_email:ADMIN,record_count:12,
       filter_summary:JSON.stringify({status:"new",due:"",assigned:"",searched:true}),
       created_at:"2026-11-15 00:00:00"
     }]}}};
   }
 }));
 assert.equal(result.status,200);
 const payload=await result.json();
 assert.equal(payload.events[0].actor,ADMIN);
 assert.equal(payload.events[0].count,12);
 assert.equal(payload.events[0].filters.searched,true);
 assert.equal(payload.events[0].filters.q,undefined);
});


function noteDB(){
  const notes=[];
  return {
    notes,
    prepare(sql){
      let args=[];
      return {
        bind(...a){args=a;return this},
        async first(){
          if(sql.startsWith("SELECT id FROM leads"))
            return args[0]===LEAD_ID?{id:LEAD_ID}:null;
          throw Error("Unexpected notes lookup: "+sql);
        },
        async all(){
          if(!sql.includes("FROM lead_notes"))throw Error("Unexpected notes query: "+sql);
          return {results:notes.filter(n=>n.lead_id===args[0]).slice().reverse()};
        },
        async run(){
          if(!sql.startsWith("INSERT INTO lead_notes"))throw Error("Unexpected notes insert");
          notes.push({
            id:args[0],lead_id:args[1],actor_email:args[2],body:args[3],
            created_at:"2026-11-15 10:00:00"
          });
          return {meta:{changes:1}};
        }
      };
    }
  };
}
test("CRM notes are visible to viewer but only admin can add them",async()=>{
 const db=noteDB();
 const viewer=await sign(VIEWER);
 const initial=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","GET",viewer),env(db));
 assert.equal(initial.status,200);
 assert.deepEqual(await initial.json(),{notes:[]});
 const denied=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","POST",viewer,{text:"A note"}),env(db));
 assert.equal(denied.status,403);
 assert.equal(db.notes.length,0);
 const admin=await sign(ADMIN);
 const create=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","POST",admin,{
   text:'  تم الاتصال بالعميل <script>alert("x")</script>  '
 }),env(db));
 assert.equal(create.status,201);
 assert.equal((await create.json()).created,true);
 const viewed=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","GET",viewer),env(db));
 const history=await viewed.json();
 assert.equal(history.notes.length,1);
 assert.equal(history.notes[0].actor,ADMIN);
 assert.equal(history.notes[0].text,'تم الاتصال بالعميل <script>alert("x")</script>');
 assert.equal(db.notes.length,1);
});
test("CRM notes validation and cross-site protections reject unsafe requests",async()=>{
 const admin=await sign(ADMIN),db=noteDB();
 for(const input of [{text:" "},{text:"x".repeat(1501)},{text:42},null]){
   const response=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","POST",admin,input),env(db));
   assert.equal(response.status,422);
 }
 const crossSite=await worker.fetch(request("/admin/api/leads/"+LEAD_ID+"/notes","POST",admin,{text:"note"},"https://attacker.test"),env(db));
 assert.equal(crossSite.status,403);
 const missing=await worker.fetch(request("/admin/api/leads/123e4567-e89b-42d3-a456-426614174000/notes","GET",admin),env(db));
 assert.equal(missing.status,404);
 assert.equal(db.notes.length,0);
});
