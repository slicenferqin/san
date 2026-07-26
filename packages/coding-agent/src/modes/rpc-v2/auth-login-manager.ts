import { getOAuthProviders, type OAuthProviderInfo } from "@san/ai/oauth";
import type { InteractionRequest, InteractionResponseUnion } from "./dto/interaction";
import { validateInteractionResponse } from "./interaction-validation";
import { type InteractionId, type LoginId, newInteractionId, newLoginId, type RuntimeId } from "./protocol/ids";
import { sanitizeRpcError } from "./redaction";
import type { RpcV2RuntimeCatalog } from "./session-manager";

export type AuthLoginState = "starting" | "waiting_user" | "exchanging" | "completed" | "failed" | "cancelled";

export interface AuthLoginSnapshot {
	loginId: LoginId;
	providerId: string;
	state: AuthLoginState;
	startedAt: string;
	updatedAt: string;
	interactionId?: InteractionId;
	reason?: string;
}

interface PendingRuntimeInteraction {
	interaction: InteractionRequest;
	resolve: (response: InteractionResponseUnion) => void;
}

interface ActiveLogin {
	snapshot: AuthLoginSnapshot;
	abortController: AbortController;
	task: Promise<void>;
}

type OutputFn = (frame: object) => void;

/** Provider 登录状态机；只向协议输出 URL、状态和脱敏错误，不输出任何凭据。 */
export class AuthLoginManager {
	readonly #runtimeId: RuntimeId;
	readonly #catalog: RpcV2RuntimeCatalog;
	readonly #output: OutputFn;
	readonly #logins = new Map<string, ActiveLogin>();
	readonly #interactions = new Map<string, PendingRuntimeInteraction>();
	#closed = false;

	constructor(options: { runtimeId: RuntimeId; catalog: RpcV2RuntimeCatalog; output: OutputFn }) {
		this.#runtimeId = options.runtimeId;
		this.#catalog = options.catalog;
		this.#output = options.output;
	}

	listProviders(): Array<{
		providerId: string;
		name: string;
		available: boolean;
		authenticated: boolean;
		storesCredentialsAs?: string;
	}> {
		return getOAuthProviders().map(provider => {
			const credentialProvider = provider.storeCredentialsAs ?? provider.id;
			return {
				providerId: provider.id,
				name: provider.name,
				available: provider.available,
				authenticated: this.#catalog.hasProviderAuth(credentialProvider),
				...(provider.storeCredentialsAs ? { storesCredentialsAs: provider.storeCredentialsAs } : {}),
			};
		});
	}

	listLogins(): AuthLoginSnapshot[] {
		return [...this.#logins.values()].map(login => ({ ...login.snapshot }));
	}

	listInteractions(): InteractionRequest[] {
		return [...this.#interactions.values()].map(item => structuredClone(item.interaction));
	}

	start(providerId: string): AuthLoginSnapshot {
		if (this.#closed) throw new Error("Provider auth manager is closed");
		const provider = findProvider(providerId);
		if (!provider?.available) throw new Error(`OAuth provider is unavailable: ${providerId}`);
		const existing = [...this.#logins.values()].find(
			login => login.snapshot.providerId === providerId && !isTerminal(login.snapshot.state),
		);
		if (existing) return { ...existing.snapshot };

		const now = new Date().toISOString();
		const snapshot: AuthLoginSnapshot = {
			loginId: newLoginId(),
			providerId,
			state: "starting",
			startedAt: now,
			updatedAt: now,
		};
		const abortController = new AbortController();
		const active = { snapshot, abortController, task: Promise.resolve() } satisfies ActiveLogin;
		this.#logins.set(snapshot.loginId, active);
		this.#emitState(snapshot);
		active.task = this.#runLogin(active);
		return { ...snapshot };
	}

	cancel(loginId: string): AuthLoginSnapshot {
		const active = this.#logins.get(loginId);
		if (!active) throw new Error(`Provider login not found: ${loginId}`);
		if (isTerminal(active.snapshot.state)) return { ...active.snapshot };
		active.abortController.abort(new Error("Provider login cancelled by client"));
		for (const [interactionId, pending] of this.#interactions) {
			if (pending.interaction.source.id !== loginId) continue;
			this.#interactions.delete(interactionId);
			pending.resolve(cancelledResponse(pending.interaction));
			this.#emitInteractionCancelled(pending.interaction, "auth_login_cancelled");
		}
		this.#transition(active, "cancelled");
		return { ...active.snapshot };
	}

	respond(interactionId: string, value: unknown): InteractionRequest | undefined {
		const pending = this.#interactions.get(interactionId);
		if (!pending) return undefined;
		const response = validateInteractionResponse(pending.interaction, value);
		this.#interactions.delete(interactionId);
		pending.interaction.status = "answered";
		pending.resolve(response);
		this.#output({
			jsonrpc: "2.0",
			method: "interaction.answered",
			params: { interactionId, response, runtimeId: this.#runtimeId },
		});
		return structuredClone(pending.interaction);
	}

	cancelInteraction(interactionId: string, reason: string): InteractionRequest | undefined {
		const pending = this.#interactions.get(interactionId);
		if (!pending) return undefined;
		this.#interactions.delete(interactionId);
		pending.interaction.status = "cancelled";
		pending.resolve(cancelledResponse(pending.interaction));
		this.#emitInteractionCancelled(pending.interaction, reason);
		const loginId = pending.interaction.source.id;
		if (loginId) this.cancel(loginId);
		return structuredClone(pending.interaction);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const active of this.#logins.values())
			if (!isTerminal(active.snapshot.state)) this.cancel(active.snapshot.loginId);
		await Promise.all([...this.#logins.values()].map(active => active.task));
		this.#interactions.clear();
	}

	async #runLogin(active: ActiveLogin): Promise<void> {
		try {
			await this.#catalog.loginProvider(active.snapshot.providerId, {
				onAuth: info => {
					this.#transition(active, "waiting_user");
					this.#publishInteraction(active, {
						kind: "open_url",
						url: info.url,
						...(info.launchUrl ? { launchUrl: info.launchUrl } : {}),
						...(info.instructions ? { instructions: info.instructions } : {}),
					});
				},
				onProgress: () => {
					if (active.snapshot.state !== "cancelled") this.#transition(active, "exchanging");
				},
				onPrompt: async prompt => {
					this.#transition(active, "waiting_user");
					const response = await this.#requestInteraction(
						active,
						{
							kind: "input",
							placeholder: prompt.placeholder,
							sensitive: true,
							validation: { required: true },
						},
						prompt.message,
					);
					if (response.kind !== "submitted") throw new Error("Provider login input was cancelled");
					return response.value;
				},
				signal: active.abortController.signal,
			});
			if (active.abortController.signal.aborted) {
				this.#transition(active, "cancelled");
				return;
			}
			await this.#catalog.refreshModels();
			this.#transition(active, "completed");
		} catch (error: unknown) {
			if (active.abortController.signal.aborted) {
				this.#transition(active, "cancelled");
				return;
			}
			this.#transition(active, "failed", sanitizeRpcError(error, { maxChars: 500 }));
		}
	}

	#publishInteraction(active: ActiveLogin, request: InteractionRequest["request"]): void {
		const interactionId = newInteractionId();
		const interaction: InteractionRequest = {
			schemaVersion: 1,
			interactionId,
			sessionId: `runtime_${this.#runtimeId}` as InteractionRequest["sessionId"],
			createdAt: new Date().toISOString(),
			status: "pending",
			source: { kind: "provider_auth", id: active.snapshot.loginId, label: active.snapshot.providerId },
			title: `Sign in to ${active.snapshot.providerId}`,
			request,
		};
		active.snapshot = { ...active.snapshot, interactionId, updatedAt: new Date().toISOString() };
		this.#interactions.set(interactionId, { interaction, resolve: () => undefined });
		this.#output({
			jsonrpc: "2.0",
			method: "interaction.requested",
			params: { interaction, runtimeId: this.#runtimeId },
		});
	}

	#requestInteraction(
		active: ActiveLogin,
		request: InteractionRequest["request"],
		prompt: string,
	): Promise<InteractionResponseUnion> {
		const interactionId = newInteractionId();
		const interaction: InteractionRequest = {
			schemaVersion: 1,
			interactionId,
			sessionId: `runtime_${this.#runtimeId}` as InteractionRequest["sessionId"],
			createdAt: new Date().toISOString(),
			status: "pending",
			source: { kind: "provider_auth", id: active.snapshot.loginId, label: active.snapshot.providerId },
			title: `Sign in to ${active.snapshot.providerId}`,
			prompt,
			request,
		};
		const { promise, resolve } = Promise.withResolvers<InteractionResponseUnion>();
		this.#interactions.set(interactionId, { interaction, resolve });
		active.snapshot = { ...active.snapshot, interactionId, updatedAt: new Date().toISOString() };
		this.#output({
			jsonrpc: "2.0",
			method: "interaction.requested",
			params: { interaction, runtimeId: this.#runtimeId },
		});
		return promise;
	}

	#transition(active: ActiveLogin, state: AuthLoginState, reason?: string): void {
		if (isTerminal(active.snapshot.state) && active.snapshot.state !== state) return;
		active.snapshot = {
			...active.snapshot,
			state,
			updatedAt: new Date().toISOString(),
			...(reason ? { reason } : {}),
		};
		this.#emitState(active.snapshot);
	}

	#emitState(snapshot: AuthLoginSnapshot): void {
		this.#output({
			jsonrpc: "2.0",
			method: "auth.login.state.changed",
			params: { ...snapshot, runtimeId: this.#runtimeId },
		});
	}

	#emitInteractionCancelled(interaction: InteractionRequest, reason: string): void {
		this.#output({
			jsonrpc: "2.0",
			method: "interaction.cancelled",
			params: { interactionId: interaction.interactionId, reason, runtimeId: this.#runtimeId },
		});
	}
}

function findProvider(providerId: string): OAuthProviderInfo | undefined {
	return getOAuthProviders().find(provider => provider.id === providerId);
}

function isTerminal(state: AuthLoginState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function cancelledResponse(interaction: InteractionRequest): InteractionResponseUnion {
	switch (interaction.request.kind) {
		case "select":
			return { kind: "selected", optionIds: [] };
		case "confirm":
			return { kind: "confirmed", value: false };
		case "input":
		case "editor":
			return { kind: "submitted", value: "" };
		case "open_url":
			return { kind: "url_handled", outcome: "cancelled" };
	}
}
