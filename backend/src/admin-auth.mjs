/* Cloudflare Access JWT authorization for TechStar CRM.
 * Every admin request requires a verified RS256 assertion AND an explicit
 * email allowlist role. Do not trust CF-Access-Authenticated-User-Email alone.
 */
const CERT_TTL_MS=5*60*1000;
const cache=new Map();
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function decodeSegment(value){
  if(typeof value!=="string"||!value||value.length>14000||!/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("malformed_token");
  const encoded=value.replace(/-/g,"+").replace(/_/g,"/");
  const padded=encoded+"=".repeat((4-encoded.length%4)%4);
  return Uint8Array.from(atob(padded),character=>character.charCodeAt(0));
}
function parseJSONSegment(value){
  const decoded=new TextDecoder("utf-8",{fatal:true}).decode(decodeSegment(value));
  return JSON.parse(decoded);
}
function parseIssuer(configured){
  if(typeof configured!=="string")return null;
  try{
    const url=new URL(configured);
    if(url.protocol!=="https:"||!url.hostname.endsWith(".cloudflareaccess.com")||
       url.hostname.length<25||url.pathname!=="/"||url.search||url.hash||
       url.username||url.password||url.port)return null;
    return url.origin;
  }catch{return null}
}
function emailList(value){
  return new Set(String(value||"").split(",").map(s=>s.trim().toLowerCase())
    .filter(s=>EMAIL.test(s)));
}
async function getKeys(issuer){
  const cached=cache.get(issuer);
  if(cached&&cached.expires>Date.now())return cached.keys;
  const response=await fetch(issuer+"/cdn-cgi/access/certs",{
    method:"GET",headers:{"accept":"application/json"},
    signal:AbortSignal.timeout(5000)
  });
  if(!response.ok)throw Error("unavailable_certs");
  const body=await response.json();
  if(!Array.isArray(body.keys)||body.keys.length===0||body.keys.length>30)
    throw Error("invalid_certs");
  const keys=body.keys.filter(k=>k&&k.kty==="RSA"&&
    typeof k.kid==="string"&&k.kid.length<=200&&k.n&&k.e&&
    (!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig"));
  if(keys.length===0)throw Error("invalid_certs");
  cache.set(issuer,{keys,expires:Date.now()+CERT_TTL_MS});
  return keys;
}
export async function authenticateAdmin(request,env={}){
  const issuer=parseIssuer(env.ACCESS_ISSUER);
  const audience=String(env.ACCESS_AUD||"").trim();
  const adminEmails=emailList(env.CRM_ADMIN_EMAILS);
  const viewerEmails=emailList(env.CRM_VIEWER_EMAILS);
  if(!issuer||!audience||audience.length>256||(adminEmails.size+viewerEmails.size)===0)
    return {ok:false,status:503,error:"admin_not_configured"};
  const assertion=request.headers.get("cf-access-jwt-assertion");
  if(!assertion||assertion.length>16000)return {ok:false,status:401,error:"authentication_required"};
  try{
    const parts=assertion.split(".");
    if(parts.length!==3)return {ok:false,status:401,error:"invalid_assertion"};
    const header=parseJSONSegment(parts[0]);
    const payload=parseJSONSegment(parts[1]);
    if(header?.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length>200||
       !payload||typeof payload!=="object")
      return {ok:false,status:401,error:"invalid_assertion"};
    const keys=await getKeys(issuer);
    const matching=keys.find(k=>k.kid===header.kid);
    if(!matching)return {ok:false,status:401,error:"invalid_assertion"};
    const key=await crypto.subtle.importKey("jwk",matching,
      {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    const isValid=await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",key,decodeSegment(parts[2]),
      new TextEncoder().encode(parts[0]+"."+parts[1])
    );
    if(!isValid)return {ok:false,status:401,error:"invalid_assertion"};
    const now=Math.floor(Date.now()/1000);
    const audiences=Array.isArray(payload.aud)?payload.aud:[payload.aud];
    if(payload.iss!==issuer||!audiences.includes(audience)||
       typeof payload.exp!=="number"||payload.exp<=now||
       (payload.nbf!=null&&(typeof payload.nbf!=="number"||payload.nbf>now+30))||
       (payload.iat!=null&&(typeof payload.iat!=="number"||payload.iat>now+30)))
      return {ok:false,status:401,error:"invalid_assertion"};
    const email=typeof payload.email==="string"?payload.email.trim().toLowerCase():"";
    if(!EMAIL.test(email))return {ok:false,status:403,error:"access_forbidden"};
    const role=adminEmails.has(email)?"admin":viewerEmails.has(email)?"viewer":null;
    return role?{ok:true,email,role}:{ok:false,status:403,error:"access_forbidden"};
  }catch{
    return {ok:false,status:401,error:"invalid_assertion"};
  }
}
export function adminConfigured(env={}){
  return !!parseIssuer(env.ACCESS_ISSUER)&&!!String(env.ACCESS_AUD||"").trim()&&
    (emailList(env.CRM_ADMIN_EMAILS).size+emailList(env.CRM_VIEWER_EMAILS).size)>0;
}
