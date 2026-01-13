import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { target_url } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'File ID is required' });
        }

        // Update the file using service key (bypasses RLS)
        const { data, error } = await supabase
            .from('files')
            .update({ target_url })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            throw error;
        }

        res.json({ message: 'File updated successfully', file: data });
    } catch (error) {
        console.error('Error updating file:', error);
        res.status(500).json({ error: 'Failed to update file' });
    }
});

export default router;
