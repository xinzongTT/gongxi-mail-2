import { logger } from '../lib/logger.js';
import { tokenRefreshService } from '../modules/email/token-refresh.service.js';

const STARTUP_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let timer: NodeJS.Timeout | null = null;
let scheduledNextRunAt: Date | null = null;
let stopped = false;

function clearScheduledTimer() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    scheduledNextRunAt = null;
}

function armTimer(delayMs: number, callback: () => void) {
    timer = setTimeout(callback, delayMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

function scheduleNextChunk() {
    if (stopped || !scheduledNextRunAt) {
        return;
    }

    const remainingMs = scheduledNextRunAt.getTime() - Date.now();
    if (remainingMs <= 0) {
        armTimer(0, () => {
            timer = null;
            void executeScheduledRun();
        });
        return;
    }

    const nextDelayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    armTimer(nextDelayMs, () => {
        timer = null;
        if (stopped || !scheduledNextRunAt) {
            return;
        }

        if (scheduledNextRunAt.getTime() <= Date.now()) {
            void executeScheduledRun();
            return;
        }

        scheduleNextChunk();
    });
}

async function persistAndSchedule(targetRunAt: Date | null) {
    clearScheduledTimer();

    if (stopped) {
        return;
    }

    await tokenRefreshService.updateNextAutoRunAt(targetRunAt);
    if (!targetRunAt) {
        return;
    }

    scheduledNextRunAt = targetRunAt;
    scheduleNextChunk();
}

async function scheduleFromConfig(reason: 'startup' | 'update' | 'completed' | 'retry'): Promise<void> {
    const state = await tokenRefreshService.getTokenRefreshScheduleState();

    if (!state.enabled) {
        logger.info({ systemEvent: true, action: 'token_refresh.auto_disabled', trigger: 'AUTO', reason }, '自动刷新调度器已停用');
        await persistAndSchedule(null);
        return;
    }

    if (reason === 'update' && tokenRefreshService.isAutoRunInProgress()) {
        logger.info({ systemEvent: true, action: 'token_refresh.auto_update_deferred', trigger: 'AUTO', reason }, '自动刷新配置更新已延后，等待当前自动任务完成');
        return;
    }

    const intervalMs = state.intervalHours * 60 * 60 * 1000;
    let targetRunAt: Date;

    if (reason === 'startup') {
        if (state.nextRunAt) {
            targetRunAt = state.nextRunAt;
        } else if (state.lastRunAt) {
            targetRunAt = new Date(state.lastRunAt.getTime() + intervalMs);
        } else {
            targetRunAt = new Date(Date.now() + STARTUP_DELAY_MS);
        }
    } else if (reason === 'completed') {
        targetRunAt = new Date(Date.now() + intervalMs);
    } else if (reason === 'retry') {
        targetRunAt = new Date(Date.now() + RETRY_DELAY_MS);
    } else if (state.lastRunAt) {
        targetRunAt = new Date(state.lastRunAt.getTime() + intervalMs);
    } else {
        targetRunAt = new Date(Date.now() + STARTUP_DELAY_MS);
    }

    if (targetRunAt.getTime() < Date.now()) {
        targetRunAt = new Date();
    }

    logger.info({
        systemEvent: true,
        action: 'token_refresh.auto_scheduled',
        trigger: 'AUTO',
        reason,
        intervalHours: state.intervalHours,
        concurrency: state.concurrency,
        nextRunAt: targetRunAt.toISOString(),
    }, '已安排下一次自动刷新');

    await persistAndSchedule(targetRunAt);
}

async function executeScheduledRun(): Promise<void> {
    clearScheduledTimer();
    await tokenRefreshService.updateNextAutoRunAt(null);

    let nextReason: 'completed' | 'retry' = 'completed';

    try {
        const state = await tokenRefreshService.getTokenRefreshScheduleState();
        if (!state.enabled) {
            logger.info({ systemEvent: true, action: 'token_refresh.auto_skip_disabled', trigger: 'AUTO' }, '自动刷新已跳过，因为调度器处于停用状态');
            return;
        }

        if (tokenRefreshService.isRefreshRunning()) {
            const activeRun = tokenRefreshService.getCurrentRun();
            nextReason = 'retry';
            logger.info({
                systemEvent: true,
                action: 'token_refresh.auto_delayed',
                trigger: 'AUTO',
                blockedByTrigger: activeRun?.trigger ?? 'UNKNOWN',
                blockedGroupId: activeRun?.groupId ?? null,
                blockedByUsername: activeRun?.requestedByUsername ?? null,
            }, '自动刷新已延后，因为当前还有其他刷新任务在运行');
            return;
        }

        await tokenRefreshService.refreshAll({
            concurrency: state.concurrency,
            trigger: 'AUTO',
        });
    } catch (err) {
        nextReason = 'retry';
        logger.error({ err, systemEvent: true, action: 'token_refresh.auto_failed', trigger: 'AUTO' }, '自动刷新任务执行失败');
    } finally {
        if (!stopped) {
            await scheduleFromConfig(nextReason);
        }
    }
}

export function getTokenRefreshJobNextRunAt(): Date | null {
    return scheduledNextRunAt;
}

export async function refreshTokenRefreshJobSchedule(): Promise<void> {
    if (stopped) {
        return;
    }

    await scheduleFromConfig('update');
}

export function startTokenRefreshJob(): () => void {
    stopped = false;
    void scheduleFromConfig('startup');

    return () => {
        stopped = true;
        clearScheduledTimer();
    };
}
