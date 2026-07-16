export const ALLOWED_EMAIL_DOMAINS = ["keio.jp"];

export function isAllowedEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain ?? "");
}

export const BOOK_CONDITIONS = ["新品", "良好", "可"];

export function isAllowedCondition(condition: string): boolean {
  return BOOK_CONDITIONS.includes(condition);
}

export const CAMPUS_LABELS: Record<string, string> = {
  MITA: "三田",
  HIYOSHI: "日吉",
  YAGAMI: "矢上",
  SFC: "SFC",
  SHINANOMACHI: "信濃町",
};

export const CAMPUSES = Object.keys(CAMPUS_LABELS);

export function isAllowedCampus(campus: string): boolean {
  return campus in CAMPUS_LABELS;
}

export const REVIEW_SCORE_MIN = 1;
export const REVIEW_SCORE_MAX = 5;

export function isAllowedScore(score: number): boolean {
  return Number.isInteger(score) && score >= REVIEW_SCORE_MIN && score <= REVIEW_SCORE_MAX;
}
