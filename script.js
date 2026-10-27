'use strict';
// SmartMed7 Web App — history is recorded from ESP32 BLE outcomes, not assumed from UI clicks.
const SERVICE_UUID='19b10000-e8f2-537e-4f6c-d104768a1214';
const EVENT_UUID='19b10001-e8f2-537e-4f6c-d104768a1214';
const COMMAND_UUID='19b10002-e8f2-537e-4f6c-d104768a1214';
// Optional Apps Script endpoint. Leave blank if you only need local history.
const GOOGLE_SCRIPT_URL='';
const MEALS=[{key:'morning',name:'เช้า',timeId:'morningTime',doseId:'morningDose',ble:'BREAKFAST'}, {key:'noon',name:'กลางวัน',timeId:'noonTime',doseId:'noonDose',ble:'LUNCH'}, {key:'evening',name:'เย็น',timeId:'eveningTime',doseId:'eveningDose',ble:'DINNER'}];
const $=id=>document.getElementById(id);
let device=null,commandCharacteristic=null,eventCharacteristic=null,activeMedication=null;
let profile={fullName:'',birthDate:'',age:'',gender:'',disease:'',medicine:''};
let schedule={morning:'',noon:'',evening:'',morningDose:1,noonDose:1,eveningDose:1};
let history=[];
let lastSentRisk='';
// Only an alarm confirmed by ESP32 may trigger a local missed-dose timeout.
let confirmedAlarmKey=null;
let riskWritePending=false;
const STORAGE={profile:'smartmed7_profile',schedule:'smartmed7_schedule',history:'smartmed7_history'};
function safeLoad(key,fallback){try{const x=localStorage.getItem(key);return x?JSON.parse(x):fallback;}catch{return fallback;}}
function persist(){localStorage.setItem(STORAGE.history,JSON.stringify(history));}
function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function atTime(base,text){if(!/^\d{2}:\d{2}$/.test(text||''))return null;const d=new Date(base);const [h,m]=text.split(':').map(Number);d.setHours(h,m,0,0);return d;}
function fmtTime(d){return d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',hour12:false});}
function fmtDate(d){return d.toLocaleDateString('th-TH',{day:'2-digit',month:'2-digit',year:'numeric'});}
function escapeHtml(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function alertText(msg,important=false){$('alertBox').textContent=msg;$('alertBox').classList.toggle('important',important);}
function getMeal(key){return MEALS.find(x=>x.key===key);}
function getDose(key){return Number(schedule[key+'Dose'])||1;}
function isConnected(){return Boolean(device?.gatt?.connected&&commandCharacteristic);}
function getWindowRecords(){const now=new Date(),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-6);return history.filter(r=>{const d=new Date(r.scheduledDateTime);return Number.isFinite(d.getTime())&&d>=start&&d<=now;}).sort((a,b)=>new Date(b.scheduledDateTime)-new Date(a.scheduledDateTime));}
function getAllRecords(){return [...history].sort((a,b)=>new Date(b.scheduledDateTime)-new Date(a.scheduledDateTime));}
function scheduledSlotsInWindow(){const now=new Date(),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-6);let count=0;for(let day=new Date(start);day<=now;day.setDate(day.getDate()+1)){for(const meal of MEALS){const due=atTime(day,schedule[meal.key]);if(due&&due<=now)count++;}}return count;}
function getMetrics(){const records=getWindowRecords();const onTime=records.filter(r=>r.status==='รับยาตรงเวลา').length;const late=records.filter(r=>r.status==='รับยาล่าช้า').length;const missed=records.filter(r=>r.status==='ไม่รับยา').length;const n=records.length;const adherence=n?100*(onTime+0.5*late)/n:null;const risk=adherence===null?null:100-adherence;const level=adherence===null?'UNKNOWN':adherence>=95?'LOW':adherence>=80?'MEDIUM':'HIGH';return {records,n,onTime,late,missed,adherence,risk,level};}
function updateStatistics(){const m=getMetrics();$('onTime').textContent=m.onTime;$('late').textContent=m.late;$('missed').textContent=m.missed;$('recordCount').textContent=`(${m.n}/${scheduledSlotsInWindow()} มื้อที่ถึงกำหนด)`;$('adherence').textContent=m.adherence===null?'--%':m.adherence.toFixed(1)+'%';$('riskPercent').textContent=m.risk===null?'--%':m.risk.toFixed(1)+'%';const el=$('risk');el.className='risk '+m.level.toLowerCase();el.textContent=({LOW:'ความเสี่ยงต่ำ',MEDIUM:'ความเสี่ยงปานกลาง',HIGH:'ความเสี่ยงสูง',UNKNOWN:'รอข้อมูล'})[m.level];if(m.level!=='UNKNOWN'&&m.level!==lastSentRisk&&isConnected())void sendRisk(m.level);}
async function sendRisk(level){if(riskWritePending || !isConnected())return; riskWritePending=true; try{if(await sendCommand('RISK|'+level))lastSentRisk=level;}finally{riskWritePending=false;}}
function updateHistory(){const records=getAllRecords();const list=$('historyList');if(!records.length){list.innerHTML='<div class="empty">ยังไม่มีประวัติการรับยา</div>';return;}list.innerHTML=records.map(r=>{const cls=r.status==='รับยาตรงเวลา'?'on-time':r.status==='รับยาล่าช้า'?'late':'missed';return `<article class="history-item"><div class="history-main"><div class="history-date">${escapeHtml(r.date)} | กำหนด ${escapeHtml(r.scheduledTime)}</div><div class="history-name">${escapeHtml(r.fullName)} • มื้อ${escapeHtml(r.meal)}</div><div class="history-detail">${escapeHtml(r.medicine)} ${Number(r.dose)||1} เม็ด<br>รับจริง ${escapeHtml(r.actualTime)}</div></div><div><div class="history-status ${cls}">${escapeHtml(r.status)}</div><div class="history-score">คะแนน ${Number(r.score).toFixed(1)}</div></div></article>`;}).join('');}
function updateNext(){const now=new Date();if(activeMedication){$('nextLabel').textContent='กำลังรอรับประทาน';$('nextTime').textContent=activeMedication.time;$('nextMedicine').textContent=profile.medicine||'ไม่ระบุชื่อยา';$('nextDose').textContent=getDose(activeMedication.mealKey)+' เม็ด';}else{const candidates=MEALS.map(m=>{let due=atTime(now,schedule[m.key]);if(!due)return null;if(due<now)due.setDate(due.getDate()+1);return {m,due};}).filter(Boolean).sort((a,b)=>a.due-b.due);const next=candidates[0];$('nextLabel').textContent='มื้อถัดไป';$('nextTime').textContent=next?fmtTime(next.due):'--:--';$('nextMedicine').textContent=next?(profile.medicine||'ไม่ระบุชื่อยา'):'ยังไม่ได้ตั้งตารางยา';$('nextDose').textContent=next?getDose(next.m.key)+' เม็ด':'-- เม็ด';}$('takenButton').disabled=!activeMedication||!isConnected();}
function updateAll(){updateStatistics();updateHistory();updateNext();}
function saveMedicationRecord(mealKey,status,score,actualDate=new Date()){
 const m=getMeal(mealKey),time=schedule[mealKey];if(!m||!time)return;
 let due=atTime(actualDate,time);if(!due)return;
 // If event was scheduled yesterday and completed shortly after midnight, use yesterday.
 if(due.getTime()-actualDate.getTime()>12*3600000)due.setDate(due.getDate()-1);
 const key=dateKey(due)+'|'+mealKey;if(history.some(r=>r.key===key))return;
 const actual=status==='ไม่รับยา'?null:actualDate;
 const record={key,dateKey:dateKey(due),date:fmtDate(due),meal:m.name,scheduledTime:fmtTime(due),actualTime:actual?fmtTime(actual):'-',scheduledDateTime:due.toISOString(),actualDateTime:actual?actual.toISOString():null,fullName:profile.fullName||'ผู้ใช้งาน',medicine:profile.medicine||'ไม่ระบุ',dose:getDose(mealKey),status,score};
 history.unshift(record);history.sort((a,b)=>new Date(b.scheduledDateTime)-new Date(a.scheduledDateTime));
 // Preserve the complete local history. Only the home-page metrics use the 7-day window.
 persist();if(activeMedication?.mealKey===mealKey)activeMedication=null;
 if(confirmedAlarmKey===key)confirmedAlarmKey=null;
 updateAll();void uploadRecord(record);
}
async function uploadRecord(record){if(!GOOGLE_SCRIPT_URL)return;try{const response=await fetch(GOOGLE_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({testType:'medication',...record,adherence:getMetrics().adherence,riskPercent:getMetrics().risk,riskLevel:getMetrics().level})});if(!response.ok)throw Error('HTTP '+response.status);const result=await response.json();if(result.status!=='success'&&result.success!==true)throw Error(result.message||'Rejected');}catch(e){console.warn('Google Sheets upload failed',e);alertText('บันทึกในเครื่องแล้ว แต่ส่ง Google Sheets ไม่สำเร็จ',true);}}
function activateMedication(mealKey){const m=getMeal(mealKey);if(!m||!schedule[mealKey])return;const now=new Date(),due=atTime(now,schedule[mealKey]);if(history.some(r=>r.key===dateKey(due)+'|'+mealKey))return;activeMedication={mealKey,time:schedule[mealKey],start:due.getTime(),dateKey:dateKey(due)};
 confirmedAlarmKey=dateKey(due)+'|'+mealKey;updateNext();}
// Fallback only while BLE is connected and this browser witnessed the alarm.
// At >30 minutes, save MISSED once even if the BLE MISSED event was lost.
function checkConfirmedAlarmTimeout(){
 if(!isConnected()||!activeMedication||!confirmedAlarmKey)return;
 const due=atTime(new Date(activeMedication.start),schedule[activeMedication.mealKey]);
 if(!due||dateKey(due)+'|'+activeMedication.mealKey!==confirmedAlarmKey)return;
 if(Date.now()-due.getTime()>30*60*1000){
   saveMedicationRecord(activeMedication.mealKey,'ไม่รับยา',0,new Date());
   alertText('ครบ 30 นาที: บันทึกไม่รับยา (ตรวจสอบกับ ESP32)',true);
 }
}
function receiveBLE(event){const raw=new TextDecoder().decode(event.target.value).trim();for(const msg of raw.split(/\r?\n/).filter(Boolean)){console.log('ESP32 → WEB',msg);const [cmd,mealRaw]=msg.split('|');const meal=({BREAKFAST:'morning',MORNING:'morning',LUNCH:'noon',NOON:'noon',DINNER:'evening',EVENING:'evening'})[(mealRaw||'').toUpperCase()];if(cmd==='ALARM'){activateMedication(meal);alertText('ถึงเวลารับประทานยาแล้ว',true);}else if(cmd==='TAKEN_ON_TIME'||cmd==='TAKEN_LATE'||cmd==='MISSED'){const key=meal||activeMedication?.mealKey;if(!key){console.warn('Cannot identify meal for',msg);return;}const config={TAKEN_ON_TIME:['รับยาตรงเวลา',1],TAKEN_LATE:['รับยาล่าช้า',0.5],MISSED:['ไม่รับยา',0]}[cmd];saveMedicationRecord(key,...config);alertText('บันทึกผล: '+config[0]);}else if(cmd==='TIME_SAVED')alertText('บันทึกตารางยาไปยัง ESP32 แล้ว');else if(cmd==='NO_MEDICATION')alertText('ไม่มีมื้อยาที่กำลังรอรับ',true);}}
async function sendCommand(cmd){if(!isConnected()){alertText('กรุณาเชื่อมต่อ SmartMed7 ก่อน',true);return false;}try{await commandCharacteristic.writeValue(new TextEncoder().encode(cmd));console.log('WEB → ESP32',cmd);return true;}catch(e){console.error(e);alertText('ส่งคำสั่ง BLE ไม่สำเร็จ',true);return false;}}
async function connectBLE(){if(isConnected()){device.gatt.disconnect();return;}if(!navigator.bluetooth){alert('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth');return;}try{device=await navigator.bluetooth.requestDevice({filters:[{name:'SmartMed7'}],optionalServices:[SERVICE_UUID]});device.addEventListener('gattserverdisconnected',()=>{commandCharacteristic=null;eventCharacteristic=null;lastSentRisk='';confirmedAlarmKey=null;activeMedication=null;$('bleStatus').textContent='ยังไม่เชื่อมต่อ';$('bleStatus').className='status offline';alertText('การเชื่อมต่อ SmartMed7 ถูกยกเลิก',true);updateNext();});const server=await device.gatt.connect(),service=await server.getPrimaryService(SERVICE_UUID);eventCharacteristic=await service.getCharacteristic(EVENT_UUID);commandCharacteristic=await service.getCharacteristic(COMMAND_UUID);await eventCharacteristic.startNotifications();eventCharacteristic.addEventListener('characteristicvaluechanged',receiveBLE);$('bleStatus').textContent='เชื่อมต่อแล้ว';$('bleStatus').className='status online';alertText('เชื่อมต่อ SmartMed7 เรียบร้อยแล้ว');await sendCommand('GET_TIME');updateAll();}catch(e){console.error(e);alert('เชื่อมต่อ BLE ไม่สำเร็จ: '+e.message);}}
function init(){profile={...profile,...safeLoad(STORAGE.profile,{})};schedule={...schedule,...safeLoad(STORAGE.schedule,{})};history=safeLoad(STORAGE.history,[]);if(!Array.isArray(history))history=[];history=history.filter(r=>r&&r.key&&r.scheduledDateTime);history=[...new Map(history.map(r=>[r.key,r])).values()];persist();for(const key of ['fullName','birthDate','age','gender','disease','medicine'])$(key).value=profile[key]||'';for(const m of MEALS){$(m.timeId).value=schedule[m.key]||'';$(m.doseId).value=getDose(m.key);}$('userName').textContent=profile.fullName||'ผู้ใช้งาน';document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n===b));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===b.dataset.page));updateAll();}));$('bleStatus').addEventListener('click',connectBLE);$('saveProfile').addEventListener('click',()=>{for(const key of Object.keys(profile))profile[key]=$(key).value.trim();localStorage.setItem(STORAGE.profile,JSON.stringify(profile));$('userName').textContent=profile.fullName||'ผู้ใช้งาน';updateAll();alertText('บันทึกข้อมูลผู้ใช้งานแล้ว');});$('saveSchedule').addEventListener('click',async()=>{const next={};for(const m of MEALS){next[m.key]=$(m.timeId).value;next[m.key+'Dose']=Number($(m.doseId).value);if(!next[m.key]||!Number.isInteger(next[m.key+'Dose'])||next[m.key+'Dose']<1||next[m.key+'Dose']>99){alert('กรุณากำหนดเวลาและจำนวนยาให้ครบทั้ง 3 มื้อ (1–99 เม็ด)');return;}}if(!isConnected()){alert('กรุณาเชื่อมต่อ ESP32 ก่อนบันทึกตารางยา');return;}const sent=await sendCommand(`SET_TIME:${next.morning},${next.noon},${next.evening}`);if(!sent)return;schedule=next;localStorage.setItem(STORAGE.schedule,JSON.stringify(schedule));updateAll();alertText('ส่งตารางยาไปยัง ESP32 แล้ว รอการยืนยัน TIME_SAVED');});$('takenButton').addEventListener('click',async()=>{if(activeMedication)await sendCommand('TAKEN');});updateAll();setInterval(()=>{checkConfirmedAlarmTimeout();updateNext();updateStatistics();},1000);}
window.addEventListener('DOMContentLoaded',init);
