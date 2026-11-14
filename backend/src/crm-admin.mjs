import {authenticateAdmin} from "./admin-auth.mjs";

const STATUSES=["new","in_progress","quoted","won","lost","archived"];
const TRANSITIONS={
  new:new Set(["in_progress","lost","archived"]),
  in_progress:new Set(["quoted","won","lost","archived"]),
  quoted:new Set(["in_progress","won","lost","archived"]),
  won:new Set(["archived","in_progress"]),
  lost:new Set(["in_progress","archived"]),
  archived:new Set(["in_progress"])
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body,status=200,method="GET"){
  return new Response(JSON.stringify(body),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "x-content-type-options":"nosniff",
      "referrer-policy":"no-referrer",
      "x-frame-options":"DENY",
      "vary":"CF-Access-Jwt-Assertion",
      "allow":method==="PATCH"?"GET, PATCH":"GET"
    }
  });
}
function fail(error,status){return json({error},status)}
function badPath(id){return typeof id!=="string"||!UUID.test(id)}
function formatLead(r,details=false){
  const publicFields={
    id:r.id,reference:r.reference,name:r.name,business:r.business,
    package:r.package_id,status:r.status,branches:r.branches,pos:r.pos_count,
    createdAt:r.created_at,updatedAt:r.updated_at
  };
  if(details)return {...publicFields,
    email:r.email,phone:r.phone,industry:r.industry,solution:r.solution_id,notes:r.notes};
  return publicFields;
}
async function listLeads(url,db){
  const status=url.searchParams.get("status")||"";
  const rawLimit=url.searchParams.get("limit")||"20";
  const rawOffset=url.searchParams.get("offset")||"0";
  const q=(url.searchParams.get("q")||"").trim();
  if((status&&!STATUSES.includes(status))||!(/^[1-9][0-9]*$/.test(rawLimit))||
     !(/^(0|[1-9][0-9]*)$/.test(rawOffset))||q.length>80)
    return fail("invalid_filters",422);
  const limit=Number(rawLimit),offset=Number(rawOffset);
  if(limit>50||offset>5000)return fail("invalid_filters",422);
  const where=[];
  const binds=[];
  if(status){where.push("status = ?");binds.push(status)}
  if(q){
    const escaped=q.replace(/[\\%_]/g,"\\$&");
    where.push("(reference LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR business LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
    for(let i=0;i<5;i++)binds.push("%"+escaped+"%");
  }
  const sqlWhere=where.length?" WHERE "+where.join(" AND "):"";
  const list=await db.prepare("SELECT id,reference,name,business,package_id,status,branches,pos_count,created_at,updated_at FROM leads"+
    sqlWhere+" ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?")
    .bind(...binds,limit,offset).all();
  const count=await db.prepare("SELECT COUNT(*) AS total FROM leads"+sqlWhere).bind(...binds).first();
  return json({items:(list.results||[]).map(x=>formatLead(x)),total:Number(count?.total||0),limit,offset});
}
async function leadDetail(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const row=await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  return row?json({lead:formatLead(row,true)}):fail("lead_not_found",404);
}
async function auditLog(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const lead=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!lead)return fail("lead_not_found",404);
  const rows=await db.prepare(
    "SELECT id,actor_email,action,previous_status,new_status,created_at FROM lead_audit WHERE lead_id = ? ORDER BY created_at DESC,id DESC LIMIT 100"
  ).bind(id).all();
  return json({events:(rows.results||[]).map(row=>({
    id:row.id,actor:row.actor_email,action:row.action,from:row.previous_status,
    to:row.new_status,createdAt:row.created_at
  }))});
}
async function summary(db){
  const rows=await db.prepare(
    "SELECT status,COUNT(*) AS total FROM leads GROUP BY status"
  ).all();
  const totals=Object.fromEntries(STATUSES.map(s=>[s,0]));
  for(const row of rows.results||[])if(row.status in totals)totals[row.status]=Number(row.total)||0;
  return json({statuses:totals,total:Object.values(totals).reduce((a,b)=>a+b,0)});
}
async function changeStatus(request,url,id,env,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  if(badPath(id))return fail("invalid_id",422);
  const origin=request.headers.get("origin");
  if(origin&&origin!==url.origin)return fail("origin_not_allowed",403);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
    return fail("invalid_content_type",415);
  const length=Number(request.headers.get("content-length"));
  if(Number.isFinite(length)&&length>512)return fail("invalid_body",413);
  let body;
  try{
    const text=await request.text();
    if(new TextEncoder().encode(text).length>512)return fail("invalid_body",413);
    body=JSON.parse(text);
  }catch{return fail("invalid_json",400)}
  if(!body||typeof body!=="object"||Array.isArray(body)||
     !STATUSES.includes(body.status)||!STATUSES.includes(body.previousStatus))
    return fail("invalid_fields",422);
  if(!TRANSITIONS[body.previousStatus]?.has(body.status))
    return fail("invalid_transition",422);
  const row=await env.DB.prepare("SELECT status FROM leads WHERE id = ?").bind(id).first();
  if(!row)return fail("lead_not_found",404);
  if(row.status!==body.previousStatus)return fail("status_conflict",409);

  const auditId=crypto.randomUUID();
  const update=env.DB.prepare(
    "UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?"
  ).bind(body.status,id,body.previousStatus);
  // The INSERT uses SQLite changes() on the prior UPDATE within a D1 atomic batch.
  // A conflicting UPDATE therefore cannot produce a false audit event.
  const audit=env.DB.prepare(
    "INSERT INTO lead_audit (id,lead_id,actor_email,action,previous_status,new_status) "+
    "SELECT ?,id,?,'status_changed',?,? FROM leads WHERE id = ? AND status = ? AND changes() = 1"
  ).bind(auditId,actor.email,body.previousStatus,body.status,id,body.status);
  const results=await env.DB.batch([update,audit]);
  if(results?.[0]?.meta?.changes!==1)return fail("status_conflict",409);
  if(results?.[1]?.meta?.changes!==1)return fail("audit_unavailable",503);
  return json({updated:true,id,status:body.status});
}

/* No CORS on these routes. They are intended for a Cloudflare Access-protected
 * same-origin Worker admin UI, never the GitHub Pages public form.
 */
export async function handleAdminAPI(request,env,url){
  const auth=await authenticateAdmin(request,env);
  if(!auth.ok)return fail(auth.error,auth.status);
  if(!env.DB)return fail("admin_not_configured",503);
  const path=url.pathname;
  const segments=path.split("/").filter(Boolean);
  try{
    if(path==="/admin/api/summary"&&request.method==="GET")return summary(env.DB);
    if(path==="/admin/api/leads"&&request.method==="GET")return listLeads(url,env.DB);
    if(segments.length===4&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"){
      if(request.method==="GET")return leadDetail(segments[3],env.DB);
      if(request.method==="PATCH")return changeStatus(request,url,segments[3],env,auth);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="audit"){
      if(request.method==="GET")return auditLog(segments[3],env.DB);
    }
    return fail("not_found",404);
  }catch{
    // DB or infrastructure details must not be returned to the browser.
    return fail("admin_service_unavailable",503);
  }
}
