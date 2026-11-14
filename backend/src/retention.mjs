/* Approved, opt-in CRM retention cleanup for Cloudflare D1.
 * No cron trigger is configured by default. This code never runs solely
 * because the Worker is deployed. Configure an explicit policy first.
 */
const MAX_BATCH=100;

export function retentionPolicy(env={}){
  const enabled=env.CRM_RETENTION_ENABLED==="true";
  const raw=String(env.CRM_RETENTION_DAYS||"");
  const days=/^[1-9][0-9]{1,3}$/.test(raw)?Number(raw):NaN;
  if(!enabled||!env.DB||!Number.isInteger(days)||days<30||days>3650)
    return {enabled:false,days:null};
  return {enabled:true,days};
}

/* Only closed/archived records are eligible. Open work is not deleted.
 * Audit records cascade with deleted leads under D1 foreign-key semantics.
 * The cron can process at most 100 leads per invocation to bound resource use.
 */
export async function purgeClosedLeads(env={}){
  const policy=retentionPolicy(env);
  if(!policy.enabled)return {skipped:true,deleted:0};
  const period="-"+policy.days+" days";
  const data=await env.DB.prepare(
    "SELECT id FROM leads WHERE status IN ('lost','archived') "+
    "AND created_at < datetime('now', ?) ORDER BY created_at ASC,id ASC LIMIT ?"
  ).bind(period,MAX_BATCH).all();
  const ids=(data.results||[]).map(r=>r.id).filter(id=>typeof id==="string");
  if(!ids.length)return {skipped:false,deleted:0};
  const placeholders=ids.map(()=>"?").join(",");
  const result=await env.DB.prepare(
    "DELETE FROM leads WHERE id IN ("+placeholders+") "+
    "AND status IN ('lost','archived') AND created_at < datetime('now', ?)"
  ).bind(...ids,period).run();
  return {skipped:false,deleted:Math.max(0,Number(result.meta?.changes)||0)};
}
