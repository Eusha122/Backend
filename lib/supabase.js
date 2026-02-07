import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Initialize Supabase client with service role key (for backend operations)
export const supabase = createClient(
    config.supabaseUrl,
    config.supabaseServiceKey
);
