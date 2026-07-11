import * as os from "node:os";

const MAX_AUDIT_ERROR_CHARS = 400;
const SECRET_PATTERNS = [
	/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/gu,
	/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/gu,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/gu,
	/github_pat_[A-Za-z0-9_]{20,}/gu,
	/npm_[A-Za-z0-9]{30,}/gu,
	/xox[baprs]-[A-Za-z0-9-]{10,}/gu,
	/AIza[A-Za-z0-9_-]{30,}/gu,
];

export function sanitizeSanBrainAuditError(value: string): string {
	let sanitized = value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
	const home = os.homedir();
	if (home) sanitized = sanitized.replaceAll(home, "~");
	return sanitized.replace(/\s+/gu, " ").trim().slice(0, MAX_AUDIT_ERROR_CHARS);
}
