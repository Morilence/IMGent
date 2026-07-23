import type { QrCodeResponse, QrStatus, QrStatusResponse } from "./protocol.js";

export interface WechatAuthorizationResult {
  botToken: string;
  platformBotId: string;
  authorizingPlatformUserId: string;
  baseUrl: string;
}

export interface WechatAuthorizationOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  verifyCode?: () => Promise<string>;
  onQr: (url: string) => Promise<void> | void;
  onStatus?: (status: QrStatus) => Promise<void> | void;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function validRedirect(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("微信 QR redirect_host 必须使用 HTTPS");
  return parsed.origin;
}

export async function authorizeWechatIlink(
  options: WechatAuthorizationOptions,
): Promise<WechatAuthorizationResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let qr = await requestQr(fetcher, baseUrl, options.signal);
  await options.onQr(qr.qrcode_img_content);
  let verifyCode: string | undefined;

  while (!options.signal?.aborted && Date.now() - startedAt < timeoutMs) {
    const query = new URLSearchParams({ qrcode: qr.qrcode });
    if (verifyCode) query.set("verify_code", verifyCode);
    const response = await fetcher(
      endpoint(baseUrl, `ilink/bot/get_qrcode_status?${query.toString()}`),
      options.signal ? { signal: options.signal } : {},
    );
    if (!response.ok) throw new Error(`微信 QR 状态请求失败: HTTP ${response.status}`);
    const status = (await response.json()) as QrStatusResponse;
    await options.onStatus?.(status.status);
    if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
        throw new Error("微信 QR confirmed 响应缺少授权字段");
      }
      return {
        botToken: status.bot_token,
        platformBotId: status.ilink_bot_id,
        authorizingPlatformUserId: status.ilink_user_id,
        baseUrl: status.baseurl ? validRedirect(status.baseurl) : baseUrl,
      };
    }
    if (status.status === "expired") {
      qr = await requestQr(fetcher, baseUrl, options.signal);
      await options.onQr(qr.qrcode_img_content);
      verifyCode = undefined;
    } else if (status.status === "scaned_but_redirect" || status.status === "binded_redirect") {
      if (!status.redirect_host) throw new Error("微信 QR redirect 状态缺少 redirect_host");
      baseUrl = validRedirect(status.redirect_host);
    } else if (status.status === "need_verifycode") {
      if (!options.verifyCode) throw new Error("微信授权需要验证码");
      verifyCode = (await options.verifyCode()).trim();
    } else if (status.status === "verify_code_blocked") {
      throw new Error("微信授权验证码已被限制，请稍后重试");
    }
  }
  throw new Error("微信 QR 授权超时或已取消");
}

async function requestQr(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<QrCodeResponse> {
  const response = await fetcher(endpoint(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local_token_list: [] }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`微信 QR 获取失败: HTTP ${response.status}`);
  const body = (await response.json()) as Partial<QrCodeResponse>;
  if (!body.qrcode || !body.qrcode_img_content) {
    throw new Error("微信 QR 响应缺少二维码字段");
  }
  return body as QrCodeResponse;
}
