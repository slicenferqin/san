/**
 * San RPC v2 Interaction DTOs.
 *
 * Interactions are recoverable, typed user-input requests that persist
 * across reconnections. Non-blocking presentation uses notifications instead.
 */

import type { InteractionId, RunId, SessionId } from "../protocol/ids";
import type { InteractionStatus, MutationMeta, Timestamp } from "../protocol/lifecycle";

// ============================================================================
// Interaction Request
// ============================================================================

export interface InteractionRequest {
	schemaVersion: 1;
	interactionId: InteractionId;
	sessionId: SessionId;
	runId?: RunId;
	createdAt: Timestamp;
	deadline?: Timestamp;
	status: InteractionStatus;
	source: InteractionSource;
	title: string;
	prompt?: string;
	request: InteractionRequestUnion;
}

export interface InteractionSource {
	kind: "extension" | "provider_auth" | "san";
	id?: string;
	label: string;
}

export type InteractionRequestUnion =
	| InteractionSelectRequest
	| InteractionConfirmRequest
	| InteractionInputRequest
	| InteractionEditorRequest
	| InteractionOpenUrlRequest
	| InteractionPlanRequest;

export interface InteractionSelectRequest {
	kind: "select";
	options: InteractionOption[];
	multiple: boolean;
	min?: number;
	max?: number;
}

export interface InteractionConfirmRequest {
	kind: "confirm";
	confirmLabel?: string;
	cancelLabel?: string;
	severity?: "normal" | "danger";
}

export interface InteractionInputRequest {
	kind: "input";
	initialValue?: string;
	placeholder?: string;
	sensitive: boolean;
	validation?: InputValidation;
}

export interface InteractionEditorRequest {
	kind: "editor";
	initialValue: string;
	language?: string;
	validation?: InputValidation;
}

export interface InteractionOpenUrlRequest {
	kind: "open_url";
	url: string;
	launchUrl?: string;
	instructions?: string;
}

/** Plan-mode proposal review: the agent's finalized plan, presented for an
 *  approve/refine/exit decision. `options` carries the decision affordances
 *  (e.g. approve / refine / exit); a refine decision may carry free-text
 *  feedback in the response. */
export interface InteractionPlanRequest {
	kind: "plan";
	planFilePath: string;
	title: string;
	content: string;
	truncated?: boolean;
	options: InteractionOption[];
}

export interface InteractionOption {
	id: string;
	label: string;
	description?: string;
	disabled?: boolean;
}

export interface InputValidation {
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	patternDescription?: string;
}

// ============================================================================
// Interaction Response
// ============================================================================

export interface SessionInteractionResponseParams {
	sessionId: SessionId;
	leaseId: string;
	interactionId: InteractionId;
	response: InteractionResponseUnion;
	meta: MutationMeta;
}

export interface AuthInteractionResponseParams {
	interactionId: InteractionId;
	response: InteractionResponseUnion;
	meta: MutationMeta;
}

export type InteractionResponseParams = SessionInteractionResponseParams | AuthInteractionResponseParams;

export type InteractionResponseUnion =
	| { kind: "selected"; optionIds: string[] }
	| { kind: "confirmed"; value: boolean }
	| { kind: "submitted"; value: string }
	| { kind: "url_handled"; outcome: "opened" | "copied" | "cancelled" }
	| { kind: "plan_decision"; optionId: string; feedback?: string };
