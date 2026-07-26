import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { applySanBrainMutation } from "@san/coding-agent/brain/commands";
import {
	appendSanBrainProfileCandidate,
	appendSanBrainProjection,
	appendSanBrainProjectionNotification,
} from "@san/coding-agent/brain/ledger";
import { buildSanBrainDebugReportText } from "@san/coding-agent/brain/render";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import type { SanBrainProfileCandidate } from "@san/coding-agent/brain/types";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

const profile: SanBrainProfileCandidate = {
	schemaVersion: 1,
	candidateId: "debug-profile",
	scope: { kind: "user", key: "user:local", resolverVersion: 1 },
	type: "user_preference",
	subject: "delivery",
	predicate: "format",
	value: "HTML",
	claimKey: "delivery:format",
	dedupeKey: "delivery:format:html",
	taskTags: [],
	confidence: 0.92,
	importance: 0.8,
	independentEvidenceCount: 1,
	sensitivity: "normal",
	evidence: [],
	createdAt: "2026-07-11T08:00:00.000Z",
};

describe("San Brain projection debug read model", () => {
	it("joins owner pointers and renders redacted, bounded, read-only audit details", () => {
		using tempDir = TempDir.createSync("@san-brain-debug-");
		const manager = SessionManager.inMemory(tempDir.path());
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			appendSanBrainProfileCandidate(manager, profile);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, {
				action: "approve",
				id: profile.candidateId,
				createdAt: "2026-07-11T08:01:00.000Z",
			});
			const decision = mutation.decisions[0];
			const projectionId = decision?.projectionIds[0];
			if (!decision || !projectionId) throw new Error("Expected a memory projection.");
			const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId,
				decisionId: decision.decisionId,
				target: "memory",
				state: "blocked",
				attemptCount: 1,
				revision: 1,
				errorCode: "backend_unavailable",
				error: `backend failed at ${os.homedir()}/private\t${token}`,
				durationMs: 37,
				receiptId: "private-receipt-id",
				updatedAt: "2026-07-11T08:02:00.000Z",
			});
			appendSanBrainProjectionNotification(manager, {
				schemaVersion: 1,
				projectionId,
				notifiedAt: "2026-07-11T08:03:00.000Z",
			});
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const entryCount = manager.getEntries().length;

			const report = buildSanBrainDebugReportText(store, "blocked");

			expect(report).toContain("total=1");
			expect(report).toContain(`decision=${decision.decisionId}`);
			expect(report).toContain("owner=debug-profile");
			expect(report).toContain("errorCode=backend_unavailable");
			expect(report).toContain("duration=37ms");
			expect(report).toContain("receipt=present");
			expect(report).toContain("notified=yes");
			expect(report).toContain("~/private [REDACTED]");
			expect(report).not.toContain(os.homedir());
			expect(report).not.toContain(token);
			expect(report).not.toContain("private-receipt-id");
			expect(report).not.toContain("\t");
			expect(manager.getEntries()).toHaveLength(entryCount);
		} finally {
			store.close();
		}
	});
});
