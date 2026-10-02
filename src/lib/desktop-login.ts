import type { NativeBridge } from "./desktop-export.js";
import { resolveHost, type HostId } from "./host.js";
import { snapshotFromBatch } from "./image-api.js";

interface LoginOptions {
  signal: AbortSignal;
  onChecking?: (checking: boolean) => void;
  onError?: (message: string) => void;
  subscribeRetry?: (retry: () => void) => () => void;
  retryIntervalMs?: number;
}

/** Check the saved session immediately. Only pending authentication is polled;
 * transport/response failures remain visible until the user explicitly retries. */
export async function waitForDesktopLogin(
  hostId: HostId,
  bridge: NativeBridge,
  options: LoginOptions,
): Promise<void> {
  const { signal } = options;
  const active = () => {
    if (signal.aborted) throw Error("操作已取消");
  };
  let wake: (() => void) | undefined;
  const unsubscribe = options.subscribeRetry?.(() => wake?.());
  const waitForRetry = (automatic: boolean) =>
    new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        wake = undefined;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(Error("操作已取消"));
      wake = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      if (automatic)
        timer = setTimeout(() => finish(), options.retryIntervalMs ?? 2000);
      if (signal.aborted) abort();
    });
  try {
    while (true) {
      active();
      options.onChecking?.(true);
      let failure: string | undefined;
      try {
        const response = await bridge<string>("api_json", {
          path: "/api/v2/batch/check/0",
        });
        active();
        try {
          snapshotFromBatch(JSON.parse(response), {
            host: resolveHost(hostId),
            cookies: {},
            fetchImpl: fetch,
          });
        } catch {
          throw Error("登录会话未返回有效任务数据，请重新检查登录状态。");
        }
      } catch (error) {
        active();
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        options.onChecking?.(false);
      }
      if (failure === undefined) return;
      options.onError?.(failure);
      await waitForRetry(/尚未登录|登录失效|需要验证/.test(failure));
    }
  } finally {
    unsubscribe?.();
  }
}
