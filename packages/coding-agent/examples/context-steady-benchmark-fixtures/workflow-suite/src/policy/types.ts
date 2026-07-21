export interface PolicyRequest {
	accountId: string;
	region: string;
	amount: number;
	mfaVerified: boolean;
	serviceAccount: boolean;
}

export interface PolicyConfig {
	emergencyFreeze: boolean;
	suspendedAccounts: string[];
	accountLimits: Record<string, number>;
	regionLimits: Record<string, number>;
	defaultLimit: number;
}

export interface PolicyDecision {
	allowed: boolean;
	reason: string;
	limit: number;
	source: "account" | "default" | "freeze" | "region" | "suspension";
}
