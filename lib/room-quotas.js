import { supabase } from './supabase.js';

const DEFAULT_ROOM_MAX_FILES = 100;
const DEFAULT_ROOM_MAX_TOTAL_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

function toPositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

export function getRoomQuotaConfig() {
    return {
        maxFiles: toPositiveInt(process.env.ROOM_MAX_FILES, DEFAULT_ROOM_MAX_FILES),
        maxTotalSizeBytes: toPositiveInt(
            process.env.ROOM_MAX_TOTAL_SIZE_BYTES,
            DEFAULT_ROOM_MAX_TOTAL_SIZE_BYTES
        ),
    };
}

export async function getRoomUsage(roomId) {
    const { data, error } = await supabase
        .from('rooms')
        .select('file_count, total_size_bytes, max_files, max_total_size_bytes')
        .eq('id', roomId)
        .single();

    if (error) {
        throw error;
    }

    const defaults = getRoomQuotaConfig();
    return {
        fileCount: Number(data.file_count || 0),
        totalSizeBytes: Number(data.total_size_bytes || 0),
        maxFiles: toPositiveInt(data.max_files, defaults.maxFiles),
        maxTotalSizeBytes: toPositiveInt(data.max_total_size_bytes, defaults.maxTotalSizeBytes),
    };
}

function isQuotaErrorMessage(message) {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('room file limit exceeded') || normalized.includes('room size quota exceeded');
}

export function mapQuotaError(error) {
    if (!error) return null;
    const message = error.message || error.details || error.hint || '';
    if (isQuotaErrorMessage(message)) {
        return {
            ok: false,
            error: String(message),
        };
    }
    return null;
}

export async function ensureRoomQuota(roomId, incomingFileSizeBytes) {
    const incomingSize = Number(incomingFileSizeBytes || 0);
    if (!Number.isFinite(incomingSize) || incomingSize < 0) {
        return {
            ok: false,
            error: 'Invalid file size.',
        };
    }

    const usage = await getRoomUsage(roomId);

    const projectedFileCount = usage.fileCount + 1;
    const projectedTotalSizeBytes = usage.totalSizeBytes + incomingSize;

    if (projectedFileCount > usage.maxFiles) {
        return {
            ok: false,
            error: `Room file limit exceeded (${usage.maxFiles} files max).`,
            limits: {
                maxFiles: usage.maxFiles,
                maxTotalSizeBytes: usage.maxTotalSizeBytes,
            },
            usage,
        };
    }

    if (projectedTotalSizeBytes > usage.maxTotalSizeBytes) {
        return {
            ok: false,
            error: `Room size quota exceeded (${usage.maxTotalSizeBytes} bytes max).`,
            limits: {
                maxFiles: usage.maxFiles,
                maxTotalSizeBytes: usage.maxTotalSizeBytes,
            },
            usage,
        };
    }

    return {
        ok: true,
        limits: {
            maxFiles: usage.maxFiles,
            maxTotalSizeBytes: usage.maxTotalSizeBytes,
        },
        usage,
    };
}
