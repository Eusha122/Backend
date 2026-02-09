
import { supabase } from './lib/supabase.js';
import { config } from './lib/config.js'; // Fixed path
import { createClient } from '@supabase/supabase-js'; // Need this for anon client
import { v4 as uuidv4 } from 'uuid';

async function test() {
    console.log('Testing Supabase Connection & Logging...');

    const roomId = '5fafbeb2-0388-429a-adff-a507c4da693d'; // Use the ID from logs
    const deviceId = 'test-device-' + Date.now();

    // 1. Try Insert
    console.log('1. Inserting log...');
    const { data: insertData, error: insertError } = await supabase
        .from('access_logs')
        .insert({
            room_id: roomId,
            event_type: 'room_access_test',
            ip_address: '127.0.0.1',
            device_id: deviceId,
            city: 'Test City',
            country: 'TC'
        })
        .select();

    if (insertError) {
        console.error('INSERT FAILED:', insertError);
    } else {
        console.log('INSERT SUCCESS:', insertData);
    }

    // 2. Try Select
    console.log('2. Selecting log...');
    const { data: selectData, error: selectError } = await supabase
        .from('access_logs')
        .select('*')
        .eq('room_id', roomId)
        .eq('device_id', deviceId);

    if (selectError) {
        console.error('SELECT FAILED:', selectError);
    } else {
        console.log('SELECT RESULT:', selectData);
    }

    // 3. Mimic the exact query from room-access.js
    console.log('3. Running exact query from route...');
    const { data: routeLogs, error: routeError } = await supabase
        .from('access_logs')
        .select('event_type, device_id, created_at, browser, os, city, country')
        .eq('room_id', roomId)
        .neq('event_type', 'leave')
        .order('created_at', { ascending: false })
        .limit(50);

    if (routeError) {
        console.error('ROUTE QUERY ERROR:', routeError);
    } else {
        console.log(`ROUTE QUERY Found ${routeLogs.length} logs.`);
        if (routeLogs.length > 0) {
            console.log('Sample log:', routeLogs[0]);
        }
    }

    // 4. Test RLS with Anon Client (Imitating Frontend)
    console.log('4. Testing RLS with Anon Client...');
    const ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkd3h2cWJybXF3eXRtdnh5bXBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NjY3MzYsImV4cCI6MjA4MzQ0MjczNn0.NyTQqhs0pYg_8IkOD884rxOoh9PyJ8vR5hnHkb_MDUo';
    const anonClient = createClient(supabase.supabaseUrl, ANON_KEY); // Changed config.supabaseUrl to supabase.supabaseUrl

    const { data: anonLogs, error: anonError } = await anonClient
        .from('access_logs')
        .select('*')
        .eq('room_id', roomId);

    if (anonError) {
        console.error('ANON QUERY ERROR:', anonError);
    } else {
        console.log(`ANON QUERY Found ${anonLogs.length} logs.`);
    }

    // 5. Check General Count
    const { count } = await supabase
        .from('access_logs')
        .select('*', { count: 'exact', head: true })
        .eq('room_id', roomId);

    console.log(`Total logs for room ${roomId}: ${count}`);
}

test().catch(console.error);
