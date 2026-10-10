// Opaque, versioned cursor. A tie-breaker ID prevents losing same-timestamp rows.
export function encodeRecoveryCursor(row) {
 return Buffer.from(JSON.stringify({v:1,t:new Date(row.createdAt).toISOString(),id:row.id})).toString('base64url');
}
export function decodeRecoveryCursor(value) {
 if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid recovery cursor');
 let data;
 try {data=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw Error('Invalid recovery cursor');}
 if(data?.v!==1||typeof data.id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(data.id)||typeof data.t!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.t)||!Number.isFinite(Date.parse(data.t))||new Date(data.t).toISOString()!==data.t)throw Error('Invalid recovery cursor');
 return {createdAt:new Date(data.t),id:data.id};
}
