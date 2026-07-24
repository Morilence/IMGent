export type SupportedLocale = "zh-CN" | "en-US";

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const satisfies readonly SupportedLocale[];
