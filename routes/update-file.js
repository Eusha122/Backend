import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();


router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { target_url, description } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'File ID is required' });
        }

        // Build update object with only provided fields
        const updateData = {};
        if (target_url !== undefined) updateData.target_url = target_url;
        if (description !== undefined) updateData.description = description;

        // Update the file using service key (bypasses RLS)
        const { data, error } = await supabase
            .from('files')
            .update(updateData)
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
