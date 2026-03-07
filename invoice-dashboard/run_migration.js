const { createClient } = require('@supabase/supabase-js');

const url = 'https://vpgtwlbrfkvxszdpeswh.supabase.co';
const key = process.env.SERVICE_KEY;
const supa = createClient(url, key);

async function run() {
  // Check if table already exists
  const { data, error } = await supa.from('van_published_schedules').select('van_id').limit(1);
  if (!error) {
    console.log('Table already exists! Data:', JSON.stringify(data));
    return;
  }
  console.log('Table does not exist yet:', error.message);
  console.log('');
  console.log('Please run the migration SQL in the Supabase Dashboard SQL Editor:');
  console.log('https://supabase.com/dashboard/project/vpgtwlbrfkvxszdpeswh/sql/new');
}
run();
