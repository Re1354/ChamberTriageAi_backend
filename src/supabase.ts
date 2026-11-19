import { createClient } from "@supabase/supabase-js";
import { env } from "./config";

/** service-role ক্লায়েন্ট — শুধু সার্ভারে। Auth admin ও Storage-এর জন্য। */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const storage = () => supabaseAdmin.storage.from(env.STORAGE_BUCKET);
