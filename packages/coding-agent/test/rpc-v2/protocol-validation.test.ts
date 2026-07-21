import { describe, expect, test } from "bun:test";
import { RPC_V2_METHODS } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/methods";
import { paramsSchemaForMethod, RPC_V2_SCHEMA } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/schema";
import { validateRpcV2Params } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/validate";

describe("RPC v2 schema contract", () => {
	test("publishes params schemas for every routed method", () => {
		for (const method of RPC_V2_METHODS) expect(paramsSchemaForMethod(method), method).toBeDefined();
	});

	test("rejects missing, mistyped, and unknown fields from the shared schema", () => {
		expect(validateRpcV2Params("session.sync", { sessionId: "ses_1", leaseId: "lease_1" })).toEqual([]);
		expect(validateRpcV2Params("session.sync", { sessionId: "ses_1" })).toContainEqual({
			path: "params.leaseId",
			reason: "required",
			message: "Required field is missing",
		});
		expect(validateRpcV2Params("session.list", { limit: 0 })).toContainEqual({
			path: "params.limit",
			reason: "out_of_range",
			message: "Expected a value greater than or equal to 1",
		});
		expect(validateRpcV2Params("server.getHealth", { prompt: "must not be accepted" })).toContainEqual({
			path: "params.prompt",
			reason: "unknown_field",
			message: "Unknown field is not allowed",
		});
	});

	test("keeps the generated schema artifact byte-equivalent to the runtime schema", async () => {
		const generated = await Bun.file(new URL("../../src/modes/rpc-v2/rpc-v2.schema.json", import.meta.url)).json();
		expect(generated).toEqual(RPC_V2_SCHEMA);
	});
});
