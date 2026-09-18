/**
 * i18n 入口：语言检测 + vue-i18n 实例 + 语言持久化。
 * 语言优先级：localStorage 记录 > 浏览器/系统语言（zh 开头 → 中文，否则英文）。
 */
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN";
import enUS from "./en-US";

export type AppLocale = "zh-CN" | "en-US";

const STORAGE_KEY = "md-reader-locale";

/** 启动语言检测：已保存的合法值优先，否则按浏览器语言推断。 */
function detectLocale(): AppLocale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en-US") return saved;
  const lang = navigator.language.toLowerCase();
  return lang.startsWith("zh") ? "zh-CN" : "en-US";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en-US",
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
});

/** 用户手动切换语言时持久化，下次启动恢复。 */
export function persistLocale(locale: AppLocale) {
  localStorage.setItem(STORAGE_KEY, locale);
}
