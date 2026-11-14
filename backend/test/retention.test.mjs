import assert from "node:assert/strict";
import {test} from "node:test";
import worker from "../src/index.mjs";
import {purgeClosedLeads,retentionPolicy} from "../src/retention.mjs";

test("retention stays off without explicit approval or valid threshold",async()=>{
  let called=false;
  const db={prepare(){called=true;throw Error("unexpected D1 access")}};
  for(const env of [
    {},{DB:db},{DB:db,CRM_RETENTION_ENABLED:"true"},
    {DB:db,CRM_RETENTION_ENABLED:"true",CRM_RETENTION_DAYS:"1"},
    {DB:db,CRM_RETENTION_ENABLED:"false",CRM_RETENTION_DAYS:"365"},
    {DB:db,CRM_RETENTION_ENABLED:"true",CRM_RETENTION_DAYS:"3651"},
    {DB:db,CRM_RETENTION_ENABLED:"true",CRM_RETENTION_DAYS:"365;DROP TABLE leads"}
  ]){
    assert.equal(retentionPolicy(env).enabled,false);
    assert.deepEqual(await purgeClosedLeads(env),{skipped:true,deleted:0});
  }
  assert.equal(called,false);
});

test("retention selects only closed records and deletes selected IDs",async()=>{
  const calls=[];
  const db={
    prepare(sql){
      const call={sql,args:null};
      calls.push(call);
      return {
        bind(...args){call.args=args;return this},
        async all(){return {results:[{id:"old-lost"},{id:"old-archived"}]}},
        async run(){return {meta:{changes:2}}}
      };
    }
  };
  const r=await purgeClosedLeads({
    DB:db,CRM_RETENTION_ENABLED:"true",CRM_RETENTION_DAYS:"365"
  });
  assert.deepEqual(r,{skipped:false,deleted:2});
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/status IN \('lost','archived'\)/);
  assert.match(calls[0].sql,/LIMIT \?/);
  assert.deepEqual(calls[0].args,["-365 days",100]);
  assert.match(calls[1].sql,/DELETE FROM leads WHERE id IN \(\?,\?\)/);
  assert.deepEqual(calls[1].args,["old-lost","old-archived","-365 days"]);
});

test("empty retention result never issues deletion",async()=>{
  let count=0;
  const db={
    prepare(){count++;return {bind(){return this},async all(){return {results:[]}}}}
  };
  assert.deepEqual(await purgeClosedLeads({
    DB:db,CRM_RETENTION_ENABLED:"true",CRM_RETENTION_DAYS:"90"
  }),{skipped:false,deleted:0});
  assert.equal(count,1);
});

test("scheduled handler does nothing when retention is disabled",async()=>{
  let called=false;
  const ctx={waitUntil(promise){called=true;return promise}};
  await worker.scheduled({}, {},ctx);
  assert.equal(called,true);
});
