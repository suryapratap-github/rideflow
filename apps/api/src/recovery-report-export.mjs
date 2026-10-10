/** CSV injection-safe recovery audit export. Deliberately excludes secrets and free-text reasons. */
export const recoveryColumns=['id','tipPaymentId','proposedProvider','proposedReference','status','proposedBy','reviewedBy','reviewedAt','createdAt'];
export function recoveryCsvCell(value){
 const raw=value instanceof Date?value.toISOString():value==null?'':String(value);
 const neutral=/^[\s\u0000-\u001f]*[=+@-]/.test(raw)?`'${raw}`:raw;
 return `"${neutral.replaceAll('"','""')}"`;
}
export function recoveryCsv(rows){return [recoveryColumns.join(','),...rows.map(row=>recoveryColumns.map(key=>recoveryCsvCell(row[key])).join(','))].join('\r\n')+'\r\n';}
