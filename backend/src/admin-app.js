'use strict';
/* TechStar CRM UI — same-origin Cloudflare Access; no customer data in localStorage. */
(()=> {
 const $=id=>document.getElementById(id);
 const statuses={new:'جديد',in_progress:'قيد المعالجة',quoted:'تم إرسال العرض',won:'مكتمل',lost:'مغلق دون اتفاق',archived:'مؤرشف'};
 const transitions={new:['in_progress','lost','archived'],in_progress:['quoted','won','lost','archived'],
   quoted:['in_progress','won','lost','archived'],won:['archived','in_progress'],
   lost:['in_progress','archived'],archived:['in_progress']};
 const plans={basic:'الأساسية',bronze:'البرونزية',silver:'الفضية',gold:'الذهبية',platinum:'البلاتينية',diamond:'الألماسية'};
 let role='viewer',offset=0,total=0,current=null,sequence=0;
 const limit=20;
 const node=(tag,text,className)=>{
   const el=document.createElement(tag);
   if(text!==undefined && text!==null)el.textContent=String(text);
   if(className)el.className=className;
   return el;
 };
 const error=(e)=>e?.message||'تعذّر تنفيذ الطلب، أعد المحاولة.';
 const message=(text,isError=false)=>{
   $('message').textContent=text;
   $('message').classList.toggle('error',isError);
 };
 async function api(path,options={}) {
   const response=await fetch('/admin/api'+path,{
     credentials:'same-origin',cache:'no-store',...options,
     headers:{'accept':'application/json',...(options.headers||{})}
   });
   let result;
   try{result=await response.json()}catch{throw Error('استجابة غير صالحة من الخادم')}
   if(!response.ok){
     if(response.status===401)throw Error('انتهت الجلسة أو يلزم تسجيل الدخول عبر Cloudflare Access');
     if(response.status===403)throw Error('ليس لديك صلاحية لتنفيذ هذا الإجراء');
     if(response.status===409)throw Error('تغيّرت حالة الطلب بواسطة موظف آخر. أعد فتح التفاصيل');
     throw Error('تعذّر الطلب ('+response.status+'): '+(result.error||''));
   }
   return result;
 }
 function addField(list,label,value,wide=false){
   const wrapper=node('div');
   if(wide)wrapper.className='wide';
   const term=node('dt',label),desc=node('dd',value===null||value===undefined||value===''?'—':value);
   wrapper.append(term,desc);list.append(wrapper);
 }
 function fmt(value){
   if(!value)return '—';
   const date=new Date(value.endsWith('Z')||value.includes('+')?value:value.replace(' ','T')+'Z');
   return Number.isFinite(date.valueOf())?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(date):String(value);
 }
 async function loadSummary(){
   const result=await api('/summary');
   const wrap=$('statistics');wrap.replaceChildren();
   for(const [value,label,filter] of [
     [result.overdue??0,'متابعات متأخرة','overdue'],
     [result.upcoming7Days??0,'متابعات خلال 7 أيام','upcoming7']
   ]){
     const card=node('button',undefined,'stat stat-action');
     card.type='button';
     card.setAttribute('aria-label',label+' — '+value+' — عرض الطلبات');
     card.append(node('strong',value),node('span',label+' · عرض الطلبات'));
     card.addEventListener('click',()=>{
       $('due-filter').value=filter;
       offset=0;
       loadLeads();
       $('filters').scrollIntoView({behavior:'smooth',block:'start'});
     });
     wrap.append(card);
   }
   for(const key of Object.keys(statuses)){
     const card=node('div',undefined,'stat');
     card.append(node('strong',result.statuses?.[key]??0),node('span',statuses[key]));
     wrap.append(card);
   }
 }
 async function loadSystemStatus(){
   if(role!=='admin')return;
   const result=await api('/system');
   const wrap=$('readiness-checks');wrap.replaceChildren();
   const labels={
     accessAuthenticated:'Cloudflare Access (الجلسة الحالية)',
     d1Binding:'ربط قاعدة D1',
     turnstileSecretPresent:'إعداد Turnstile',
     rateLimitBinding:'حد الطلبات',
     leadIngestionEnabled:'استقبال الطلبات العامة',
     retentionPolicyEnabled:'سياسة الاحتفاظ'
   };
   for(const [key,label] of Object.entries(labels)){
     const card=node('div',undefined,'stat');
     card.append(node('strong',result.checks?.[key]?'مهيأ':'غير مهيأ'));
     card.append(node('span',label));
     wrap.append(card);
   }
 }
 async function loadExportHistory(){
   if(role!=='admin')return;
   const result=await api('/exports');
   const wrap=$('export-audit-body');wrap.replaceChildren();
   for(const event of result.events||[]){
     const filters=event.filters||{};
     const description=[
       filters.status?('الحالة: '+(statuses[filters.status]||filters.status)):'',
       filters.due?('الموعد: '+filters.due):'',
       filters.assigned?('المسند: '+filters.assigned):'',
       filters.searched?'مع بحث':''
     ].filter(Boolean).join(' · ')||'دون مرشحات';
     const row=node('tr');
     for(const value of [event.actor,fmt(event.createdAt),event.count,description])
       row.append(node('td',value));
     wrap.append(row);
   }
   if(!result.events?.length){
     const row=node('tr'),cell=node('td','لا توجد عمليات تصدير مسجّلة.');
     cell.colSpan=4;row.append(cell);wrap.append(row);
   }
 }
 async function loadLeads(){
   const ticket=++sequence;
   message('جارٍ تحميل الطلبات...');
   const params=new URLSearchParams({offset:String(offset),limit:String(limit)});
   const status=$('status-filter').value,q=$('search').value.trim();
   const due=$('due-filter').value,assigned=$('assigned-filter').value;
   if(status)params.set('status',status);
   if(due)params.set('due',due);
   if(assigned)params.set('assigned',assigned);
   if(q)params.set('q',q);
   try{
     const result=await api('/leads?'+params.toString());
     if(ticket!==sequence)return;
     total=Number(result.total)||0;
     const rows=$('leads-body');rows.replaceChildren();
     for(const lead of result.items||[]){
       const tr=node('tr');
       for(const value of [
         lead.reference,lead.business,lead.name,
         plans[lead.package]||'غير محددة',statuses[lead.status]||lead.status,
         lead.assignedTo||'غير معين',fmt(lead.followUpAt),fmt(lead.createdAt)
       ])tr.append(node('td',value));
       const cell=node('td');
       const btn=node('button','تفاصيل','btn secondary small');
       btn.type='button';
       btn.addEventListener('click',()=>openLead(lead.id));
       cell.append(btn);tr.append(cell);rows.append(tr);
     }
     if(!result.items?.length){
       const row=node('tr'),cell=node('td','لا توجد طلبات مطابقة للبحث.');
       cell.colSpan=9;row.append(cell);rows.append(row);
     }
     $('prev').disabled=offset===0;
     $('next').disabled=offset+limit>=total;
     $('page-label').textContent=total?('عرض '+(offset+1)+'–'+Math.min(total,offset+limit)+' من '+total):'لا توجد طلبات';
     message('تم تحديث قائمة الطلبات.');
   }catch(e){if(ticket===sequence)message(error(e),true)}
 }
 function renderNotes(notes){
   const list=$('note-list');list.replaceChildren();
   for(const entry of notes||[]){
     const item=node('li');
     item.append(node('strong',entry.actor+' · '+fmt(entry.createdAt)));
     item.append(node('p',entry.text,'note-text'));
     list.append(item);
   }
   if(!notes?.length)list.append(node('li','لا توجد ملاحظات متابعة بعد.'));
 }
 async function saveNote(event){
   event.preventDefault();
   if(!current||role!=='admin')return;
   const text=$('note-text').value.trim();
   if(!text||text.length>1500){
     $('detail-message').textContent='أدخل ملاحظة من 1 إلى 1500 حرف';return;
   }
   const targetId=current.id,button=$('save-note');
   button.disabled=true;
   $('detail-message').textContent='جارٍ حفظ الملاحظة...';
   try{
     await api('/leads/'+encodeURIComponent(targetId)+'/notes',{
       method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({text})
     });
     $('note-text').value='';
     const updated=await api('/leads/'+encodeURIComponent(targetId)+'/notes');
     if($('detail').open&&current?.id===targetId){
       renderNotes(updated.notes);
       $('detail-message').textContent='تم حفظ الملاحظة في سجل الطلب.';
     }
   }catch(e){$('detail-message').textContent=error(e)}
   finally{button.disabled=false}
 }
 function renderTimeline(events){
   const list=$('activity-timeline');list.replaceChildren();
   for(const event of events||[]){
     const details=event.details||{};
     const item=node('li');
     const header=node('strong',event.actor+' · '+fmt(event.createdAt));
     const desc=event.kind==='status'?
       'تغيير الحالة: '+(statuses[details.from]||details.from)+' ← '+(statuses[details.to]||details.to):
       event.kind==='assignment'?
       'تغيير المتابعة: '+(details.fromAssignee||'غير معين')+' ← '+(details.toAssignee||'غير معين')+
       '، الموعد: '+fmt(details.fromDue)+' ← '+fmt(details.toDue):
       event.kind==='completion'?'إنجاز متابعة مقررة: '+fmt(details.dueAt):
       event.kind==='note'?'ملاحظة متابعة: '+String(details.text||''):'حدث إداري';
     item.append(header,node('p',desc,'note-text'));list.append(item);
   }
   if(!events?.length)list.append(node('li','لا يوجد نشاط مسجّل بعد.'));
 }
 async function openLead(id){
   current=null;
   $('details').replaceChildren();
   $('audit').replaceChildren();
   $('followup-audit').replaceChildren();
   $('followup-completions').replaceChildren();
   $('activity-timeline').replaceChildren();
   $('note-list').replaceChildren();
   $('note-text').value='';
   $('detail-message').textContent='جارٍ تحميل التفاصيل...';
   $('status-section').classList.toggle('hidden',role!=='admin');
   $('followup-section').classList.toggle('hidden',role!=='admin');
   $('note-form').classList.toggle('hidden',role!=='admin');
   $('detail').showModal();
   try{
     const [data,audit,followupAudit,notes,completions,timeline]=await Promise.all([
       api('/leads/'+encodeURIComponent(id)),
       api('/leads/'+encodeURIComponent(id)+'/audit'),
       api('/leads/'+encodeURIComponent(id)+'/followup-history'),
       api('/leads/'+encodeURIComponent(id)+'/notes'),
       api('/leads/'+encodeURIComponent(id)+'/followup-completions'),
       api('/leads/'+encodeURIComponent(id)+'/timeline')
     ]);
     if(!$('detail').open)return;
     current=data.lead;
     renderNotes(notes.notes);
     renderTimeline(timeline.events);
     $('detail-title').textContent='الطلب '+current.reference;
     const dl=$('details');dl.replaceChildren();
     for(const [label,value] of [
       ['المرجع',current.reference],['المنشأة',current.business],['المسؤول',current.name],
       ['البريد الإلكتروني',current.email],['الجوال',current.phone],
       ['النشاط',current.industry],['الباقة',plans[current.package]||current.package],
       ['الحل',current.solution],['الفروع',current.branches],
       ['نقاط البيع',current.pos],['الحالة',statuses[current.status]||current.status],
       ['المسؤول عن المتابعة',current.assignedTo||'غير معين'],
       ['موعد المتابعة',fmt(current.followUpAt)],
       ['تاريخ الطلب',fmt(current.createdAt)],['آخر تحديث',fmt(current.updatedAt)]
     ])addField(dl,label,value);
     addField(dl,'المتطلبات',current.notes,true);
     const choices=transitions[current.status]||[];
     const select=$('new-status');select.replaceChildren();
     for(const name of choices){
       const option=node('option',statuses[name]);option.value=name;select.append(option);
     }
     $('save-status').disabled=choices.length===0;
     $('assignee').value=current.assignedTo||'';
     const due=current.followUpAt?new Date(current.followUpAt):null;
     $('followup-time').value=due&&Number.isFinite(due.valueOf())
       ?new Date(due.getTime()-due.getTimezoneOffset()*60000).toISOString().slice(0,16):'';
     $('save-followup').disabled=role!=='admin';
     $('complete-followup').disabled=role!=='admin'||!current.followUpAt||['won','lost','archived'].includes(current.status);
     const list=$('audit');list.replaceChildren();
     for(const event of audit.events||[]){
       list.append(node('li',fmt(event.createdAt)+' — '+event.actor+': '+(statuses[event.from]||event.from)+' ← '+(statuses[event.to]||event.to)));
     }
     if(!audit.events?.length)list.append(node('li','لا توجد تغييرات مسجّلة.'));
     const history=$('followup-audit');history.replaceChildren();
     for(const event of followupAudit.events||[]){
       history.append(node('li',
         fmt(event.createdAt)+' — '+event.actor+' — '+(event.fromAssignee||'غير معين')+
         ' ← '+(event.toAssignee||'غير معين')+' · '+fmt(event.fromDue)+' ← '+fmt(event.toDue)));
     }
     if(!followupAudit.events?.length)history.append(node('li','لا يوجد سجل تعيينات بعد.'));
     const completedList=$('followup-completions');completedList.replaceChildren();
     for(const event of completions.events||[]){
       completedList.append(node('li',fmt(event.completedAt)+' — '+event.actor+
         ' — موعد المتابعة السابق: '+fmt(event.dueAt)));
     }
     if(!completions.events?.length)completedList.append(node('li','لم تُنجز متابعات بعد.'));
     $('detail-message').textContent='';
   }catch(e){$('detail-message').textContent=error(e)}
 }
 async function saveStatus(event){
   event.preventDefault();
   if(!current||role!=='admin')return;
   const status=$('new-status').value;
   if(!status)return;
   const button=$('save-status');button.disabled=true;
   $('detail-message').textContent='جارٍ حفظ التعديل...';
   try{
     await api('/leads/'+encodeURIComponent(current.id),{
       method:'PATCH',
       headers:{'content-type':'application/json'},
       body:JSON.stringify({previousStatus:current.status,status})
     });
     $('detail').close();
     current=null;
     await Promise.all([loadSummary(),loadLeads()]);
     message('تم تحديث حالة الطلب وتسجيل التغيير.');
   }catch(e){
     $('detail-message').textContent=error(e);
   }finally{button.disabled=false}
 }
 async function completeFollowup(){
   if(role!=='admin'||!current?.followUpAt)return;
   if(!window.confirm('تأكيد إنجاز المتابعة الحالية؟ سيُسجّل الموظف والتوقيت ويزال الموعد من قائمة المتابعات المفتوحة.'))return;
   const targetId=current.id,revision=current.revision;
   const button=$('complete-followup');button.disabled=true;
   $('detail-message').textContent='جارٍ تسجيل إنجاز المتابعة...';
   try{
     await api('/leads/'+encodeURIComponent(targetId)+'/complete-followup',{
       method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({revision})
     });
     $('detail').close();current=null;
     await Promise.all([loadSummary(),loadLeads()]);
     message('تم تسجيل إنجاز المتابعة وإزالة موعدها من المهام المفتوحة.');
   }catch(e){$('detail-message').textContent=error(e)}
   finally{button.disabled=false}
 }
 async function saveFollowup(event){
   event.preventDefault();
   if(!current||role!=='admin')return;
   if(!$('assignee').reportValidity()||!$('followup-time').reportValidity())return;
   const assignedTo=$('assignee').value.trim().toLowerCase();
   const input=$('followup-time').value;
   const due=input?new Date(input):null;
   if(due&&!Number.isFinite(due.valueOf())){
     $('detail-message').textContent='موعد المتابعة غير صالح';return;
   }
   const followUpAt=due?due.toISOString():'';
   const button=$('save-followup');button.disabled=true;
   $('detail-message').textContent='جارٍ حفظ المتابعة...';
   try{
     await api('/leads/'+encodeURIComponent(current.id)+'/followup',{
       method:'PATCH',headers:{'content-type':'application/json'},
       body:JSON.stringify({assignedTo,followUpAt,revision:current.revision})
     });
     $('detail').close();
     current=null;
     await loadLeads();
     message('تم تحديث مسؤول المتابعة وموعدها وتسجيل التغيير.');
   }catch(e){$('detail-message').textContent=error(e)}
   finally{button.disabled=false}
 }
 async function downloadCSV(){
   if(role!=='admin')return;
   if(!window.confirm('تنزيل بيانات العملاء إجراء مسجّل في سجل التدقيق. هل تريد المتابعة؟'))return;
   const button=$('export-csv');button.disabled=true;
   message('جارٍ تجهيز ملف CSV...');
   try{
     const params=new URLSearchParams();
     const status=$('status-filter').value,q=$('search').value.trim();
     const due=$('due-filter').value,assigned=$('assigned-filter').value;
     if(status)params.set('status',status);
     if(q)params.set('q',q);
     if(due)params.set('due',due);
     if(assigned)params.set('assigned',assigned);
     const response=await fetch('/admin/api/leads/export.csv?'+params.toString(),{
       credentials:'same-origin',cache:'no-store',headers:{'accept':'text/csv'}
     });
     if(!response.ok){
       if(response.status===413)throw Error('تجاوزت النتائج حد 500 طلب؛ استخدم المرشحات لتقليلها.');
       if(response.status===403)throw Error('لا تملك صلاحية تصدير بيانات العملاء.');
       throw Error('تعذر تصدير البيانات ('+response.status+').');
     }
     const blob=await response.blob();
     const url=URL.createObjectURL(blob);
     const link=document.createElement('a');
     link.href=url;link.download='techstar-crm-leads.csv';
     document.body.append(link);link.click();link.remove();
     setTimeout(()=>URL.revokeObjectURL(url),1000);
     message('تم إعداد ملف CSV وتسجيل عملية التصدير.');
     loadExportHistory().catch(()=>{});
   }catch(e){message(error(e),true)}
   finally{button.disabled=false}
 }
 async function init(){
   $('close-detail').addEventListener('click',()=>$('detail').close());
   $('detail').addEventListener('close',()=>{current=null});
   $('status-form').addEventListener('submit',saveStatus);
   $('followup-form').addEventListener('submit',saveFollowup);
   $('complete-followup').addEventListener('click',completeFollowup);
   $('note-form').addEventListener('submit',saveNote);
   $('filters').addEventListener('submit',e=>{e.preventDefault();offset=0;loadLeads()});
   $('refresh').addEventListener('click',()=>{loadSummary().catch(()=>{});loadLeads();loadExportHistory().catch(()=>{});loadSystemStatus().catch(()=>{});});
   $('export-csv').addEventListener('click',downloadCSV);
   $('prev').addEventListener('click',()=>{offset=Math.max(0,offset-limit);loadLeads()});
   $('next').addEventListener('click',()=>{offset+=limit;loadLeads()});
   try{
     const me=await api('/me');
     role=me.role;
     $('export-csv').classList.toggle('hidden',role!=='admin');
     $('export-audit-panel').classList.toggle('hidden',role!=='admin');
     $('readiness-panel').classList.toggle('hidden',role!=='admin');
     $('identity').textContent=me.email+' · '+(role==='admin'?'مدير':'قراءة فقط');
     await Promise.allSettled([loadSummary(),loadLeads(),loadExportHistory(),loadSystemStatus()]);
   }catch(e){
     $('identity').textContent='غير متصل';
     message(error(e),true);
   }
 }
 document.addEventListener('DOMContentLoaded',init);
})();
