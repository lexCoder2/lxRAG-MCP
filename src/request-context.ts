import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  sessionId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return requestContextStorage.getStore() || {};
}
