import type { AbeiApi, AbeiCapability } from './abei-api.js';
import { HttpError } from './http-error.js';
import type { AiApproval, AiStore } from './store.js';
import { describeApproval, humanOnlyParams } from './tools.js';

/** 审批只用到 store 的这几件事，测试给个假的就够。 */
export type ApprovalStore = Pick<
  AiStore,
  'claimApproval' | 'rejectApproval' | 'finishApproval' | 'releaseApproval'
>;

/**
 * 人在页面上的确认落到这里：只有走过这一步才会带 confirm=true 打 abei-api。
 * 模型自己拿不到 confirm，也就绕不过这道闸。
 */
export async function decideApproval(args: {
  id: string;
  body: Record<string, unknown>;
  abei: AbeiApi;
  token: string;
  ownerKey: string;
  store: ApprovalStore;
}): Promise<AiApproval> {
  const catalog = await args.abei.catalog(args.token);
  if (args.body.decision === 'reject') {
    const rejected = await args.store.rejectApproval(args.id, args.ownerKey);
    if (!rejected) throw new HttpError(409, '审批已处理或不存在。');
    return describeApproval(rejected, catalog.byId(rejected.capability));
  }
  if (args.body.decision !== 'approve') {
    throw new HttpError(422, 'decision 必须是 approve 或 reject。');
  }

  const approval = await args.store.claimApproval(args.id, args.ownerKey);
  if (!approval) throw new HttpError(409, '审批已处理或不存在。');
  try {
    const capability = catalog.byId(approval.capability);
    if (!capability) throw new HttpError(409, `能力目录里已经没有 ${approval.capability} 了。`);
    const result = await args.abei.invoke({
      token: args.token,
      capability,
      params: { ...approval.input, ...pickUserInput(args.body.user_input, capability) },
      gate: { confirm: true },
    });
    return describeApproval(await args.store.finishApproval(approval.id, result), capability);
  } catch (error) {
    // 执行失败就把审批放回 pending，人可以改完再点一次。
    await args.store.releaseApproval(approval.id, error);
    throw error;
  }
}

/**
 * 页面回传的人填参数。只收这条能力声明为人填的字段，别的一律拒绝——
 * 审批端点不是任意改参数的后门。密码只在这里经手，不落日志、不进报错文本。
 */
export function pickUserInput(
  value: unknown,
  capability: Pick<AbeiCapability, 'id' | 'human_only'>,
): Record<string, unknown> {
  const expected = humanOnlyParams(capability);
  if (expected.length === 0) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(422, `${capability.id} 需要在受信界面填写${expected.join('、')}。`);
  }
  const submitted = value as Record<string, unknown>;
  const extra = Object.keys(submitted).filter((key) => !expected.includes(key));
  if (extra.length > 0) throw new HttpError(422, `user_input 只接受${expected.join('、')}。`);
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const field = submitted[key];
    if (typeof field !== 'string' || field === '') throw new HttpError(422, `请填写${key}。`);
    result[key] = field;
  }
  return result;
}
