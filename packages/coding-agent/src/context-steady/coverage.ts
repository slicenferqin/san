import type {
	ContextPlanAudit,
	ContextPlanCoverageValidationIssue,
	ContextPlanCoverageValidationResult,
	ContextPlanMaterial,
	ContextSourceIndex,
} from "./plan-types";

function materialAuditById(audit: ContextPlanAudit): Map<string, ContextPlanAudit["materials"][number]> {
	return new Map(audit.materials.map(material => [material.materialId, material]));
}

function runtimeMaterialById(materials: readonly ContextPlanMaterial[]): Map<string, ContextPlanMaterial> {
	return new Map(materials.map(material => [material.audit.materialId, material]));
}

function sourceEntryIds(sourceIndex: ContextSourceIndex): Set<string> {
	return new Set(sourceIndex.entryIds);
}

export function validateContextPlanCoverage(options: {
	audit: ContextPlanAudit;
	materials: readonly ContextPlanMaterial[];
	sourceIndex: ContextSourceIndex;
}): ContextPlanCoverageValidationResult {
	const auditMaterials = materialAuditById(options.audit);
	const runtimeMaterials = runtimeMaterialById(options.materials);
	const sourceRefs = sourceEntryIds(options.sourceIndex);
	const issues: ContextPlanCoverageValidationIssue[] = [];
	const coveredEntryRefs = new Set<string>();

	for (const material of options.materials) {
		const auditMaterial = auditMaterials.get(material.audit.materialId);
		if (!auditMaterial) {
			issues.push({
				code: "material_audit_missing",
				message: `Material ${material.audit.materialId} is missing from audit materials.`,
				materialId: material.audit.materialId,
			});
			continue;
		}
		if (
			auditMaterial.representation !== material.audit.representation ||
			auditMaterial.kind !== material.audit.kind
		) {
			issues.push({
				code: "material_audit_mismatch",
				message: `Material ${material.audit.materialId} runtime metadata does not match audit metadata.`,
				materialId: material.audit.materialId,
			});
		}
	}

	for (const coverage of options.audit.coverage) {
		const material = runtimeMaterials.get(coverage.replacementMaterialId);
		if (!material) {
			issues.push({
				code: "coverage_without_material",
				message: `Coverage references missing replacement material ${coverage.replacementMaterialId}.`,
				materialId: coverage.replacementMaterialId,
			});
			continue;
		}
		const materialCoveredRefs = new Set(material.coveredEntryRefs);
		for (const entryRef of coverage.sourceEntryRefs) {
			if (!sourceRefs.has(entryRef)) {
				issues.push({
					code: "coverage_missing_source_ref",
					message: `Coverage source entry ${entryRef} is not present in the source index.`,
					materialId: coverage.replacementMaterialId,
					entryRef,
				});
				continue;
			}
			if (!materialCoveredRefs.has(entryRef)) {
				issues.push({
					code: "coverage_outside_material",
					message: `Coverage source entry ${entryRef} is not covered by replacement material ${coverage.replacementMaterialId}.`,
					materialId: coverage.replacementMaterialId,
					entryRef,
				});
				continue;
			}
			if (coveredEntryRefs.has(entryRef)) {
				issues.push({
					code: "coverage_duplicate_source_ref",
					message: `Coverage source entry ${entryRef} has multiple replacement materials.`,
					materialId: coverage.replacementMaterialId,
					entryRef,
				});
				continue;
			}
			coveredEntryRefs.add(entryRef);
		}
	}

	return { valid: issues.length === 0, coveredEntryRefs: [...coveredEntryRefs], issues };
}
