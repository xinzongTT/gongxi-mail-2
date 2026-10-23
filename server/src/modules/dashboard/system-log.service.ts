import { promises as fs } from 'node:fs';
import { systemLogFilePath } from '../../lib/logger.js';

type SystemLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface SystemLogEntry {
    id: string;
    time: string;
    level: SystemLogLevel;
    action: string | null;
    actorUsername: string | null;
    message: string;
    requestId: string | null;
    trigger: string | null;
    raw: string;
    context: Record<string, unknown>;
}

const levelMap: Record<number, SystemLogLevel> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};

async function readLogTail(maxBytes: number): Promise<string> {
    try {
        const stat = await fs.stat(systemLogFilePath);
        if (stat.size === 0) {
            return '';
        }

        const start = Math.max(0, stat.size - maxBytes);
        const handle = await fs.open(systemLogFilePath, 'r');
        try {
            const length = stat.size - start;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            let content = buffer.toString('utf8');

            if (start > 0) {
                const firstNewLine = content.indexOf('\n');
                content = firstNewLine >= 0 ? content.slice(firstNewLine + 1) : '';
            }

            return content;
        } finally {
            await handle.close();
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }
        throw err;
    }
}

function parseSystemLogLine(line: string, index: number): SystemLogEntry | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const payload = JSON.parse(trimmed) as Record<string, unknown>;
        const numericLevel = typeof payload.level === 'number' ? payload.level : 30;
        const timeValue = typeof payload.time === 'number'
            ? new Date(payload.time).toISOString()
            : typeof payload.time === 'string'
                ? payload.time
                : new Date().toISOString();

        const message = typeof payload.msg === 'string'
            ? payload.msg
            : typeof payload.message === 'string'
                ? payload.message
                : trimmed;

        const requestId = typeof payload.requestId === 'string'
            ? payload.requestId
            : typeof payload.reqId === 'string'
                ? payload.reqId
                : null;

        const systemEvent = payload.systemEvent === true;
        if (!systemEvent) {
            return null;
        }

        const trigger = typeof payload.trigger === 'string' ? payload.trigger : null;
        const action = typeof payload.action === 'string' ? payload.action : null;
        const actorUsername = typeof payload.actorUsername === 'string' ? payload.actorUsername : null;

        const context = Object.fromEntries(
            Object.entries(payload).filter(([key]) => !['level', 'time', 'msg', 'message', 'pid', 'hostname', 'systemEvent'].includes(key))
        );

        return {
            id: `${timeValue}-${index}`,
            time: timeValue,
            level: levelMap[numericLevel] || 'info',
            action,
            actorUsername,
            message,
            requestId,
            trigger,
            raw: trimmed,
            context,
        };
    } catch {
        return {
            id: `raw-${index}`,
            time: new Date().toISOString(),
            level: 'info',
            action: null,
            actorUsername: null,
            message: trimmed,
            requestId: null,
            trigger: null,
            raw: trimmed,
            context: {},
        };
    }
}

export const systemLogService = {
    async getLogs(options: { level?: SystemLogLevel; keyword?: string; lines?: number }) {
        const lines = Math.max(50, Math.min(options.lines ?? 200, 1000));
        const keyword = options.keyword?.trim().toLowerCase();
        const raw = await readLogTail(Math.max(lines * 2048, 256 * 1024));
        const entries = raw
            .split(/\r?\n/)
            .map((line, index) => parseSystemLogLine(line, index))
            .filter((entry): entry is SystemLogEntry => entry !== null)
            .filter((entry) => !options.level || entry.level === options.level)
            .filter((entry) => !keyword || entry.raw.toLowerCase().includes(keyword))
            .slice(-lines)
            .reverse();

        return {
            filePath: systemLogFilePath,
            lines,
            list: entries,
        };
    },
};
