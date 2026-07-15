export const ALLOWED_EMAIL_DOMAINS = ["keio.jp"];

export function isAllowedEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain ?? "");
}

export const BOOK_CONDITIONS = ["新品", "良好", "可"];

export function isAllowedCondition(condition: string): boolean {
  return BOOK_CONDITIONS.includes(condition);
}
