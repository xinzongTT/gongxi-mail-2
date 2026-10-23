import { emailService } from '../email/email.service.js';
import { poolService } from './pool.service.js';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { setCache, getCache } from '../../lib/redis.js';
import { proxyFetch } from '../../lib/proxy.js';
import prisma from '../../lib/prisma.js';
import type { MailRequestInput } from './mail.schema.js';
import Imap from 'node-imap';
import { simpleParser, type ParsedMail, type Source } from 'mailparser';
import { createHash } from 'node:crypto';

type MailFetchStrategy = 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY';

interface Credentials {
    id: number;
    email: string;
    clientId: string;
    refreshToken: string;
    autoAssigned: boolean;
    fetchStrategy?: MailFetchStrategy;
}

interface EmailMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface OAuthTokenResponse {
    access_token?: string;
    expires_in?: number;
    scope?: string;
}

interface GraphMessage {
    id?: string;
    from?: {
        emailAddress?: {
            address?: string;
        };
    };
    subject?: string;
    bodyPreview?: string;
    body?: {
        content?: string;
    };
    createdDateTime?: string;
}

interface GraphMessagesResponse {
    value?: GraphMessage[];
}

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
        return 'Unknown error';
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() ? message : 'Unknown error';
}

/**
 * 微软返回的 scope 有多种写法，统一拆成权限名集合比较：
 * - "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read"
 * - "Mail.Read User.Read"（短写法）
 * - "https://outlook.office.com/IMAP.AccessAsUser.All"
 */
function parseScopeNames(scopeText: string): Set<string> {
    const names = new Set<string>();
    for (const raw of scopeText.split(/\s+/)) {
        if (!raw) continue;
        const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
        if (name) names.add(name);
    }
    return names;
}

function scopeHas(scopeText: string, ...permissionNames: string[]): boolean {
    const names = parseScopeNames(scopeText);
    return permissionNames.some((name) => names.has(name));
}

/** Graph 无 Mail.Read 结论的负缓存时长（秒）：避免 IMAP 邮箱每次收信都先白跑一趟 Graph 换 token */
const GRAPH_NO_MAIL_READ_CACHE_TTL = 1800;

/** IMAP 换 token 时依次尝试的 scope：先带标准 IMAP scope，失败再退回不带 scope 的老写法 */
const IMAP_TOKEN_SCOPES: Array<string | undefined> = [
    'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    undefined,
];

/** 把 API 传入的文件夹名翻译成 Outlook IMAP 的真实文件夹名 */
function resolveImapMailbox(mailbox: string): string {
    const key = (mailbox || 'inbox').trim().toLowerCase();
    const map: Record<string, string> = {
        inbox: 'INBOX',
        junk: 'Junk Email',
        junkemail: 'Junk Email',
        'junk email': 'Junk Email',
        sent: 'Sent Items',
        'sent items': 'Sent Items',
        sentitems: 'Sent Items',
        drafts: 'Drafts',
        draft: 'Drafts',
        trash: 'Deleted Items',
        deleted: 'Deleted Items',
        'deleted items': 'Deleted Items',
        archive: 'Archive',
    };
    return map[key] || mailbox;
}

export const mailService = {
    /**
     * 解析凭证
     */
    async resolveCredentials(
        input: MailRequestInput,
        apiKeyId?: number
    ): Promise<Credentials> {
        const { email, auto } = input;

        // 自动分配模式
        if (!email && auto) {
            if (!apiKeyId) {
                throw new AppError('AUTH_REQUIRED', 'Auto assignment requires API Key authentication', 400);
            }

            const account = await poolService.getUnusedEmail(apiKeyId);
            if (!account) {
                const stats = await poolService.getStats(apiKeyId);
                throw new AppError(
                    'NO_UNUSED_EMAIL',
                    `No unused emails available. Used: ${stats.used}/${stats.total}`,
                    400
                );
            }

            return { ...account, autoAssigned: true };
        }

        // 必须提供邮箱
        if (!email) {
            throw new AppError('EMAIL_REQUIRED', 'Email is required. Set auto=true to auto-assign.', 400);
        }

        // 从数据库查询
        const account = await emailService.getByEmail(email);
        if (!account) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }

        return { ...account, autoAssigned: false };
    },

    /**
     * 更新邮箱状态
     */
    async updateEmailStatus(emailId: number, success: boolean, errorMessage?: string) {
        await emailService.updateStatus(
            emailId,
            success ? 'ACTIVE' : 'ERROR',
            errorMessage
        );
    },

    /**
     * 记录 API 调用
     */
    async logApiCall(
        action: string,
        apiKeyId: number | undefined,
        emailAccountId: number | undefined,
        requestIp: string,
        responseCode: number,
        responseTimeMs: number,
        requestId?: string
    ) {
        try {
            await prisma.apiLog.create({
                data: {
                    action,
                    apiKeyId,
                    emailAccountId,
                    requestIp,
                    responseCode,
                    responseTimeMs,
                    metadata: requestId ? { requestId } : undefined,
                },
            });
        } catch (err) {
            logger.error({ err }, 'Failed to log API call');
        }
    },

    /**
     * 获取 Microsoft Graph API Access Token
     */
    async getGraphAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<{ accessToken: string; hasMailRead: boolean; hasMailReadWrite: boolean } | null> {
        const cacheKey = `graph_api_access_token_${credentials.email}`;
        // 负缓存按 refresh token 指纹区分：换一枚新 token 重新导入后不会被旧结论误伤
        const tokenFingerprint = createHash('sha256').update(credentials.refreshToken).digest('hex').slice(0, 16);
        const noMailReadCacheKey = `graph_api_no_mail_read_${credentials.email}_${tokenFingerprint}`;

        // 尝试从缓存获取（缓存的 token 一定有 Mail.Read 权限）
        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached Graph API token');
            const cachedReadWrite = await getCache(`graph_api_mail_readwrite_${credentials.email}`);
            return { accessToken: cachedToken, hasMailRead: true, hasMailReadWrite: cachedReadWrite === '1' };
        }

        // 负缓存：近期已确认该 refresh token 没有 Graph 邮件权限（多为 IMAP 专用 token），
        // 直接返回无权限结论，让上层走 IMAP，不要每次收信都重复请求一次注定失败的 Graph 换 token
        if (await getCache(noMailReadCacheKey)) {
            logger.debug({ email: credentials.email }, 'Graph skipped: cached no-Mail.Read result');
            return { accessToken: '', hasMailRead: false, hasMailReadWrite: false };
        }

        // 依次尝试两种 scope 写法：
        // 1) .default —— 按该应用已授权的全部权限签发
        // 2) 显式 Mail.Read —— 部分应用 .default 返回的 scope 不完整时用它兜底
        const scopeAttempts = [
            'https://graph.microsoft.com/.default',
            'https://graph.microsoft.com/Mail.Read offline_access',
        ];

        for (const scope of scopeAttempts) {
            try {
                const response = await proxyFetch(
                    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({
                            client_id: credentials.clientId,
                            grant_type: 'refresh_token',
                            refresh_token: credentials.refreshToken,
                            scope,
                        }).toString(),
                    },
                    proxyConfig
                );

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.warn({ email: credentials.email, status: response.status, scope, error: errorText }, 'Graph API token request failed, trying next scope');
                    continue;
                }

                const data = await response.json() as OAuthTokenResponse;

                // scope 兼容长/短两种写法；Mail.ReadWrite 蕴含可读
                const scopeText = typeof data.scope === 'string' ? data.scope : '';
                const hasMailReadWrite = scopeHas(scopeText, 'Mail.ReadWrite');
                const hasMailRead = hasMailReadWrite || scopeHas(scopeText, 'Mail.Read');
                const accessToken = typeof data.access_token === 'string' ? data.access_token : null;

                if (!accessToken) {
                    logger.warn({ email: credentials.email, scope }, 'Graph API token missing access_token');
                    continue;
                }

                if (hasMailRead) {
                    const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
                    await setCache(cacheKey, accessToken, expireTime);
                    if (hasMailReadWrite) {
                        await setCache(`graph_api_mail_readwrite_${credentials.email}`, '1', expireTime);
                    }
                    return { accessToken, hasMailRead, hasMailReadWrite };
                }

                logger.warn({ email: credentials.email, scope, grantedScope: scopeText }, 'No Mail.Read scope in Graph token');
            } catch (err) {
                logger.error({ err, email: credentials.email, scope }, 'Failed to get Graph API token');
            }
        }

        // 两种写法都没拿到 Mail.Read：基本可断定这枚 refresh token 从未授权过 Graph（如 Thunderbird 的 IMAP token）
        await setCache(noMailReadCacheKey, '1', GRAPH_NO_MAIL_READ_CACHE_TTL);
        logger.warn({ email: credentials.email }, 'No Mail.Read scope in token, will fallback to IMAP');
        return { accessToken: '', hasMailRead: false, hasMailReadWrite: false };
    },

    /**
     * 使用 Graph API 获取邮件
     */
    async getEmailsViaGraphApi(
        accessToken: string,
        mailbox: string,
        limit: number = 100,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<EmailMessage[]> {
        // 转换邮箱名称
        let folder = 'inbox';
        if (mailbox?.toLowerCase() === 'junk') {
            folder = 'junkemail';
        } else if (mailbox?.toLowerCase() === 'inbox') {
            folder = 'inbox';
        }

        try {
            const response = await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=receivedDateTime desc`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Graph API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as GraphMessagesResponse;
            const emails = Array.isArray(data.value) ? data.value : [];

            return emails.map((item: GraphMessage, index: number) => ({
                id: item.id || `graph_${Date.now()}_${index}`,
                from: item.from?.emailAddress?.address || '',
                subject: item.subject || '',
                text: item.bodyPreview || '',
                html: item.body?.content || '',
                date: item.createdDateTime || '',
            }));
        } catch (err) {
            logger.error({ err }, 'Failed to fetch emails via Graph API');
            throw err;
        }
    },

    /**
     * 获取 IMAP Access Token
     *
     * 关键点：必须显式带 Outlook 资源的 IMAP scope 去换 token。
     * 原实现不带 scope，微软签发的 token 资源/权限不对，IMAP 服务器会直接拒绝 XOAUTH2 登录。
     * Graph 的 token 与 Outlook(IMAP) 的 token 属于不同资源，不能混用，必须分别换。
     */
    async getImapAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<string | null> {
        const cacheKey = `imap_api_access_token_${credentials.email}`;

        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached IMAP token');
            return cachedToken;
        }

        for (const scope of IMAP_TOKEN_SCOPES) {
            try {
                const params = new URLSearchParams({
                    client_id: credentials.clientId,
                    grant_type: 'refresh_token',
                    refresh_token: credentials.refreshToken,
                });
                if (scope) {
                    params.set('scope', scope);
                }

                const response = await proxyFetch(
                    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: params.toString(),
                    },
                    proxyConfig
                );

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.warn({ email: credentials.email, status: response.status, scope: scope ?? '(none)', error: errorText }, 'IMAP token request failed, trying next scope');
                    continue;
                }

                const data = await response.json() as OAuthTokenResponse;
                const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
                if (!accessToken) {
                    logger.warn({ email: credentials.email, scope: scope ?? '(none)' }, 'IMAP token missing access_token');
                    continue;
                }

                // 带 scope 时校验一下返回权限，确认这枚 token 真能用于 IMAP（无 scope 的老写法无法校验，放行）
                const scopeText = typeof data.scope === 'string' ? data.scope : '';
                if (scope && scopeText && !scopeHas(scopeText, 'IMAP.AccessAsUser.All')) {
                    logger.warn({ email: credentials.email, grantedScope: scopeText }, 'IMAP token returned without IMAP scope, trying next scope');
                    continue;
                }

                const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
                await setCache(cacheKey, accessToken, expireTime);

                return accessToken;
            } catch (err) {
                logger.error({ err, email: credentials.email, scope: scope ?? '(none)' }, 'Failed to get IMAP token');
            }
        }

        return null;
    },

    /**
     * 生成 IMAP XOAUTH2 认证字符串
     */
    generateAuthString(email: string, accessToken: string): string {
        const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
        return Buffer.from(authString).toString('base64');
    },

    /**
     * 使用 IMAP 获取邮件
     */
    async getEmailsViaImap(
        email: string,
        authString: string,
        mailbox: string = 'INBOX',
        limit: number = 100
    ): Promise<EmailMessage[]> {
        // API 层传的是 inbox/junk 这类逻辑名，IMAP 要用真实文件夹名（如 Junk Email），先翻译
        const imapMailbox = resolveImapMailbox(mailbox);
        return new Promise((resolve, reject) => {
            const imapConfig: ConstructorParameters<typeof Imap>[0] = {
                user: email,
                password: '',
                xoauth2: authString,
                host: 'outlook.office365.com',
                port: 993,
                tls: true,
                tlsOptions: {
                    rejectUnauthorized: false,
                },
            };
            const imap = new Imap(imapConfig);

            const emailList: EmailMessage[] = [];
            let messageCount = 0;
            let processedCount = 0;

            imap.once('ready', async () => {
                try {
                    await new Promise<void>((res, rej) => {
                        imap.openBox(imapMailbox, true, (err) => {
                            if (err) return rej(err);
                            res();
                        });
                    });

                    imap.search(['ALL'], (err: Error | null, results: number[]) => {
                        if (err) {
                            imap.end();
                            return reject(err);
                        }

                        if (!results || results.length === 0) {
                            imap.end();
                            return resolve([]);
                        }

                        // 限制返回数量
                        const limitedResults = results.slice(-limit);
                        messageCount = limitedResults.length;

                        const f = imap.fetch(limitedResults, { bodies: '' });

                        f.on('message', (msg) => {
                            msg.on('body', (stream) => {
                                simpleParser(stream as unknown as Source)
                                    .then((mail: ParsedMail) => {
                                        const html = typeof mail.html === 'string' ? mail.html : '';
                                        emailList.push({
                                            id: `imap_${Date.now()}_${processedCount}`,
                                            from: mail.from?.text || '',
                                            subject: mail.subject || '',
                                            text: mail.text || '',
                                            html,
                                            date: mail.date?.toISOString() || '',
                                        });
                                    })
                                    .catch((parseErr: Error) => {
                                        logger.error({ parseErr }, 'Error parsing email');
                                    })
                                    .finally(() => {
                                        processedCount++;
                                        if (processedCount === messageCount) {
                                            imap.end();
                                        }
                                    });
                            });
                        });

                        f.once('error', (fetchErr: Error) => {
                            logger.error({ fetchErr }, 'IMAP fetch error');
                            imap.end();
                            reject(fetchErr);
                        });

                        f.once('end', () => {
                            // 如果没有消息，直接结束
                            if (messageCount === 0) {
                                imap.end();
                            }
                        });
                    });
                } catch (err) {
                    imap.end();
                    reject(err);
                }
            });

            imap.once('error', (err: Error) => {
                logger.error({ err }, 'IMAP connection error');
                reject(err);
            });

            imap.once('end', () => {
                logger.debug({ email }, 'IMAP connection ended');
                // 按日期降序排序（最新的在前面）
                emailList.sort((a: EmailMessage, b: EmailMessage) => {
                    const dateA = a.date ? new Date(a.date).getTime() : 0;
                    const dateB = b.date ? new Date(b.date).getTime() : 0;
                    return dateB - dateA;
                });
                resolve(emailList);
            });

            imap.connect();
        });
    },

    /**
     * 获取邮件（主入口）- 支持 Graph API 和 IMAP 回退
     */
    async getEmails(
        credentials: Credentials,
        options: { mailbox: string; limit?: number; socks5?: string; http?: string }
    ) {
        const proxyConfig = { socks5: options.socks5, http: options.http };
        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        const limit = options.limit || 100;

        const fetchViaGraph = async () => {
            const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);
            if (!tokenResult) {
                throw new AppError('GRAPH_TOKEN_FAILED', 'Failed to get Graph API access token', 502);
            }
            if (!tokenResult.hasMailRead) {
                throw new AppError('GRAPH_SCOPE_MISSING', 'Graph token missing Mail.Read scope', 502);
            }

            logger.info({ email: credentials.email, strategy }, 'Using Graph API for email retrieval');
            const messages = await this.getEmailsViaGraphApi(
                tokenResult.accessToken,
                options.mailbox,
                limit,
                proxyConfig
            );

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                count: messages.length,
                messages,
                method: 'graph_api',
            };
        };

        const fetchViaImap = async () => {
            logger.info({ email: credentials.email, strategy }, 'Using IMAP for email retrieval');
            const imapToken = await this.getImapAccessToken(credentials, proxyConfig);
            if (!imapToken) {
                throw new AppError('IMAP_TOKEN_FAILED', 'Failed to get IMAP access token', 502);
            }

            const authString = this.generateAuthString(credentials.email, imapToken);
            const messages = await this.getEmailsViaImap(
                credentials.email,
                authString,
                options.mailbox,
                limit
            );

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                count: messages.length,
                messages,
                method: 'imap',
            };
        };

        if (strategy === 'GRAPH_ONLY') {
            return fetchViaGraph();
        }

        if (strategy === 'IMAP_ONLY') {
            return fetchViaImap();
        }

        // 双通道策略：先试首选通道，失败再回退另一条。
        // 两条都失败时把两个错误一起抛出——只抛回退通道的错误会掩盖首选通道的真实失败原因
        // （典型误导：IMAP 才是真故障，却只看到 GRAPH_SCOPE_MISSING）。
        if (strategy === 'IMAP_FIRST') {
            try {
                return await fetchViaImap();
            } catch (imapErr) {
                logger.warn({ imapErr, email: credentials.email }, 'IMAP failed, fallback to Graph API');
                try {
                    return await fetchViaGraph();
                } catch (graphErr) {
                    throw new AppError(
                        'MAIL_FETCH_FAILED',
                        `Both mail channels failed. IMAP: ${getErrorMessage(imapErr)} | Graph: ${getErrorMessage(graphErr)}`,
                        502
                    );
                }
            }
        }

        try {
            return await fetchViaGraph();
        } catch (graphErr) {
            logger.warn({ graphErr, email: credentials.email }, 'Graph API failed, fallback to IMAP');
            try {
                return await fetchViaImap();
            } catch (imapErr) {
                throw new AppError(
                    'MAIL_FETCH_FAILED',
                    `Both mail channels failed. Graph: ${getErrorMessage(graphErr)} | IMAP: ${getErrorMessage(imapErr)}`,
                    502
                );
            }
        }
    },

    /**
     * 清空邮箱（通过 Graph API 删除所有邮件）
     */
    async processMailbox(
        credentials: Credentials,
        options: { mailbox: string; socks5?: string; http?: string }
    ) {
        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        if (strategy === 'IMAP_ONLY') {
            throw new AppError(
                'MAILBOX_CLEAR_UNSUPPORTED',
                'Mailbox clear is not available for IMAP_ONLY strategy',
                400
            );
        }

        logger.info({ email: credentials.email, mailbox: options.mailbox }, 'Processing mailbox via Graph API');

        const proxyConfig = { socks5: options.socks5, http: options.http };
        const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);

        if (!tokenResult) {
            throw new AppError('GRAPH_API_FAILED', 'Failed to get access token', 500);
        }

        // 清空邮箱走 Graph：读要 Mail.Read，删要 Mail.ReadWrite；IMAP token 在这里必然无权限，先说清
        if (!tokenResult.hasMailRead) {
            throw new AppError('GRAPH_SCOPE_MISSING', 'Graph token missing Mail.Read scope; IMAP-only tokens cannot clear mailbox via Graph', 502);
        }

        // 1. 获取所有邮件 ID
        let page = 0;
        let deletedCount = 0;
        let seenCount = 0;
        let hasMore = true;

        try {
            while (hasMore && page < 10) { // 限制最大页数防止超时
                const messages = await this.getEmailsViaGraphApi(
                    tokenResult.accessToken,
                    options.mailbox,
                    500, // 每次取 500
                    proxyConfig
                );

                if (messages.length === 0) {
                    hasMore = false;
                    break;
                }

                // 2. 批量删除（Graph API 不支持批量删除，只能并发逐个删除）
                // 限制并发数为 10；只统计真正删除成功的（只有 Mail.Read 没有 ReadWrite 时删除会被 Graph 拒绝）
                seenCount += messages.length;
                const batchSize = 10;
                for (let i = 0; i < messages.length; i += batchSize) {
                    const chunk = messages.slice(i, i + batchSize);
                    const results = await Promise.all(chunk.map(msg =>
                        this.deleteMessageViaGraphApi(tokenResult.accessToken, msg.id, proxyConfig)
                    ));
                    deletedCount += results.filter(Boolean).length;
                }

                page++;
            }

            if (seenCount > 0 && deletedCount === 0) {
                return {
                    email: credentials.email,
                    mailbox: options.mailbox,
                    message: 'Failed to delete any message: Graph token likely missing Mail.ReadWrite scope',
                    status: 'error',
                    deletedCount,
                };
            }

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Successfully deleted ${deletedCount} messages`,
                status: 'success',
                deletedCount,
            };

        } catch (err: unknown) {
            logger.error({ err, email: credentials.email }, 'Error processing mailbox');
            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Partial success or error: ${getErrorMessage(err)}`,
                status: 'error',
                deletedCount,
            };
        }
    },

    /**
     * 单个删除邮件
     */
    async deleteMessageViaGraphApi(
        accessToken: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<boolean> {
        try {
            const response = await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                    },
                },
                proxyConfig
            );
            if (!response.ok) {
                logger.warn({ messageId, status: response.status }, 'Failed to delete message');
                return false;
            }
            return true;
        } catch (_err) {
            // 忽略单个删除错误，继续下一个；由上层按成功数汇总判断
            logger.warn({ messageId }, 'Failed to delete message');
            return false;
        }
    },
};
