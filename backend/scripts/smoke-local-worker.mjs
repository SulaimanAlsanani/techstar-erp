#!/usr/bin/env node
/* Run after npm install and local D1 migrations:
 * node scripts/smoke-local-worker.mjs
 * This test never deploys, never enables ingestion, and never uses real clients.
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";

const port=8791;
const base="http://127.0.0.1:"+port;
const webOrigin="https://sulaimanalsanani.github.io";
const logs=[];
const runner=spawn(process.platform==="win32"?"npx.cmd":"npx",[
  "--no-install","wrangler","dev","--local",
  "--config",".wrangler-staging.toml",
  "--ip","127.0.0.1","--port",String(port),
  "--persist-to",".wrangler/state"
],{
  cwd:new URL("..",import.meta.url),
  env:{...process.env,WRANGLER_SEND_METRICS:"false",CI:"true"},
  stdio:["ignore","pipe","pipe"],
  shell:false
});
let exited=false;
runner.on("exit",()=>{exited=true;});
for(const output of [runner.stdout,runner.stderr]){
  output.setEncoding("utf8");
  output.on("data",data=>{
    logs.push(data);
    if(logs.length>40)logs.shift();
  });
}
async function response(path,options={}){
  return fetch(base+path,{redirect:"manual",signal:AbortSignal.timeout(3000),...options});
}
function ensureStatus(resp,expected,step){
  assert.equal(resp.status,expected,step+": unexpected HTTP "+resp.status);
}
async function waitForReady(){
  const deadline=Date.now()+40000;
  while(Date.now()<deadline){
    if(exited)throw Error("Wrangler exited before startup");
    try{
      const r=await response("/health");
      if(r.ok)return r;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw Error("Wrangler local Worker did not respond before deadline");
}
try{
  const health=await waitForReady();
  const healthData=await health.json();
  assert.equal(healthData.ready,false,"Staging may not enable lead ingestion");
  assert.equal(healthData.status,"ok");
  const goodContent=await response("/api/content",{
    headers:{"origin":webOrigin}
  });
  ensureStatus(goodContent,200,"Allowed catalogue CORS request");
  assert.deepEqual(await goodContent.json(),{items:[]});
  assert.equal(goodContent.headers.get("access-control-allow-origin"),webOrigin);
  const wrongOrigin=await response("/api/content",{
    headers:{"origin":"https://attacker.example"}
  });
  ensureStatus(wrongOrigin,403,"Untrusted origin");
  const admin=await response("/admin/");
  ensureStatus(admin,503,"Admin without configured Access");
  const lead=await response("/api/leads",{
    method:"POST",
    headers:{"origin":webOrigin,"content-type":"application/json"},
    body:JSON.stringify({name:"TEST",business:"TEST",email:"test@example.test",phone:"0500000000"})
  });
  ensureStatus(lead,503,"Staging lead collection gate");
  assert.equal((await lead.json()).error,"lead_ingestion_disabled");
  const headers=await response("/api/content",{
    method:"OPTIONS",headers:{"origin":webOrigin,
      "access-control-request-method":"GET"}
  });
  ensureStatus(headers,204,"CORS preflight");
  assert.equal(headers.headers.get("access-control-allow-origin"),webOrigin);
  console.log("Cloudflare local Worker smoke passed: D1 config, health, CORS, admin lock and disabled ingestion.");
}catch(error){
  // Wrangler may log local config and routes. Only emit the last few lines of
  // development logs; never run this script with secrets populated.
  console.error(String(error));
  console.error("Wrangler tail:",logs.join("").split("\n").slice(-14).join("\n"));
  process.exitCode=1;
}finally{
  runner.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve=>runner.once("exit",resolve)),
    new Promise(resolve=>setTimeout(resolve,2500))
  ]);
  if(!exited)runner.kill("SIGKILL");
}
