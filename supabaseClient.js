import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Supabase URL or Service Key is missing. Check .env file.");
}

// Create a Supabase client with the SERVICE_ROLE_KEY
// This key bypasses all RLS policies.
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});