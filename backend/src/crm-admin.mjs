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
    createdAt:r.created_at,updatedAt:r.updated_at,
    assignedTo:r.assigned_to||'',followUpAt:r.follow_up_at||'',revision:Number(r.revision)||0
  };
  if(details)return {...publicFields,
    email:r.email,phone:r.phone,industry:r.industry,solution:r.solution_id,notes:r.notes};
  return publicFields;
}
function validCalendarDate(value){
  if(value==="")return true;
  if(!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))return false;
  const date=new Date(value+"T00:00:00Z");
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function buildLeadFilter(url,actor){
  const status=url.searchParams.get("status")||"";
  const q=(url.searchParams.get("q")||"").trim();
  const due=url.searchParams.get("due")||"";
  const assigned=url.searchParams.get("assigned")||"";
  const attention=url.searchParams.get("attention")||"";
  const createdFrom=url.searchParams.get("created_from")||"";
  const createdTo=url.searchParams.get("created_to")||"";
  if(!validCalendarDate(createdFrom)||!validCalendarDate(createdTo)||
     (createdFrom&&createdTo&&createdFrom>createdTo))return null;
  if((attention&&!["unassigned_new","stale_new"].includes(attention))||
     (due&&!["overdue","upcoming7","scheduled","unscheduled"].includes(due))||
     (assigned&&!["mine","unassigned"].includes(assigned))||
     (status&&!STATUSES.includes(status))||q.length>80)
    return null;
  const where=[];
  const binds=[];
  if(status){where.push("status = ?");binds.push(status)}
  if(createdFrom){where.push("created_at >= datetime(?)");binds.push(createdFrom)}
  if(createdTo){where.push("created_at < datetime(?,'+1 day')");binds.push(createdTo)}
  if(assigned==="mine"){where.push("assigned_to = ?");binds.push(actor.email)}
  if(assigned==="unassigned"){where.push("assigned_to = ''")}
  if(attention==="unassigned_new")where.push("status = 'new' AND assigned_to = ''");
  if(attention==="stale_new")where.push("status = 'new' AND created_at < datetime('now','-24 hours')");
  if(due==="scheduled")where.push("follow_up_at <> ''");
  if(due==="unscheduled")where.push("follow_up_at = ''");
  if(due==="overdue")where.push(
    "follow_up_at <> '' AND follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') "+
    "AND status NOT IN ('won','lost','archived')"
  );
  if(due==="upcoming7")where.push(
    "follow_up_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') "+
    "AND follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days') "+
    "AND status NOT IN ('won','lost','archived')"
  );
  if(q){
    const escaped=q.replace(/[\\%_]/g,"\\$&");
    where.push("(reference LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR business LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
    for(let i=0;i<5;i++)binds.push("%"+escaped+"%");
  }
  const sqlWhere=where.length?" WHERE "+where.join(" AND "):"";
  // Sorting expressions are fixed literals selected from validated filter values.
  // Overdue and upcoming queues prioritize the earliest due dates.
  // Stale new requests prioritize the oldest unhandled inquiries.
  const sort=(due==="overdue"||due==="upcoming7")?
    "follow_up_at ASC,id ASC":
    attention==="stale_new"?"created_at ASC,id ASC":"created_at DESC,id DESC";
  return {sqlWhere,binds,sort};
}
async function listLeads(url,db,actor){
  const rawLimit=url.searchParams.get("limit")||"20";
  const rawOffset=url.searchParams.get("offset")||"0";
  if(!(/^[1-9][0-9]*$/.test(rawLimit))||!(/^(0|[1-9][0-9]*)$/.test(rawOffset)))
    return fail("invalid_filters",422);
  const limit=Number(rawLimit),offset=Number(rawOffset);
  if(limit>50||offset>5000)return fail("invalid_filters",422);
  const filter=buildLeadFilter(url,actor);
  if(!filter)return fail("invalid_filters",422);
  const {sqlWhere,binds,sort}=filter;
  const list=await db.prepare("SELECT id,reference,name,business,package_id,status,branches,pos_count,created_at,updated_at,assigned_to,follow_up_at,revision FROM leads"+
    sqlWhere+" ORDER BY "+sort+" LIMIT ? OFFSET ?")
    .bind(...binds,limit,offset).all();
  const count=await db.prepare("SELECT COUNT(*) AS total FROM leads"+sqlWhere).bind(...binds).first();
  return json({items:(list.results||[]).map(x=>formatLead(x)),total:Number(count?.total||0),limit,offset});
}

const EXPORT_COLUMNS = [
  ["reference","المرجع"],["business","المنشأة"],["name","المسؤول"],
  ["email","البريد الإلكتروني"],["phone","الجوال"],
  ["industry","النشاط"],["package_id","الباقة"],["solution_id","الحل"],
  ["status","الحالة"],["assigned_to","الموظف المكلّف"],
  ["follow_up_at","موعد المتابعة"],["branches","الفروع"],
  ["pos_count","نقاط البيع"],["notes","المتطلبات"],["created_at","تاريخ الإنشاء"]
];
function safeCSVCell(value){
  const normalized=String(value==null?"":value).replace(/[\r\n\t\x00-\x1f\x7f]/g," ");
  const risky=/^[\s\uFEFF\u200B\u200C\u200D]*[=+\-@]/.test(normalized);
  const safe=(risky?"'":"")+normalized;
  return '"'+safe.replace(/"/g,'""')+'"';
}
async function exportLeads(request,url,env,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  const filter=buildLeadFilter(url,actor);
  if(!filter)return fail("invalid_filters",422);
  const sql="SELECT "+EXPORT_COLUMNS.map(([column])=>column).join(",")+
    " FROM leads"+filter.sqlWhere+
    " ORDER BY "+filter.sort+" LIMIT 501";
  const found=await env.DB.prepare(sql).bind(...filter.binds).all();
  const records=found.results||[];
  if(records.length>500)return fail("export_limit_exceeded",413);
  // Keep the audit record without storing the search text itself.
  const choices={
    status:url.searchParams.get("status")||"",
    due:url.searchParams.get("due")||"",
    assigned:url.searchParams.get("assigned")||"",
    attention:url.searchParams.get("attention")||"",
    createdFrom:url.searchParams.get("created_from")||"",
    createdTo:url.searchParams.get("created_to")||"",
    searched:Boolean((url.searchParams.get("q")||"").trim())
  };
  const logged=await env.DB.prepare(
    "INSERT INTO crm_export_audit (id,actor_email,record_count,filter_summary) VALUES (?,?,?,?)"
  ).bind(crypto.randomUUID(),actor.email,records.length,JSON.stringify(choices)).run();
  if(logged?.meta?.changes!==1)return fail("audit_unavailable",503);
  const lines=[
    EXPORT_COLUMNS.map(([key,title])=>safeCSVCell(title)).join(","),
    ...records.map(row=>EXPORT_COLUMNS.map(([key])=>safeCSVCell(row[key])).join(","))
  ];
  return new Response("\uFEFF"+lines.join("\r\n")+"\r\n",{
    status:200,headers:{
      "content-type":"text/csv; charset=utf-8",
      "content-disposition":'attachment; filename="techstar-crm-leads.csv"',
      "cache-control":"no-store, private",
      "x-content-type-options":"nosniff",
      "referrer-policy":"no-referrer",
      "x-frame-options":"DENY",
      "vary":"CF-Access-Jwt-Assertion"
    }
  });
}

async function exportHistory(db,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  const result=await db.prepare(
    "SELECT id,actor_email,record_count,filter_summary,created_at "+
    "FROM crm_export_audit ORDER BY created_at DESC,id DESC LIMIT 50"
  ).all();
  return json({events:(result.results||[]).map(r=>({
    id:r.id,actor:r.actor_email,count:Number(r.record_count)||0,
    filters:JSON.parse(r.filter_summary),createdAt:r.created_at
  }))});
}
async function leadNotes(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const lead=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!lead)return fail("lead_not_found",404);
  const rows=await db.prepare(
    "SELECT id,actor_email,body,created_at FROM lead_notes "+
    "WHERE lead_id = ? ORDER BY created_at DESC,id DESC LIMIT 100"
  ).bind(id).all();
  return json({notes:(rows.results||[]).map(r=>({
    id:r.id,actor:r.actor_email,text:r.body,createdAt:r.created_at
  }))});
}
async function addLeadNote(request,url,id,db,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  if(badPath(id))return fail("invalid_id",422);
  const origin=request.headers.get("origin");
  if(origin&&origin!==url.origin)return fail("origin_not_allowed",403);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
    return fail("invalid_content_type",415);
  const len=Number(request.headers.get("content-length"));
  if(Number.isFinite(len)&&len>3500)return fail("body_too_large",413);
  let body;
  try{
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>3500)return fail("body_too_large",413);
    body=JSON.parse(raw);
  }catch{return fail("invalid_json",400)}
  if(!body||typeof body!=="object"||Array.isArray(body)||
     typeof body.text!=="string")return fail("invalid_fields",422);
  const content=body.text.trim();
  if(content.length<1||content.length>1500)return fail("invalid_fields",422);
  const lead=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!lead)return fail("lead_not_found",404);
  const noteId=crypto.randomUUID();
  const r=await db.prepare(
    "INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)"
  ).bind(noteId,id,actor.email,content).run();
  if(r?.meta?.changes!==1)return fail("storage_unavailable",503);
  return json({created:true,id:noteId},201);
}

async function leadTimeline(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const exists=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!exists)return fail("lead_not_found",404);
  const sql="SELECT id,'status' AS kind,actor_email,created_at,\n  json_object('from',previous_status,'to',new_status) AS detail FROM lead_audit WHERE lead_id = ?\nUNION ALL\nSELECT id,'assignment',actor_email,created_at,\n  json_object('fromAssignee',previous_assignee,'toAssignee',new_assignee,'fromDue',previous_due,'toDue',new_due)\n  FROM lead_followup_audit WHERE lead_id = ?\nUNION ALL\nSELECT id,'completion',actor_email,completed_at AS created_at,\n  json_object('dueAt',due_at) FROM lead_followup_completions WHERE lead_id = ?\nUNION ALL\nSELECT id,'note',actor_email,created_at,\n  json_object('text',body) FROM lead_notes WHERE lead_id = ?\nORDER BY created_at DESC,id DESC LIMIT 150";
  const result=await db.prepare(sql).bind(id,id,id,id).all();
  return json({events:(result.results||[]).map(r=>({
    id:r.id,kind:r.kind,actor:r.actor_email,createdAt:r.created_at,
    details:JSON.parse(r.detail)
  }))});
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
function systemStatus(env,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  const d1=typeof env.DB?.prepare==="function";
  const turnstile=typeof env.TURNSTILE_SECRET==="string"&&env.TURNSTILE_SECRET.length>0;
  const limiter=typeof env.LEAD_RATE_LIMITER?.limit==="function";
  const ingestion=env.LEAD_INGESTION_ENABLED==="true";
  const days=Number(env.CRM_RETENTION_DAYS);
  const retention=env.CRM_RETENTION_ENABLED==="true"&&Number.isInteger(days)&&
    days>=30&&days<=3650;
  return json({
    checks:{accessAuthenticated:true,d1Binding:d1,turnstileSecretPresent:turnstile,
      rateLimitBinding:limiter,leadIngestionEnabled:ingestion,
      retentionPolicyEnabled:retention},
    leadIntakeConfigured:d1&&turnstile&&limiter&&ingestion,
    note:"These are binding/configuration checks only; remote service health and privacy approvals require separate verification."
  });
}
async function summary(db){
  const rows=await db.prepare(
    "SELECT status,COUNT(*) AS total FROM leads GROUP BY status"
  ).all();
  const totals=Object.fromEntries(STATUSES.map(s=>[s,0]));
  for(const row of rows.results||[])if(row.status in totals)totals[row.status]=Number(row.total)||0;
  const dueBase=" FROM leads WHERE follow_up_at <> '' AND "+
    "status NOT IN ('won','lost','archived') AND ";
  const overdue=await db.prepare(
    "SELECT COUNT(*) AS total"+dueBase+
    "follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  ).first();
  const upcoming=await db.prepare(
    "SELECT COUNT(*) AS total"+dueBase+
    "follow_up_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') "+
    "AND follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')"
  ).first();
  const unassignedNew=await db.prepare(
    "SELECT COUNT(*) AS total FROM leads WHERE status = 'new' AND assigned_to = ''"
  ).first();
  const staleNew=await db.prepare(
    "SELECT COUNT(*) AS total FROM leads WHERE status = 'new' AND created_at < datetime('now','-24 hours')"
  ).first();
  return json({
    statuses:totals,total:Object.values(totals).reduce((a,b)=>a+b,0),
    overdue:Number(overdue?.total)||0,upcoming7Days:Number(upcoming?.total)||0,
    unassignedNew:Number(unassignedNew?.total)||0,staleNew:Number(staleNew?.total)||0
  });
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
    "UPDATE leads SET status = ?, updated_at = datetime('now'), revision = revision + 1 WHERE id = ? AND status = ?"
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


function allowlistedStaff(email,env){
  if(!email)return true;
  const all=[env.CRM_ADMIN_EMAILS,env.CRM_VIEWER_EMAILS]
    .flatMap(value=>String(value||"").split(","))
    .map(e=>e.trim().toLowerCase());
  return all.includes(email);
}
function validDueDate(value){
  if(value==="")return true;
  if(typeof value!=="string"||!/^20\d\d-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.000Z$/.test(value))
    return false;
  const date=new Date(value);
  return Number.isFinite(date.valueOf())&&date.toISOString()===value;
}
async function followUpHistory(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const lead=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!lead)return fail("lead_not_found",404);
  const rows=await db.prepare(
    "SELECT id,actor_email,previous_assignee,new_assignee,previous_due,new_due,created_at "+
    "FROM lead_followup_audit WHERE lead_id = ? ORDER BY created_at DESC,id DESC LIMIT 100"
  ).bind(id).all();
  return json({events:(rows.results||[]).map(r=>({
    id:r.id,actor:r.actor_email,fromAssignee:r.previous_assignee,
    toAssignee:r.new_assignee,fromDue:r.previous_due,toDue:r.new_due,
    createdAt:r.created_at
  }))});
}
async function changeFollowUp(request,url,id,env,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  if(badPath(id))return fail("invalid_id",422);
  const origin=request.headers.get("origin");
  if(origin&&origin!==url.origin)return fail("origin_not_allowed",403);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
    return fail("invalid_content_type",415);
  const length=Number(request.headers.get("content-length"));
  if(Number.isFinite(length)&&length>768)return fail("invalid_body",413);
  let body;
  try{
    const content=await request.text();
    if(new TextEncoder().encode(content).length>768)return fail("invalid_body",413);
    body=JSON.parse(content);
  }catch{return fail("invalid_json",400)}
  if(!body||typeof body!=="object"||Array.isArray(body))return fail("invalid_fields",422);
  const assignedTo=typeof body.assignedTo==="string"?body.assignedTo.trim().toLowerCase():null;
  const followUpAt=body.followUpAt;
  const revision=body.revision;
  if(assignedTo===null||assignedTo.length>150||
     (assignedTo!==""&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignedTo))||
     !allowlistedStaff(assignedTo,env)||!validDueDate(followUpAt)||
     !Number.isSafeInteger(revision)||revision<0)
    return fail("invalid_fields",422);
  const old=await env.DB.prepare(
    "SELECT assigned_to,follow_up_at,revision FROM leads WHERE id = ?"
  ).bind(id).first();
  if(!old)return fail("lead_not_found",404);
  if(old.revision!==revision)return fail("revision_conflict",409);
  if((old.assigned_to||"")===assignedTo&&(old.follow_up_at||"")===followUpAt)
    return fail("no_change",422);
  const update=env.DB.prepare(
    "UPDATE leads SET assigned_to = ?, follow_up_at = ?, revision = revision + 1, "+
    "updated_at = datetime('now') WHERE id = ? AND revision = ?"
  ).bind(assignedTo,followUpAt,id,revision);
  const audit=env.DB.prepare(
    "INSERT INTO lead_followup_audit "+
    "(id,lead_id,actor_email,previous_assignee,new_assignee,previous_due,new_due) "+
    "SELECT ?,id,?,?,?,?,? FROM leads WHERE id = ? AND revision = ? AND changes() = 1"
  ).bind(crypto.randomUUID(),actor.email,old.assigned_to||"",assignedTo,
    old.follow_up_at||"",followUpAt,id,revision+1);
  const results=await env.DB.batch([update,audit]);
  if(results?.[0]?.meta?.changes!==1)return fail("revision_conflict",409);
  if(results?.[1]?.meta?.changes!==1)return fail("audit_unavailable",503);
  return json({updated:true,id,assignedTo,followUpAt,revision:revision+1});
}

async function followUpCompletions(id,db){
  if(badPath(id))return fail("invalid_id",422);
  const lead=await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if(!lead)return fail("lead_not_found",404);
  const rows=await db.prepare(
    "SELECT id,actor_email,due_at,completed_at FROM lead_followup_completions "+
    "WHERE lead_id = ? ORDER BY completed_at DESC,id DESC LIMIT 100"
  ).bind(id).all();
  return json({events:(rows.results||[]).map(r=>({
    id:r.id,actor:r.actor_email,dueAt:r.due_at,completedAt:r.completed_at
  }))});
}
async function completeFollowUp(request,url,id,env,actor){
  if(actor.role!=="admin")return fail("permission_denied",403);
  if(badPath(id))return fail("invalid_id",422);
  const origin=request.headers.get("origin");
  if(origin&&origin!==url.origin)return fail("origin_not_allowed",403);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
    return fail("invalid_content_type",415);
  const length=Number(request.headers.get("content-length"));
  if(Number.isFinite(length)&&length>256)return fail("invalid_body",413);
  let payload;
  try{
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>256)return fail("invalid_body",413);
    payload=JSON.parse(raw);
  }catch{return fail("invalid_json",400)}
  if(!payload||typeof payload!=="object"||Array.isArray(payload)||
     !Number.isSafeInteger(payload.revision)||payload.revision<0)
    return fail("invalid_fields",422);
  const old=await env.DB.prepare(
    "SELECT follow_up_at,revision,status FROM leads WHERE id = ?"
  ).bind(id).first();
  if(!old)return fail("lead_not_found",404);
  if(old.revision!==payload.revision)return fail("revision_conflict",409);
  if(!old.follow_up_at)return fail("no_scheduled_followup",422);
  if(["won","lost","archived"].includes(old.status))
    return fail("closed_lead",422);
  const update=env.DB.prepare(
    "UPDATE leads SET follow_up_at = '', revision = revision + 1, "+
    "updated_at = datetime('now') WHERE id = ? AND revision = ? AND "+
    "follow_up_at = ? AND status NOT IN ('won','lost','archived')"
  ).bind(id,payload.revision,old.follow_up_at);
  const audit=env.DB.prepare(
    "INSERT INTO lead_followup_completions "+
    "(id,lead_id,actor_email,due_at) "+
    "SELECT ?,id,?,? FROM leads WHERE id = ? AND revision = ? AND changes() = 1"
  ).bind(crypto.randomUUID(),actor.email,old.follow_up_at,id,payload.revision+1);
  const results=await env.DB.batch([update,audit]);
  if(results?.[0]?.meta?.changes!==1)return fail("revision_conflict",409);
  if(results?.[1]?.meta?.changes!==1)return fail("audit_unavailable",503);
  return json({completed:true,id,revision:payload.revision+1});
}

/* No CORS on these routes. They are intended for a Cloudflare Access-protected
 * same-origin Worker admin UI, never the GitHub Pages public form.
 */
export async function handleAdminAPI(request,env,url){
  const auth=await authenticateAdmin(request,env);
  if(!auth.ok)return fail(auth.error,auth.status);
  const path=url.pathname;
  if(path==="/admin/api/me"&&request.method==="GET")return json({email:auth.email,role:auth.role});
  if(path==="/admin/api/system"&&request.method==="GET")return systemStatus(env,auth);
  if(!env.DB)return fail("admin_not_configured",503);
  const segments=path.split("/").filter(Boolean);
  try{

    if(path==="/admin/api/summary"&&request.method==="GET")return summary(env.DB);
    if(path==="/admin/api/leads"&&request.method==="GET")return listLeads(url,env.DB,auth);
    if(path==="/admin/api/leads/export.csv"&&request.method==="GET")return exportLeads(request,url,env,auth);
    if(path==="/admin/api/exports"&&request.method==="GET")return exportHistory(env.DB,auth);
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="timeline"){
      if(request.method==="GET")return leadTimeline(segments[3],env.DB);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="notes"){
      if(request.method==="GET")return leadNotes(segments[3],env.DB);
      if(request.method==="POST")return addLeadNote(request,url,segments[3],env.DB,auth);
    }
    if(segments.length===4&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"){
      if(request.method==="GET")return leadDetail(segments[3],env.DB);
      if(request.method==="PATCH")return changeStatus(request,url,segments[3],env,auth);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="followup"){
      if(request.method==="PATCH")return changeFollowUp(request,url,segments[3],env,auth);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="followup-completions"){
      if(request.method==="GET")return followUpCompletions(segments[3],env.DB);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="complete-followup"){
      if(request.method==="POST")return completeFollowUp(request,url,segments[3],env,auth);
    }
    if(segments.length===5&&segments[0]==="admin"&&segments[1]==="api"&&segments[2]==="leads"&&segments[4]==="followup-history"){
      if(request.method==="GET")return followUpHistory(segments[3],env.DB);
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
