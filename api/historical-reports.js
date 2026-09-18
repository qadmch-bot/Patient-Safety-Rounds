import { sbGet, sbInsert, setCors, handleConfigError, logAudit } from "../lib/supabase.js";
import { uploadToStorage, getSignedUrl } from "../lib/storage.js";
const BUCKET="round-reports";
function safe(s){return String(s||"report.pdf").replace(/[^a-zA-Z0-9._-]/g,"_");}
export default async function handler(req,res){
  setCors(res); if(req.method==="OPTIONS") return res.status(200).end();
  try{
    if(req.method==="GET"){
      const rows=await sbGet("historical_round_reports","?order=report_date.desc,uploaded_at.desc");
      for(const r of rows) r.file_url=await getSignedUrl(r.storage_bucket||BUCKET,r.storage_path);
      return res.status(200).json({success:true,reports:rows});
    }
    if(req.method==="POST"){
      const b=req.body||{};
      if(!b.report_date||!b.title||!b.file_name||!b.file_base64) return res.status(400).json({success:false,error:"report_date, title and PDF file are required."});
      const path=`${b.report_date}/${Date.now()}-${safe(b.file_name)}`;
      await uploadToStorage(BUCKET,path,b.file_base64,b.file_type||"application/pdf");
      const row={round_id:b.round_id||null,report_date:b.report_date,departments:Array.isArray(b.departments)?b.departments:[],title:b.title,notes:b.notes||null,storage_bucket:BUCKET,storage_path:path,file_name:b.file_name,uploaded_by:b.uploaded_by||"Quality"};
      const inserted=await sbInsert("historical_round_reports",[row]);
      await logAudit({action:"Historical Round Report Uploaded",entity_type:"report",entity_id:inserted[0].id,actor:row.uploaded_by,new_value:{round_id:row.round_id,report_date:row.report_date,file_name:row.file_name}});
      inserted[0].file_url=await getSignedUrl(BUCKET,path);
      return res.status(200).json({success:true,report:inserted[0]});
    }
    return res.status(405).json({success:false,error:"Method not allowed"});
  }catch(error){if(handleConfigError(res,error))return;return res.status(500).json({success:false,error:error.message||"Internal server error"});}
}
