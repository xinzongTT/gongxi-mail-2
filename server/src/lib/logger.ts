import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from '../config/env.js';

const logDirectory = join(process.cwd(), 'logs');
mkdirSync(logDirectory, { recursive: true });

export const systemLogFilePath = join(logDirectory, 'system.log');

const fileStream = pino.destination({
    dest: systemLogFilePath,
    mkdir: true,
    sync: false,
});

const consoleStream = env.NODE_ENV === 'development'
    ? pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
    })
    : process.stdout;

export const logger = pino(
    {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    pino.multistream([
        { stream: consoleStream },
        { stream: fileStream },
    ])
);

export default logger;
