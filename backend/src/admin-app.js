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
   for(const key of Object.keys(statuses)){
     const card=node('div',undefined,'stat');
     card.append(node('strong',result.statuses?.[key]??0),node('span',statuses[key]));
     wrap.append(card);
   }
 }
 async function loadLeads(){
   const ticket=++sequence;
   message('جارٍ تحميل الطلبات...');
   const params=new URLSearchParams({offset:String(offset),limit:String(limit)});
   const status=$('status-filter').value,q=$('search').value.trim();
   if(status)params.set('status',status);
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
         fmt(lead.createdAt)
       ])tr.append(node('td',value));
       const cell=node('td');
       const btn=node('button','تفاصيل','btn secondary small');
       btn.type='button';
       btn.addEventListener('click',()=>openLead(lead.id));
       cell.append(btn);tr.append(cell);rows.append(tr);
     }
     if(!result.items?.length){
       const row=node('tr'),cell=node('td','لا توجد طلبات مطابقة للبحث.');
       cell.colSpan=7;row.append(cell);rows.append(row);
     }
     $('prev').disabled=offset===0;
     $('next').disabled=offset+limit>=total;
     $('page-label').textContent=total?('عرض '+(offset+1)+'–'+Math.min(total,offset+limit)+' من '+total):'لا توجد طلبات';
     message('تم تحديث قائمة الطلبات.');
   }catch(e){if(ticket===sequence)message(error(e),true)}
 }
 async function openLead(id){
   current=null;
   $('details').replaceChildren();
   $('audit').replaceChildren();
   $('detail-message').textContent='جارٍ تحميل التفاصيل...';
   $('status-section').classList.toggle('hidden',role!=='admin');
   $('detail').showModal();
   try{
     const [data,audit]=await Promise.all([api('/leads/'+encodeURIComponent(id)),api('/leads/'+encodeURIComponent(id)+'/audit')]);
     if(!$('detail').open)return;
     current=data.lead;
     $('detail-title').textContent='الطلب '+current.reference;
     const dl=$('details');dl.replaceChildren();
     for(const [label,value] of [
       ['المرجع',current.reference],['المنشأة',current.business],['المسؤول',current.name],
       ['البريد الإلكتروني',current.email],['الجوال',current.phone],
       ['النشاط',current.industry],['الباقة',plans[current.package]||current.package],
       ['الحل',current.solution],['الفروع',current.branches],
       ['نقاط البيع',current.pos],['الحالة',statuses[current.status]||current.status],
       ['تاريخ الطلب',fmt(current.createdAt)],['آخر تحديث',fmt(current.updatedAt)]
     ])addField(dl,label,value);
     addField(dl,'المتطلبات',current.notes,true);
     const choices=transitions[current.status]||[];
     const select=$('new-status');select.replaceChildren();
     for(const name of choices){
       const option=node('option',statuses[name]);option.value=name;select.append(option);
     }
     $('save-status').disabled=choices.length===0;
     const list=$('audit');list.replaceChildren();
     for(const event of audit.events||[]){
       list.append(node('li',fmt(event.createdAt)+' — '+event.actor+': '+(statuses[event.from]||event.from)+' ← '+(statuses[event.to]||event.to)));
     }
     if(!audit.events?.length)list.append(node('li','لا توجد تغييرات مسجّلة.'));
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
 async function init(){
   $('close-detail').addEventListener('click',()=>$('detail').close());
   $('detail').addEventListener('close',()=>{current=null});
   $('status-form').addEventListener('submit',saveStatus);
   $('filters').addEventListener('submit',e=>{e.preventDefault();offset=0;loadLeads()});
   $('refresh').addEventListener('click',()=>{loadSummary().catch(()=>{});loadLeads()});
   $('prev').addEventListener('click',()=>{offset=Math.max(0,offset-limit);loadLeads()});
   $('next').addEventListener('click',()=>{offset+=limit;loadLeads()});
   try{
     const me=await api('/me');
     role=me.role;
     $('identity').textContent=me.email+' · '+(role==='admin'?'مدير':'قراءة فقط');
     await Promise.all([loadSummary(),loadLeads()]);
   }catch(e){
     $('identity').textContent='غير متصل';
     message(error(e),true);
   }
 }
 document.addEventListener('DOMContentLoaded',init);
})();
