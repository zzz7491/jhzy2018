// legacy_id_maps accessor (migration support table, system-only, never business table).
export function createIdMap(target) {
  return {
    async lookup(sourceSystem, sourceTable, legacyId) {
      return target.lookupIdMap(sourceSystem, sourceTable, legacyId);
    },
    async record(rec) {
      return target.writeIdMap(rec);
    },
  };
}
