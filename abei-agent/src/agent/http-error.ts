import { FireflyHttpError } from '../core/errors.js';
import { AbeiProblemError, AbeiUnavailableError } from './abei-api.js';

/** 带状态码的对外错误。消息是给用户看的，所以不放上游细节，也不放凭证。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 各种异常映射成对外状态码与人话，路由层和聊天流共用一份口径。
 * 放在这里而不是路由层，是因为流一旦开始就只能把消息塞进事件里，
 * 但那句话得和 JSON 错误体说的一样。
 */
export function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  // abei-api 的 problem 状态码原样透出去，页面据此分支（401 重新登录、409 冲突等）。
  if (error instanceof AbeiProblemError) return error.status;
  if (error instanceof AbeiUnavailableError) return 502;
  if (error instanceof FireflyHttpError && error.status === 401) return 401;
  return 500;
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof AbeiProblemError) return error.message;
  if (error instanceof AbeiUnavailableError) return 'abei-api 暂时连不上，稍后再试。';
  if (error instanceof FireflyHttpError) {
    if (error.status === 401) return 'Firefly 令牌无效或已过期。';
    if (error.status === 403) return '当前 Firefly 用户没有执行此操作的权限。';
    return `Firefly 请求失败（${error.status}）。`;
  }
  return 'AI 服务内部错误。';
}
