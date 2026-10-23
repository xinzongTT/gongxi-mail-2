import { type FastifyPluginAsync } from 'fastify';
import { groupService } from './group.service.js';
import { createGroupSchema, updateGroupSchema, assignEmailsSchema } from './group.schema.js';

const groupRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由需要管理员认证
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 获取分组列表
    fastify.get('/', async () => {
        const groups = await groupService.list();
        return { success: true, data: groups };
    });

    // 获取分组详情
    fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
        const id = parseInt(request.params.id, 10);
        const group = await groupService.getById(id);
        return { success: true, data: group };
    });

    // 创建分组
    fastify.post('/', async (request) => {
        const input = createGroupSchema.parse(request.body);
        const group = await groupService.create(input);
        request.log.info({
            systemEvent: true,
            action: 'email_group.create',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: group.id,
            name: group.name,
        }, '新增邮箱分组');
        return { success: true, data: group };
    });

    // 更新分组
    fastify.put<{ Params: { id: string } }>('/:id', async (request) => {
        const id = parseInt(request.params.id, 10);
        const input = updateGroupSchema.parse(request.body);
        const group = await groupService.update(id, input);
        request.log.info({
            systemEvent: true,
            action: 'email_group.update',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: group.id,
            name: group.name,
        }, '修改邮箱分组');
        return { success: true, data: group };
    });

    // 删除分组
    fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
        const id = parseInt(request.params.id, 10);
        const result = await groupService.delete(id);
        request.log.info({
            systemEvent: true,
            action: 'email_group.delete',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: id,
        }, '删除邮箱分组');
        return { success: true, data: result };
    });

    // 分配邮箱到分组
    fastify.post<{ Params: { id: string } }>('/:id/assign', async (request) => {
        const id = parseInt(request.params.id, 10);
        const input = assignEmailsSchema.parse(request.body);
        const result = await groupService.assignEmails(id, input.emailIds);
        request.log.info({
            systemEvent: true,
            action: 'email_group.assign',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: id,
            emailIds: input.emailIds,
            updatedCount: result.count,
        }, '分配邮箱到分组');
        return { success: true, data: result };
    });

    // 从分组移除邮箱
    fastify.post<{ Params: { id: string } }>('/:id/remove', async (request) => {
        const id = parseInt(request.params.id, 10);
        const input = assignEmailsSchema.parse(request.body);
        const result = await groupService.removeEmails(id, input.emailIds);
        request.log.info({
            systemEvent: true,
            action: 'email_group.remove',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: id,
            emailIds: input.emailIds,
            updatedCount: result.count,
        }, '从分组移除邮箱');
        return { success: true, data: result };
    });
};

export default groupRoutes;
