// migration_issues accessor (migration problem tracker, system-only, never business table).
export function createIssues(target) {
  return {
    async record(rec) {
      return target.writeIssue(rec);
    },
  };
}
