import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MAX_CHARS = 2_000;
const SECRET_TOKEN_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
	/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/gu,
	/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu,
];
const SECRET_ASSIGNMENT =
	/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)\s*[:=]\s*([^\s,;]+)/giu;
const SECRET_QUERY =
	/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)=)[^&#\s]*/giu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export interface RpcRedactionOptions {
	cwd?: string;
	maxChars?: number;
	redactPaths?: boolean;
	trim?: boolean;
}

/** RPC 对外文本统一脱敏：凭据、控制字符和本机绝对路径不得进入协议事实。 */
export function sanitizeRpcText(value: string, options: RpcRedactionOptions = {}): string {
	let sanitized = value.replace(CONTROL_CHARACTERS, " ");
	for (const pattern of SECRET_TOKEN_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
	sanitized = sanitized.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]").replace(SECRET_QUERY, "$1[REDACTED]");

	if (options.redactPaths !== false) {
		if (options.cwd) {
			const cwd = path.resolve(options.cwd);
			if (cwd.length > 1) sanitized = sanitized.replaceAll(cwd, ".");
		}
		const home = os.homedir();
		if (home.length > 1) sanitized = sanitized.replaceAll(home, "~");
		sanitized = sanitized.replace(/~{2,}(?=\/)/gu, "~");
	}

	return (options.trim === false ? sanitized : sanitized.trim()).slice(0, options.maxChars ?? DEFAULT_MAX_CHARS);
}

export function sanitizeRpcError(error: unknown, options: RpcRedactionOptions = {}): string {
	return sanitizeRpcText(error instanceof Error ? error.message : String(error), options);
}
