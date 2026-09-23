export const Codes = {
  NAV_TIMEOUT: "NAV_TIMEOUT",
  BROWSER_CRASH: "BROWSER_CRASH",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  LOGIN_FAILED: "LOGIN_FAILED",
  ROBOTS_DISALLOWED: "ROBOTS_DISALLOWED",
  ASSET_TOO_LARGE: "ASSET_TOO_LARGE",
  NODE_LIMIT: "NODE_LIMIT",
  PROJECT_SIZE_LIMIT: "PROJECT_SIZE_LIMIT",
  AI_RATE_LIMIT: "AI_RATE_LIMIT",
  AI_AUTH: "AI_AUTH",
  AI_BAD_CONFIG: "AI_BAD_CONFIG",
  AI_BAD_RESPONSE: "AI_BAD_RESPONSE",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
} as const;

export type Code = keyof typeof Codes;

export class AppError extends Error {
  constructor(public code: Code, message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
  }
}
