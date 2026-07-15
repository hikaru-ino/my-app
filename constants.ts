export const ALLOWED_EMAIL_DOMAINS = ["keio.jp"];

export function isAllowedEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain ?? "");
}
