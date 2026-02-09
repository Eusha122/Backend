import express from 'express';
import { supabase } from '../lib/supabase.js';
import { isAuthorToken } from '../lib/room-auth.js';

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeTargetUrl(input) {
    if (input === null) return null;
    const raw = String(input || '').trim();
    if (!raw) return null;

    let parsedUrl;
    try {
        parsedUrl = new URL(raw);
    } catch {
        return { invalid: true };
    }

    const protocol = parsedUrl.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
        return { invalid: true };
    }

    return parsedUrl.toString().slice(0, 2048);
}

function sanitizeDescription(input) {
    if (input === null) return null;
    const value = String(input || '').trim();
    if (!value) return null;
    return value.slice(0, 500);
}

router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { target_url, description } = req.body;

        if (!id || !UUID_REGEX.test(String(id))) {
            return res.status(400).json({ error: 'Valid file ID is required' });
        }

        if (target_url === undefined && description === undefined) {
            return res.status(400).json({ error: 'No update fields provided' });
        }

        const { data: file, error: fileError } = await supabase
            .from('files')
            .select('id, room_id')
            .eq('id', id)
            .single();

        if (fileError || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        const authorToken = req.headers['x-author-token'] || req.body?.authorToken;
        const authorOk = await isAuthorToken(file.room_id, authorToken);
        if (!authorOk) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updateData = {};

        if (target_url !== undefined) {
            const sanitizedUrl = sanitizeTargetUrl(target_url);
            if (sanitizedUrl && typeof sanitizedUrl === 'object' && sanitizedUrl.invalid) {
                return res.status(400).json({ error: 'Invalid target_url. Only http/https URLs are allowed.' });
            }
            updateData.target_url = sanitizedUrl;
        }

        if (description !== undefined) {
            updateData.description = sanitizeDescription(description);
        }

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
