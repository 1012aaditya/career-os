import { createClient } from '@supabase/supabase-js';

import { secureSessionStorage } from './secure-session-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be configured',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    /*
     * The Keychain, not AsyncStorage.
     *
     * AsyncStorage is an unencrypted file in the app sandbox: fine for a
     * remembered filter, wrong for a credential that opens somebody's
     * resume and employment history, and readable from an unencrypted
     * device backup. See secure-session-storage.ts for why that module is
     * more than a one-line re-export - a Supabase session is larger than
     * a Keychain item, so it is chunked.
     *
     * The anon key above stays public by design: it is compiled into the
     * bundle, grants nothing on its own, and is what every Supabase client
     * is meant to ship with. The SESSION is the secret, and it is what
     * moved.
     */
    storage: secureSessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
