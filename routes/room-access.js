import express from 'express';
import { logAccess } from '../lib/access-logger.js';

const router = express.Router();

// POST /api/room-access - Log when someone accesses a room
router.post('/', async (req, res) => {
    try {
        const { roomId, sessionId } = req.body;

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        await logAccess(roomId, 'room_access', req, sessionId);

        res.json({ success: true });
    } catch (error) {
        console.error('Error logging room access:', error);
        res.status(500).json({ error: 'Failed to log access' });
    }
});

export default router;
