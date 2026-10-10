'use client';
import {useEffect,useState} from 'react';
type Campaign={id:string;title:string;body:string;audience:string;category:string;scheduledAt:string|null;matchedDevices:number;successfulDevices:number;failedDevices:number;status:string;createdAt:string};
export default function Notifications({token}:{token:string}){
 const [audience,setAudience]=useState('CUSTOMER'),[title,setTitle]=useState(''),[body,setBody]=useState('');
 const [category,setCategory]=useState('GENERAL'),[scheduledAt,setScheduledAt]=useState('');
 const [sendKey,setSendKey]=useState(()=>crypto.randomUUID());
 const templates:Record<string,{title:string;body:string}>={
 GENERAL:{title:'RideFlow announcement',body:'You have a new update from RideFlow.'},
 RIDE:{title:'RideFlow trip update',body:'Check your Trips for the latest ride status.'},
 OFFER:{title:'New RideFlow offer',body:'Open RideFlow to see the latest offers and eligibility.'},
 PAYMENT:{title:'RideFlow payment information',body:'Check your payment history in RideFlow for the latest details.'},
 SAFETY:{title:'RideFlow safety notice',body:'Please review the latest safety information in RideFlow.'},
 SERVICE:{title:'RideFlow service update',body:'Service information is available in the RideFlow app.'}
 };
 const [account,setAccount]=useState(''),[preview,setPreview]=useState<number|null>(null),[history,setHistory]=useState<Campaign[]>([]);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [diagnostics,setDiagnostics]=useState<{counts:{status:string;_count:{_all:number}}[];recent:{id:string;category:string;status:string;attempts:number;lastError:string|null;createdAt:string}[]}|null>(null);
 async function loadDiagnostics(){try{setDiagnostics(await call('delivery-diagnostics'))}catch(e:any){setMessage(e.message)}}
 const payload={audience,category,title:title.trim(),body:body.trim(),idempotencyKey:sendKey,...(scheduledAt?{scheduledAt:new Date(scheduledAt).toISOString()}:{}),...(account.trim()?{targetAccountId:account.trim()}:{})};
 const valid=title.trim().length>=3&&title.trim().length<=80&&body.trim().length>=5&&body.trim().length<=400&&(!scheduledAt||!Number.isNaN(new Date(scheduledAt).getTime()));
 async function call(path:string,method='GET',data?:object){
  const r=await fetch('/api/admin/push/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),cache:'no-store'});
  const result=await r.json();if(!r.ok)throw Error(Array.isArray(result.message)?result.message.join(', '):result.message||'Request failed');return result;
 }
 async function reload(){try{setHistory(await call('history'))}catch(e:any){setMessage(e.message)}}
 useEffect(()=>{reload();loadDiagnostics()},[token]);
 async function inspect(){setBusy(true);setMessage('');try{const r=await call('preview','POST',payload);setPreview(r.matchedDevices)}catch(e:any){setMessage(e.message)}finally{setBusy(false)}}
 async function send(){
  if(!valid||preview===null||preview<1||preview>500)return;
  if(!window.confirm(`${scheduledAt?'Schedule':'Send'} this ${category.toLowerCase()} notification for ${preview} opted-in ${audience.toLowerCase()} device(s)?`))return;
  setBusy(true);setMessage('');
  try{const r=await call('send','POST',payload);setMessage(`Campaign ${r.status}: ${r.successfulDevices} FCM accepted, ${r.failedDevices} failed. Delivery to devices is not guaranteed.`);setSendKey(crypto.randomUUID());setPreview(null);await reload()}
  catch(e:any){setMessage(e.message)}finally{setBusy(false)}
 }
 return <section className="panel" style={{padding:24,maxWidth:900}}>
  <h2>Custom push notifications</h2><p>Admin-only · send to opted-in customer or driver devices. No GPS data is included.</p>
  <div style={{display:'grid',gap:12,maxWidth:580}}>
   <label>Audience<select value={audience} onChange={e=>{setAudience(e.target.value);setPreview(null)}}><option value="CUSTOMER">Customers</option><option value="DRIVER">Drivers</option></select></label>
   <label>Notification category<select value={category} onChange={e=>{setCategory(e.target.value);setPreview(null)}}>{Object.keys(templates).map(x=><option key={x} value={x}>{x==='RIDE'?'Ride / trip status':x==='OFFER'?'Offers':x==='PAYMENT'?'Payments':x==='SAFETY'?'Safety':x==='SERVICE'?'Service updates':'General'}</option>)}</select></label>
   <button onClick={()=>{setTitle(templates[category].title);setBody(templates[category].body);setPreview(null)}}>Use {category.toLowerCase()} template</button>
   <label>Schedule send (optional)<input type="datetime-local" value={scheduledAt} onChange={e=>{setScheduledAt(e.target.value);setPreview(null)}}/></label>
   <label>Specific account ID (optional; blank means all opted-in devices in audience)<input value={account} maxLength={128} onChange={e=>{setAccount(e.target.value);setPreview(null)}} placeholder="Optional account ID"/></label>
   <label>Notification title (3–80 characters)<input value={title} maxLength={80} onChange={e=>{setTitle(e.target.value);setPreview(null)}}/></label>
   <label>Message (5–400 characters)<textarea rows={4} value={body} maxLength={400} onChange={e=>{setBody(e.target.value);setPreview(null)}}/></label>
   <button disabled={!valid||busy} onClick={inspect}>Preview recipient count</button>
   {preview!==null&&<p><b>{preview} eligible device(s).</b> Maximum 500 devices per send. Changes require a new preview.</p>}
   <button className="primary-button" disabled={!valid||busy||preview===null||preview<1||preview>500} onClick={send}>{busy?'Working…':scheduledAt?'Confirm and schedule push':'Confirm and send push'}</button>
   {message&&<p role="status">{message}</p>}
  </div>
  <h3 style={{marginTop:32}}>Push delivery diagnostics</h3>
  <p>Provider acceptance does not guarantee that a device displayed the notification.</p>
  <button onClick={loadDiagnostics}>Refresh delivery diagnostics</button>
  {diagnostics&&<><div style={{display:'flex',flexWrap:'wrap',gap:12,marginTop:12}}>{diagnostics.counts.map(x=><div key={x.status} style={{padding:12,border:'1px solid #ddd',borderRadius:8}}><strong>{x._count._all}</strong><div>{x.status}</div></div>)}</div>
   <div className="table-scroll"><table><thead><tr><th>Time</th><th>Category</th><th>Status</th><th>Attempts</th><th>Review reason</th></tr></thead><tbody>{diagnostics.recent.map(x=><tr key={x.id}><td>{new Date(x.createdAt).toLocaleString()}</td><td>{x.category}</td><td>{x.status}</td><td>{x.attempts}</td><td>{x.lastError||'—'}</td></tr>)}</tbody></table></div></>}
  <h3 style={{marginTop:32}}>Recent campaign audit</h3>
  <div className="table-scroll"><table><thead><tr><th>Time</th><th>Audience</th><th>Category</th><th>Title</th><th>Scheduled</th><th>Accepted</th><th>Failed</th><th>Status</th></tr></thead><tbody>{history.map(x=><tr key={x.id}><td>{new Date(x.createdAt).toLocaleString()}</td><td>{x.audience}</td><td>{x.category}</td><td>{x.title}</td><td>{x.scheduledAt?new Date(x.scheduledAt).toLocaleString():'Immediate'}</td><td>{x.successfulDevices}/{x.matchedDevices}</td><td>{x.failedDevices}</td><td>{x.status}</td></tr>)}</tbody></table></div>
 </section>;
}
