import React, { useCallback, useEffect, useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Space, Tag, Alert, QRCode, Switch, InputNumber, Progress } from 'antd';
import { LockOutlined, SafetyCertificateOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { authApi, emailApi } from '../../api';
import { useAuthStore } from '../../stores/authStore';
import { getAdminRoleLabel } from '../../utils/auth';
import { requestData } from '../../utils/request';

const { Title, Text } = Typography;

interface TwoFactorStatus {
    enabled: boolean;
    pending: boolean;
    legacyEnv: boolean;
}

interface TokenRefreshFailure {
    emailId: number;
    email: string;
    success: boolean;
    message: string;
}

interface TokenRefreshCurrentRun {
    trigger: 'AUTO' | 'MANUAL';
    total: number;
    completed: number;
    success: number;
    failed: number;
    groupId: number | null;
    requestedByUsername: string | null;
    startedAt: string;
    durationMs: number;
    recentFailures: TokenRefreshFailure[];
}

interface TokenRefreshStatus {
    enabled: boolean;
    intervalHours: number;
    concurrency: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    isRunning: boolean;
    lastResult: {
        total: number;
        success: number;
        failed: number;
        durationMs: number;
    } | null;
    currentRun: TokenRefreshCurrentRun | null;
    recentFailures: TokenRefreshFailure[];
}

const SettingsPage: React.FC = () => {
    const [passwordLoading, setPasswordLoading] = useState(false);
    const [twoFactorLoading, setTwoFactorLoading] = useState(false);
    const [twoFactorStatusLoading, setTwoFactorStatusLoading] = useState(true);
    const [twoFactorStatus, setTwoFactorStatus] = useState<TwoFactorStatus>({
        enabled: false,
        pending: false,
        legacyEnv: false,
    });
    const [tokenRefreshStatus, setTokenRefreshStatus] = useState<TokenRefreshStatus | null>(null);
    const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
    const [enableOtp, setEnableOtp] = useState('');
    const [tokenRefreshStatusLoading, setTokenRefreshStatusLoading] = useState(true);
    const [tokenRefreshActionLoading, setTokenRefreshActionLoading] = useState(false);
    const [tokenRefreshSaveLoading, setTokenRefreshSaveLoading] = useState(false);
    const [form] = Form.useForm();
    const [disable2FaForm] = Form.useForm();
    const [tokenRefreshForm] = Form.useForm();
    const { admin, token, setAuth } = useAuthStore();

    const syncStoreTwoFactor = useCallback((enabled: boolean) => {
        if (!token || !admin) {
            return;
        }
        setAuth(token, { ...admin, twoFactorEnabled: enabled });
    }, [admin, setAuth, token]);

    const loadTwoFactorStatus = async (silent: boolean = false) => {
        const result = await requestData<TwoFactorStatus>(
            () => authApi.getTwoFactorStatus(),
            '获取二次验证状态失败',
            { silent }
        );
        if (result) {
            setTwoFactorStatus(result);
            if (!result.pending) {
                setSetupData(null);
            }
            syncStoreTwoFactor(result.enabled);
        }
        setTwoFactorStatusLoading(false);
    };

    const loadTokenRefreshStatus = useCallback(async (silent: boolean = false) => {
        if (!silent) {
            setTokenRefreshStatusLoading(true);
        }

        const result = await requestData<TokenRefreshStatus>(
            () => emailApi.getRefreshStatus(),
            '获取 Token 刷新状态失败',
            { silent }
        );
        if (result) {
            setTokenRefreshStatus(result);
            if (!silent || !tokenRefreshForm.isFieldsTouched()) {
                tokenRefreshForm.setFieldsValue({
                    enabled: result.enabled,
                    intervalHours: result.intervalHours,
                    concurrency: result.concurrency,
                });
            }
        }

        if (!silent) {
            setTokenRefreshStatusLoading(false);
        }
    }, [tokenRefreshForm]);

    useEffect(() => {
        let cancelled = false;

        const init = async () => {
            const result = await requestData<TwoFactorStatus>(
                () => authApi.getTwoFactorStatus(),
                '获取二次验证状态失败',
                { silent: true }
            );
            if (!cancelled && result) {
                setTwoFactorStatus(result);
                if (!result.pending) {
                    setSetupData(null);
                }
                syncStoreTwoFactor(result.enabled);
            }
            if (!cancelled) {
                setTwoFactorStatusLoading(false);
            }
        };

        void init();
        return () => {
            cancelled = true;
        };
    }, [syncStoreTwoFactor]);

    useEffect(() => {
        let cancelled = false;

        const init = async () => {
            await loadTokenRefreshStatus(true);
            if (!cancelled) {
                setTokenRefreshStatusLoading(false);
            }
        };

        void init();
        return () => {
            cancelled = true;
        };
    }, [loadTokenRefreshStatus]);

    useEffect(() => {
        if (!tokenRefreshStatus?.isRunning) {
            return;
        }

        const timer = window.setInterval(() => {
            void loadTokenRefreshStatus(true);
        }, 5000);

        return () => window.clearInterval(timer);
    }, [loadTokenRefreshStatus, tokenRefreshStatus?.isRunning]);

    const handleChangePassword = async (values: {
        oldPassword: string;
        newPassword: string;
        confirmPassword: string;
    }) => {
        if (values.newPassword !== values.confirmPassword) {
            message.error('两次输入的密码不一致');
            return;
        }

        setPasswordLoading(true);
        const result = await requestData<{ message?: string }>(
            () => authApi.changePassword(values.oldPassword, values.newPassword),
            '密码修改失败'
        );
        if (result) {
            message.success('密码修改成功');
            form.resetFields();
        }
        setPasswordLoading(false);
    };

    const handleSetup2Fa = async () => {
        setTwoFactorLoading(true);
        const result = await requestData<{ secret: string; otpauthUrl: string }>(
            () => authApi.setupTwoFactor(),
            '生成二次验证密钥失败'
        );
        if (result) {
            setSetupData(result);
            setTwoFactorStatus((prev) => ({ ...prev, pending: true, enabled: false, legacyEnv: false }));
            message.info('请在验证器中添加密钥后输入 6 位验证码完成启用');
        }
        setTwoFactorLoading(false);
    };

    const handleEnable2Fa = async () => {
        const otp = enableOtp.trim();
        if (!/^\d{6}$/.test(otp)) {
            message.error('请输入 6 位验证码');
            return;
        }

        setTwoFactorLoading(true);
        const result = await requestData<{ enabled: boolean }>(
            () => authApi.enableTwoFactor(otp),
            '启用二次验证失败'
        );
        if (result) {
            message.success('二次验证已启用');
            setEnableOtp('');
            setSetupData(null);
            await loadTwoFactorStatus();
        }
        setTwoFactorLoading(false);
    };

    const handleDisable2Fa = async (values: { password: string; otp: string }) => {
        setTwoFactorLoading(true);
        const result = await requestData<{ enabled: boolean }>(
            () => authApi.disableTwoFactor(values.password, values.otp),
            '禁用二次验证失败'
        );
        if (result) {
            message.success('二次验证已禁用');
            disable2FaForm.resetFields();
            await loadTwoFactorStatus();
        }
        setTwoFactorLoading(false);
    };

    const handleRunTokenRefresh = async () => {
        setTokenRefreshActionLoading(true);
        const result = await requestData<{ message?: string }>(
            () => emailApi.refreshTokens(),
            '启动 Token 刷新失败'
        );
        if (result) {
            message.success(result.message || 'Token 刷新任务已启动');
            await loadTokenRefreshStatus(true);
        }
        setTokenRefreshActionLoading(false);
    };

    const handleSaveTokenRefreshSettings = async () => {
        try {
            const values = await tokenRefreshForm.validateFields();
            setTokenRefreshSaveLoading(true);
            const result = await requestData<{ enabled: boolean; intervalHours: number; concurrency: number }>(
                () => emailApi.updateRefreshSettings({
                    enabled: Boolean(values.enabled),
                    intervalHours: Number(values.intervalHours),
                    concurrency: Number(values.concurrency),
                }),
                '保存 Token 自动刷新配置失败'
            );

            if (result) {
                message.success('Token 自动刷新配置已保存');
                tokenRefreshForm.setFieldsValue({
                    enabled: result.enabled,
                    intervalHours: result.intervalHours,
                    concurrency: result.concurrency,
                });
                await loadTokenRefreshStatus();
            }
        } finally {
            setTokenRefreshSaveLoading(false);
        }
    };

    const formatDateTime = (value: string | null | undefined) => {
        if (!value) {
            return '暂无';
        }
        return dayjs(value).format('YYYY-MM-DD HH:mm:ss');
    };

    const formatDuration = (durationMs: number | null | undefined) => {
        if (!durationMs || durationMs <= 0) {
            return '0 秒';
        }

        const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes === 0) {
            return `${totalSeconds} 秒`;
        }

        return `${minutes} 分 ${seconds} 秒`;
    };

    const progressPercent = tokenRefreshStatus?.currentRun?.total
        ? Math.min(100, Math.round((tokenRefreshStatus.currentRun.completed / tokenRefreshStatus.currentRun.total) * 100))
        : 0;
    const activeRun = tokenRefreshStatus?.currentRun ?? null;
    const isAutoRefreshRunning = activeRun?.trigger === 'AUTO';
    const isManualRefreshRunning = activeRun?.trigger === 'MANUAL';
    const displayedFailures = activeRun?.recentFailures ?? tokenRefreshStatus?.recentFailures ?? [];

    return (
        <div>
            <Title level={4}>设置</Title>

            <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card title="个人信息">
                    <div style={{ display: 'grid', gap: 16 }}>
                        <div>
                            <Text type="secondary">用户名</Text>
                            <div style={{ fontSize: 16 }}>{admin?.username}</div>
                        </div>
                        <div>
                            <Text type="secondary">角色</Text>
                            <div style={{ fontSize: 16 }}>
                                {getAdminRoleLabel(admin?.role)}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card title="修改密码">
                    <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleChangePassword}
                        style={{ maxWidth: 400 }}
                    >
                        <Form.Item
                            name="oldPassword"
                            label="当前密码"
                            rules={[{ required: true, message: '请输入当前密码' }]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="当前密码" />
                        </Form.Item>

                        <Form.Item
                            name="newPassword"
                            label="新密码"
                            rules={[
                                { required: true, message: '请输入新密码' },
                                { min: 6, message: '密码至少 6 个字符' },
                            ]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="新密码" />
                        </Form.Item>

                        <Form.Item
                            name="confirmPassword"
                            label="确认新密码"
                            rules={[
                                { required: true, message: '请确认新密码' },
                                ({ getFieldValue }) => ({
                                    validator(_, value) {
                                        if (!value || getFieldValue('newPassword') === value) {
                                            return Promise.resolve();
                                        }
                                        return Promise.reject(new Error('两次输入的密码不一致'));
                                    },
                                }),
                            ]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
                        </Form.Item>

                        <Form.Item>
                            <Button type="primary" htmlType="submit" loading={passwordLoading}>
                                修改密码
                            </Button>
                        </Form.Item>
                    </Form>
                </Card>

                <Card title="二次验证（2FA）">
                    {twoFactorStatusLoading ? (
                        <Text type="secondary">加载中...</Text>
                    ) : (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                            <div>
                                <Text type="secondary">当前状态：</Text>{' '}
                                {twoFactorStatus.enabled ? <Tag color="success">已启用</Tag> : <Tag>未启用</Tag>}
                                {twoFactorStatus.pending && !twoFactorStatus.enabled ? <Tag color="processing">待验证</Tag> : null}
                            </div>

                            {twoFactorStatus.legacyEnv ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    message="当前账号使用环境变量 2FA（ADMIN_2FA_SECRET），暂不支持在界面中直接管理。"
                                />
                            ) : null}

                            {!twoFactorStatus.enabled ? (
                                <Button
                                    type="primary"
                                    icon={<SafetyCertificateOutlined />}
                                    onClick={handleSetup2Fa}
                                    loading={twoFactorLoading}
                                >
                                    生成绑定密钥
                                </Button>
                            ) : null}

                            {setupData ? (
                                <Card size="small" title="绑定信息">
                                    <Space direction="vertical" style={{ width: '100%' }}>
                                        <div style={{ textAlign: 'center' }}>
                                            <Text type="secondary">扫码绑定（推荐）</Text>
                                            <div style={{ marginTop: 8 }}>
                                                <QRCode value={setupData.otpauthUrl} size={180} />
                                            </div>
                                        </div>
                                        <div>
                                            <Text type="secondary">手动密钥（可复制）</Text>
                                            <div><Text copyable>{setupData.secret}</Text></div>
                                        </div>
                                        <div>
                                            <Text type="secondary">otpauth 链接（可复制）</Text>
                                            <div><Text copyable>{setupData.otpauthUrl}</Text></div>
                                        </div>
                                        <Input
                                            value={enableOtp}
                                            onChange={(e) => setEnableOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            placeholder="输入验证器中的 6 位验证码"
                                            maxLength={6}
                                            prefix={<SafetyCertificateOutlined />}
                                        />
                                        <Button type="primary" onClick={handleEnable2Fa} loading={twoFactorLoading}>
                                            启用二次验证
                                        </Button>
                                    </Space>
                                </Card>
                            ) : null}

                            {twoFactorStatus.enabled ? (
                                <Card size="small" title="禁用二次验证">
                                    <Form form={disable2FaForm} layout="vertical" onFinish={handleDisable2Fa}>
                                        <Form.Item
                                            name="password"
                                            label="当前密码"
                                            rules={[{ required: true, message: '请输入当前密码' }]}
                                        >
                                            <Input.Password prefix={<LockOutlined />} placeholder="当前密码" />
                                        </Form.Item>
                                        <Form.Item
                                            name="otp"
                                            label="验证码"
                                            rules={[
                                                { required: true, message: '请输入验证码' },
                                                { pattern: /^\d{6}$/, message: '请输入 6 位验证码' },
                                            ]}
                                        >
                                            <Input
                                                maxLength={6}
                                                prefix={<SafetyCertificateOutlined />}
                                                placeholder="6 位验证码"
                                            />
                                        </Form.Item>
                                        <Form.Item style={{ marginBottom: 0 }}>
                                            <Button danger htmlType="submit" loading={twoFactorLoading}>
                                                禁用二次验证
                                            </Button>
                                        </Form.Item>
                                    </Form>
                                </Card>
                            ) : null}
                        </Space>
                    )}
                </Card>

                <Card title="Token 自动刷新">
                    {tokenRefreshStatusLoading ? (
                        <Text type="secondary">加载中...</Text>
                    ) : tokenRefreshStatus ? (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                            <div>
                                <Text type="secondary">自动任务：</Text>{' '}
                                {tokenRefreshStatus.enabled ? <Tag color="success">已启用</Tag> : <Tag>已停用</Tag>}
                                {isAutoRefreshRunning ? <Tag color="processing">自动执行中</Tag> : null}
                                {isManualRefreshRunning ? <Tag color="processing">手动任务运行中</Tag> : null}
                                {!tokenRefreshStatus.isRunning ? <Tag>空闲</Tag> : null}
                            </div>

                            <div style={{ display: 'grid', gap: 12 }}>
                                <div>
                                    <Text type="secondary">当前配置</Text>
                                    <div style={{ fontSize: 16 }}>
                                        每 {tokenRefreshStatus.intervalHours} 小时执行一次，并发 {tokenRefreshStatus.concurrency}
                                    </div>
                                </div>
                                <div>
                                    <Text type="secondary">上次完成</Text>
                                    <div style={{ fontSize: 16 }}>{formatDateTime(tokenRefreshStatus.lastRunAt)}</div>
                                </div>
                                <div>
                                    <Text type="secondary">下次计划</Text>
                                    <div style={{ fontSize: 16 }}>
                                        {!tokenRefreshStatus.enabled
                                            ? '自动任务已停用'
                                            : isAutoRefreshRunning
                                                ? '当前自动任务执行中，完成后重新计算'
                                                : isManualRefreshRunning
                                                    ? '当前有手动刷新任务运行中，自动任务将在空闲后继续调度'
                                                : formatDateTime(tokenRefreshStatus.nextRunAt)}
                                    </div>
                                </div>
                            </div>

                            {tokenRefreshStatus.lastResult ? (
                                <Alert
                                    type={tokenRefreshStatus.lastResult.failed > 0 ? 'warning' : 'success'}
                                    showIcon
                                    message={`最近一次自动完成: 成功 ${tokenRefreshStatus.lastResult.success} / 失败 ${tokenRefreshStatus.lastResult.failed} / 总计 ${tokenRefreshStatus.lastResult.total}`}
                                    description={`完成时间 ${formatDateTime(tokenRefreshStatus.lastRunAt)}，耗时 ${formatDuration(tokenRefreshStatus.lastResult.durationMs)}`}
                                />
                            ) : (
                                <Text type="secondary">暂无执行记录</Text>
                            )}

                            {isManualRefreshRunning ? (
                                <Alert
                                    type="info"
                                    showIcon
                                    message="当前有手动刷新任务运行中"
                                    description={`触发人 ${activeRun?.requestedByUsername || '未知管理员'}，范围 ${activeRun?.groupId ? `分组 #${activeRun.groupId}` : '全部未禁用邮箱'}。本页的“最近一次自动完成”只统计自动任务。`}
                                />
                            ) : null}

                            {activeRun ? (
                                <Card size="small" title={activeRun.trigger === 'AUTO' ? '当前自动任务进度' : '当前手动任务进度'}>
                                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                                        <Progress
                                            percent={progressPercent}
                                            status="active"
                                            format={() => `${activeRun.completed} / ${activeRun.total}`}
                                        />
                                        <div style={{ display: 'grid', gap: 12 }}>
                                            <div>
                                                <Text type="secondary">触发方式</Text>
                                                <div style={{ fontSize: 16 }}>
                                                    {activeRun.trigger === 'AUTO' ? '系统自动调度' : `管理员手动触发${activeRun.requestedByUsername ? `（${activeRun.requestedByUsername}）` : ''}`}
                                                </div>
                                            </div>
                                            <div>
                                                <Text type="secondary">执行范围</Text>
                                                <div style={{ fontSize: 16 }}>
                                                    {activeRun.groupId ? `分组 #${activeRun.groupId}` : '全部未禁用邮箱'}
                                                </div>
                                            </div>
                                            <div>
                                                <Text type="secondary">开始时间</Text>
                                                <div style={{ fontSize: 16 }}>{formatDateTime(activeRun.startedAt)}</div>
                                            </div>
                                            <div>
                                                <Text type="secondary">已运行</Text>
                                                <div style={{ fontSize: 16 }}>{formatDuration(activeRun.durationMs)}</div>
                                            </div>
                                            <div>
                                                <Text type="secondary">当前统计</Text>
                                                <div style={{ fontSize: 16 }}>
                                                    成功 {activeRun.success} / 失败 {activeRun.failed} / 待处理 {Math.max(0, activeRun.total - activeRun.completed)}
                                                </div>
                                            </div>
                                        </div>
                                    </Space>
                                </Card>
                            ) : null}

                            <Card
                                size="small"
                                title={activeRun
                                    ? activeRun.trigger === 'AUTO' ? '当前自动任务最近失败' : '当前手动任务最近失败'
                                    : '最近一次自动任务失败'}
                            >
                                {displayedFailures.length > 0 ? (
                                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                                        {displayedFailures.map((failure) => (
                                            <div
                                                key={`${failure.emailId}-${failure.email}-${failure.message}`}
                                                style={{
                                                    padding: 12,
                                                    border: '1px solid #f0f0f0',
                                                    borderRadius: 8,
                                                    background: '#fff',
                                                }}
                                            >
                                                <div style={{ fontWeight: 500, marginBottom: 4 }}>{failure.email}</div>
                                                <Text type="secondary">{failure.message}</Text>
                                            </div>
                                        ))}
                                    </Space>
                                ) : (
                                    <Text type="secondary">
                                        {activeRun ? '当前任务暂无失败记录' : '最近没有自动任务失败记录'}
                                    </Text>
                                )}
                            </Card>

                            <Space wrap>
                                <Button
                                    icon={<ReloadOutlined />}
                                    onClick={() => void loadTokenRefreshStatus()}
                                    loading={tokenRefreshStatusLoading}
                                >
                                    刷新状态
                                </Button>
                                <Button
                                    type="primary"
                                    icon={<SyncOutlined spin={tokenRefreshActionLoading || tokenRefreshStatus.isRunning} />}
                                    onClick={handleRunTokenRefresh}
                                    loading={tokenRefreshActionLoading}
                                    disabled={tokenRefreshStatus.isRunning}
                                >
                                    立即执行一次
                                </Button>
                            </Space>

                            <Card size="small" title="自动刷新配置">
                                <Form
                                    form={tokenRefreshForm}
                                    layout="vertical"
                                    initialValues={{
                                        enabled: tokenRefreshStatus.enabled,
                                        intervalHours: tokenRefreshStatus.intervalHours,
                                        concurrency: tokenRefreshStatus.concurrency,
                                    }}
                                >
                                    <Form.Item
                                        name="enabled"
                                        label="启用自动刷新"
                                        valuePropName="checked"
                                    >
                                        <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                                    </Form.Item>
                                    <Form.Item
                                        name="intervalHours"
                                        label="执行间隔（小时）"
                                        rules={[
                                            { required: true, message: '请输入执行间隔' },
                                            {
                                                validator: (_, value) => {
                                                    const num = Number(value);
                                                    if (Number.isInteger(num) && num >= 1 && num <= 24 * 30) {
                                                        return Promise.resolve();
                                                    }
                                                    return Promise.reject(new Error('请输入 1 到 720 之间的整数'));
                                                },
                                            },
                                        ]}
                                    >
                                        <InputNumber min={1} max={24 * 30} precision={0} style={{ width: '100%' }} />
                                    </Form.Item>
                                    <Form.Item
                                        name="concurrency"
                                        label="刷新并发数"
                                        rules={[
                                            { required: true, message: '请输入并发数' },
                                            {
                                                validator: (_, value) => {
                                                    const num = Number(value);
                                                    if (Number.isInteger(num) && num >= 1 && num <= 50) {
                                                        return Promise.resolve();
                                                    }
                                                    return Promise.reject(new Error('请输入 1 到 50 之间的整数'));
                                                },
                                            },
                                        ]}
                                    >
                                        <InputNumber min={1} max={50} precision={0} style={{ width: '100%' }} />
                                    </Form.Item>
                                    <Form.Item style={{ marginBottom: 0 }}>
                                        <Button
                                            type="primary"
                                            onClick={handleSaveTokenRefreshSettings}
                                            loading={tokenRefreshSaveLoading}
                                            disabled={tokenRefreshStatus.isRunning}
                                        >
                                            保存自动刷新配置
                                        </Button>
                                    </Form.Item>
                                </Form>
                            </Card>

                            <Alert
                                type="info"
                                showIcon
                                message="配置保存后立即生效"
                                description="自动任务会根据新配置重新安排下一次执行，运行中的任务不会被强制中断。"
                            />
                        </Space>
                    ) : (
                        <Text type="secondary">暂无数据</Text>
                    )}
                </Card>

                <Card title="API 使用说明">
                    <div style={{ marginBottom: 16 }}>
                        <Text strong>外部 API 调用方式</Text>
                    </div>

                    <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginBottom: 16 }}>
                        <Text code style={{ display: 'block', marginBottom: 8 }}>
                            # 通过 Header 传递 API Key
                        </Text>
                        <Text code style={{ display: 'block', wordBreak: 'break-all' }}>
                            curl -H "X-API-Key: your_api_key" https://your-domain.com/api/mail_all
                        </Text>
                    </div>

                    <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8 }}>
                        <Text code style={{ display: 'block', marginBottom: 8 }}>
                            # 通过 Query 参数传递 API Key
                        </Text>
                        <Text code style={{ display: 'block', wordBreak: 'break-all' }}>
                            curl "https://your-domain.com/api/mail_all?api_key=your_api_key&email=xxx@outlook.com"
                        </Text>
                    </div>
                </Card>
            </Space>
        </div>
    );
};

export default SettingsPage;
