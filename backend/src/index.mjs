/* TechStar MVP lead-ingestion API. Staging-first: do not expose until D1 and
   Turnstile are configured and privacy, retention, and operational controls approved. */
const DEFAULT_ORIGIN = "https://sulaimanalsanani.github.io";
const EXPECTED_HOSTNAME = "sulaimanalsanani.github.io";
const PACKAGES = new Set(["basic","bronze","silver","gold","platinum","diamond"]);
const MAX_BODY_BYTES = 12000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+0-9() -]{7,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGIN).split(",").map(s=>s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}
function respond(body,status=200,origin=null) {
  const headers={
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
    "vary":"Origin"
  };
  if (origin) headers["access-control-allow-origin"]=origin;
  return new Response(JSON.stringify(body),{status,headers});
}
function nonempty(value,max) {
  if(typeof value!=="string")return null;
  const trimmed=value.trim();
  return trimmed && trimmed.length<=max ? trimmed : null;
}
function validate(form) {
  if(!form||typeof form!=="object"||Array.isArray(form))return null;
  const name=nonempty(form.name,120);
  const business=nonempty(form.business,140);
  const email=nonempty(form.email,140);
  const phone=nonempty(form.phone,30);
  const industry=nonempty(form.industry,80) || "";
  const pack=form.package === "" || form.package == null ? "" : nonempty(form.package,32);
  const solution=form.solution === "" || form.solution == null ? "" : nonempty(form.solution,64);
  const notes=form.notes === "" || form.notes == null ? "" : nonempty(form.notes,2000);
  const branches=Number(form.branches);
  const pos=Number(form.pos);
  const requestId=form.requestId == null ? null : nonempty(form.requestId,36);
  if(!name||!business||!email||!EMAIL.test(email)||!phone||!PHONE.test(phone))return null;
  if(pack===null || (pack && !PACKAGES.has(pack)))return null;
  if(solution===null || (solution && !/^[a-z0-9_-]+$/i.test(solution)))return null;
  if(notes===null||!Number.isInteger(branches)||branches<1||branches>10000||
     !Number.isInteger(pos)||pos<0||pos>10000)return null;
  if(form.requestId != null && (!requestId||!UUID.test(requestId)))return null;
  return {name,business,email,phone,industry,pack,solution,notes,branches,pos,requestId};
}
async function verifyTurnstile(token,request,env) {
  if(!env.TURNSTILE_SECRET || typeof token!=="string" || token.length<8 || token.length>2048)return false;
  const form=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
  const remoteip=request.headers.get("cf-connecting-ip");
  if(remoteip)form.set("remoteip",remoteip);
  const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form,
    signal:AbortSignal.timeout(8000)
  });
  if(!response.ok)return false;
  const result=await response.json();
  const hostname=String(env.TURNSTILE_HOSTNAME || EXPECTED_HOSTNAME);
  return result.success===true && result.hostname===hostname;
}
async function handleLead(request,env,origin) {
  if(!env.DB || !env.TURNSTILE_SECRET)return respond({error:"service_not_configured"},503,origin);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
    return respond({error:"invalid_content_type"},415,origin);
  const len=Number(request.headers.get("content-length"));
  if(Number.isFinite(len) && len>MAX_BODY_BYTES)return respond({error:"body_too_large"},413,origin);
  let raw;
  try{raw=await request.text()}catch{return respond({error:"invalid_body"},400,origin)}
  if(new TextEncoder().encode(raw).length>MAX_BODY_BYTES)
    return respond({error:"body_too_large"},413,origin);
  let payload;
  try{payload=JSON.parse(raw)}catch{return respond({error:"invalid_json"},400,origin)}
  if(payload.website)return respond({error:"invalid_request"},422,origin);
  const data=validate(payload);
  if(!data)return respond({error:"invalid_fields"},422,origin);
  let isHuman=false;
  try{isHuman=await verifyTurnstile(payload.turnstileToken,request,env)}catch{}
  if(!isHuman)return respond({error:"challenge_failed"},422,origin);
  const id=crypto.randomUUID();
  const requestId=data.requestId||id;
  const reference="TS-"+Date.now().toString(36).toUpperCase()+"-"+id.slice(0,8).toUpperCase();
  try{
    await env.DB.prepare(
      "INSERT INTO leads (id,client_request_id,reference,name,business,email,phone,industry,package_id,solution_id,branches,pos_count,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_request_id) DO NOTHING"
    ).bind(id,requestId,reference,data.name,data.business,data.email,data.phone,data.industry,data.pack,data.solution,data.branches,data.pos,data.notes).run();
    const row=await env.DB.prepare("SELECT reference FROM leads WHERE client_request_id = ?").bind(requestId).first();
    if(!row?.reference)throw Error("Not stored");
    return respond({received:true,reference:row.reference},201,origin);
  }catch{
    return respond({error:"storage_unavailable"},503,origin);
  }
}
export default {
  async fetch(request,env={}) {
    const url=new URL(request.url);
    const origin=allowedOrigin(request.headers.get("origin"),env);
    if(url.pathname==="/health"&&request.method==="GET")
      return respond({status:"ok",ready:!!(env.DB&&env.TURNSTILE_SECRET)});
    if(!origin)return respond({error:"origin_not_allowed"},403);
    if(request.method==="OPTIONS")
      return new Response(null,{status:204,headers:{
        "access-control-allow-origin":origin,"access-control-allow-methods":"GET, POST, OPTIONS",
        "access-control-allow-headers":"content-type","access-control-max-age":"600","vary":"Origin"
      }});
    if(url.pathname==="/api/content"&&request.method==="GET")
      return respond({items:[]},200,origin);
    if(url.pathname==="/api/leads"&&request.method==="POST")
      return handleLead(request,env,origin);
    return respond({error:"not_found"},404,origin);
  }
};
