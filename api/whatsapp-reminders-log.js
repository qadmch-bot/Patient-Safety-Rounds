import { sbGet, setCors, handleConfigError } from "../lib/supabase.js";
export default async function handler(req,res){
  setCors(res); if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET") return res.status(405).json({success:false,error:"Method not allowed"});
  try{
    const [reminders, activity] = await Promise.all([
      sbGet("whatsapp_reminders","?order=created_at.desc&limit=500"),
      sbGet("secure_link_activity","?order=last_opened_at.desc&limit=500")
    ]);
    return res.status(200).json({success:true,reminders,activity});
  }catch(error){if(handleConfigError(res,error))return;return res.status(500).json({success:false,error:error.message||"Internal server error"});}
}
