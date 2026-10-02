import test from "node:test";
import assert from "node:assert/strict";
import * as login from "../lib/desktop-login.js";
import type { NativeBridge } from "../lib/desktop-export.js";

const valid = JSON.stringify({
  inboxId: "i",
  projectProfiles: [],
  syncTaskBean: { update: [] },
});
const waitForLogin = (...args: any[]) => {
  assert.equal(typeof (login as any).waitForDesktopLogin, "function");
  return (login as any).waitForDesktopLogin(...args);
};

test("已有登录会话立即通过检查，无需重新登录或点击", async () => {
  let calls = 0,
    removed = false;
  const checking: boolean[] = [];
  const bridge: NativeBridge = async () => {
    calls++;
    return valid as any;
  };
  await waitForLogin("dida365", bridge, {
    signal: new AbortController().signal,
    onChecking: (value: boolean) => checking.push(value),
    subscribeRetry: () => () => {
      removed = true;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(checking, [true, false]);
  assert.equal(removed, true);
});

test("连接失败显示原因并停止自动重试，手动继续不产生并行检查", async () => {
  let retry: () => void = () => {},
    calls = 0,
    active = 0,
    maxActive = 0;
  const controller = new AbortController();
  let reported!: () => void;
  const failure = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const checking: boolean[] = [];
  const bridge: NativeBridge = async () => {
    calls++;
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (calls === 1) throw "无法连接官方接口，请检查网络或代理";
    return valid as any;
  };
  const pending = waitForLogin("dida365", bridge, {
    signal: controller.signal,
    retryIntervalMs: 2,
    subscribeRetry: (callback: () => void) => {
      retry = callback;
      return () => {};
    },
    onChecking: (value: boolean) => checking.push(value),
    onError: (error: unknown) => {
      assert.match(String(error), /网络或代理/);
      reported();
    },
  });
  await failure;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  retry();
  retry();
  await pending;
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(checking, [true, false, true, false]);
});

test("尚未登录会自动继续检测，完成后仅通过一次", async () => {
  let calls = 0;
  const bridge: NativeBridge = async () => {
    if (++calls === 1) throw "尚未登录；请在官方页面完成登录或验证";
    return valid as any;
  };
  await waitForLogin("ticktick", bridge, {
    signal: new AbortController().signal,
    retryIntervalMs: 1,
  });
  assert.equal(calls, 2);
});

test("等待手动重试时取消立即退出并解除按钮监听", async () => {
  const controller = new AbortController();
  let removed = false;
  const bridge: NativeBridge = async () => {
    throw "官方接口超时，请重试";
  };
  const pending = waitForLogin("dida365", bridge, {
    signal: controller.signal,
    subscribeRetry: () => () => {
      removed = true;
    },
    onError: () => setTimeout(() => controller.abort(), 0),
  });
  await assert.rejects(pending, /取消/);
  assert.equal(removed, true);
});
