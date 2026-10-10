/** SMSMode REST SMS transport. Never store API keys or OTPs in source or logs. */
export async function sendSmsModeOtp(phone:string,code:string,options:{apiKey?:string,fetcher?:typeof fetch}={}){
 const key=options.apiKey??process.env.SMSMODE_API_KEY;
 if(!key)throw new Error('SMSMode credentials are not configured');
 if(!/^\+91[6-9]\d{9}$/.test(phone))throw new Error('Invalid Indian phone number');
 if(!/^\d{6}$/.test(code))throw new Error('Invalid OTP');
 const request=options.fetcher??fetch;
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await request('https://rest.smsmode.com/sms/v1/messages',{
   method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json','Accept':'application/json'},
   body:JSON.stringify({recipient:{to:phone.slice(1)},body:{text:`Your RideFlow verification code is ${code}. It expires in 5 minutes. Do not share this code.`}}),
   signal:controller.signal
  });
  if(!response.ok)throw new Error(`SMSMode delivery request failed (HTTP ${response.status})`);
  return true;
 }finally{clearTimeout(timeout);}
}
