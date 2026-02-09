import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkRoomSlots(roomId) {
    console.log(`Checking slots for room: ${roomId}`);

    const { data: room, error } = await supabase
        .from('rooms')
        .select('id, name, max_concurrent_users, guest_slots_used')
        .eq('id', roomId)
        .single();

    if (error) {
        console.error('Error fetching room:', error.message);
        return;
    }

    if (!room) {
        console.error('Room not found');
        return;
    }

    console.log('--- Room Stats ---');
    console.log(`Name: ${room.name}`);
    console.log(`Max Users: ${room.max_concurrent_users || 999}`);
    console.log(`Guest Slots Used: ${room.guest_slots_used || 0}`);
    console.log('------------------');

    // Also check logs
    const { count: logCount, error: logError } = await supabase
        .from('access_logs')
        .select('*', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .eq('event_type', 'room_access');

    console.log(`Total Access Logs: ${logCount} (should roughly match slots used depending on authors)`);
}

const roomId = process.argv[2];

if (!roomId) {
    console.log('Usage: node check-room-slots.js <roomId>');
    process.exit(1);
}

checkRoomSlots(roomId);
