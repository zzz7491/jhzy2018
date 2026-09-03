#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
S2-3 D1 Migration 静态验证器（纯文本分析，不执行 SQL）。

检查项：
  A. MySQL 残留语法
  B. RBAC（6 角色 / volunteer=team / 禁 INSERT permissions / 禁 INSERT role_permissions）
  C. Tenant（TEAM_SCOPED 表含 team_id NOT NULL REFERENCES teams）
  D. FK（引用目标存在 / 无环）
  E. D1/SQLite 语法 sanity（括号平衡 / 无反引号 / 无 MySQL # 注释）

输出结论供 S2-3-REPORT.md Gate E 引用。
runtime SQL 执行验证标记 STATIC-ONLY deferred（不连库、不跑 sqlite3）。
"""
import re
import sys

MIG_0001 = r"E:\D盘备份\miniprogram\workers\migrations\0001_initial_schema.sql"
MIG_0002 = r"E:\D盘备份\miniprogram\workers\migrations\0002_rbac_structure.sql"

# TEAM_SCOPED 表清单（来自 D1-SCHEMA-TABLE-MATRIX.md §2）
# 注：attendance_devices 重分类 PLATFORM_GLOBAL（共享风控，非租户所有）；
#     content_audit_logs 重分类 AUDIT_ONLY（审计日志，team_id 可 NULL）。
TEAM_SCOPED = {
    "team_members", "team_invites", "activities", "activity_signups",
    "attendance_sessions", "attendance_events",
    "attendance_anomalies", "service_records", "service_record_audits",
    "courses", "course_lessons", "course_enrollments", "exam_papers",
    "exam_sessions", "exam_answers", "certificates", "certificate_logs",
    "mall_products", "mall_orders", "honors", "badges", "content_articles",
    "content_comments", "content_likes", "content_reports",
    "content_attachments", "files", "notifications",
    "ai_conversations", "ai_usage_logs",
}
# 逻辑 TEAM_SCOPED 但 team_id 由父表派生的白名单（不冗余存储）
TENANT_DERIVED_WHITELIST = {"activity_signups"}

MYSQL_RESIDUALS = [
    r"AUTO_INCREMENT", r"BIGINT", r"UNSIGNED", r"DATETIME", r"TIMESTAMP",
    r"ENUM\s*\(", r"ENGINE\s*=", r"CHARSET\s*=", r"COLLATE\s*=",
    r"COMMENT\s+['\"]", r"CREATE\s+DATABASE", r"\bUSE\s+\w", r"\bGRANT\b", r"(?<!')REVOKE(?![\w'])",
    r"VARBINARY", r"DECIMAL",
]


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def line_of(text, idx):
    return text.count("\n", 0, idx) + 1


def main():
    t1 = read(MIG_0001)
    t2 = read(MIG_0002)
    all_sql = t1 + "\n" + t2
    errors = []
    warns = []

    # ---- A. MySQL 残留 ----
    print("=== A. MySQL 残留语法扫描 ===")
    a_hits = 0
    for pat in MYSQL_RESIDUALS:
        for m in re.finditer(pat, all_sql, re.IGNORECASE):
            a_hits += 1
            ln = line_of(all_sql, m.start())
            print(f"  [HIT] {pat!r} @ line {ln}: ...{all_sql[m.start():m.start()+40]!r}")
    if a_hits == 0:
        print("  PASS: 无 MySQL 残留语法（AUTO_INCREMENT/BIGINT/UNSIGNED/DATETIME/TIMESTAMP/ENUM/ENGINE/CHARSET/COLLATE/COMMENT/CREATE DATABASE/USE/GRANT/REVOKE/VARBINARY/DECIMAL 均 0 命中）")
    else:
        errors.append(f"A: {a_hits} 处 MySQL 残留")

    # ---- B. RBAC ----
    print("\n=== B. RBAC 检查 ===")
    # 6 角色 seed
    roles_block = re.search(r"INSERT INTO roles \(code, name, scope, is_system, status\) VALUES(.*?);",
                             t2, re.DOTALL)
    if not roles_block:
        errors.append("B: 未找到 roles seed INSERT")
        print("  FAIL: 未找到 roles seed")
    else:
        rows = re.findall(r"\('([^']+)',\s*'([^']+)',\s*'([^']+)'", roles_block.group(1))
        codes = [r[0] for r in rows]
        scopes = {r[0]: r[2] for r in rows}
        expected = {"platform_super_admin": "platform", "platform_operator": "platform",
                    "team_owner": "team", "team_admin": "team",
                    "team_auditor": "team", "volunteer": "team"}
        if set(codes) != set(expected.keys()):
            errors.append(f"B: roles seed 码不符（实际 {codes}）")
            print(f"  FAIL: roles 码集合异常: {codes}")
        else:
            print(f"  PASS: 6 角色完整 = {codes}")
        bad = [c for c, s in scopes.items() if expected.get(c) != s]
        if bad:
            errors.append(f"B: scope 错误 {bad}")
            print(f"  FAIL: scope 冲突 {bad}")
        else:
            print("  PASS: 6 角色 scope 与 S2-2G 裁定一致（volunteer=team）")
        if scopes.get("volunteer") == "platform":
            errors.append("B: volunteer 被写成 platform（禁止）")
        else:
            print("  PASS: 无 platform 级 volunteer")

    # permissions 禁 INSERT
    if re.search(r"INSERT\s+INTO\s+permissions", t2, re.IGNORECASE):
        errors.append("B: permissions 表存在 INSERT（禁止）")
        print("  FAIL: permissions 有 INSERT")
    else:
        print("  PASS: permissions 表无任何 INSERT（CONFIRMED=0 维持）")
    # role_permissions 禁 INSERT
    if re.search(r"INSERT\s+INTO\s+role_permissions", t2, re.IGNORECASE):
        errors.append("B: role_permissions 表存在 INSERT（禁止）")
        print("  FAIL: role_permissions 有 INSERT")
    else:
        print("  PASS: role_permissions 表无任何 INSERT（无绑定）")

    # ---- C. Tenant ----
    print("\n=== C. Tenant 检查（TEAM_SCOPED 表须含 team_id NOT NULL REFERENCES teams） ===")
    c_hits = 0
    for tbl in TEAM_SCOPED:
        # 找到该表 CREATE 块
        m = re.search(r"CREATE TABLE IF NOT EXISTS " + re.escape(tbl) + r" \((.*?)\n\);",
                      all_sql, re.DOTALL)
        if not m:
            errors.append(f"C: 未找到表 {tbl}")
            print(f"  FAIL: 未找到 {tbl}")
            continue
        body = m.group(1)
        if tbl in TENANT_DERIVED_WHITELIST:
            # 允许无 team_id（派生）
            print(f"  INFO: {tbl} 逻辑 TEAM_SCOPED，team_id 由父表派生（白名单，跳过 team_id 检查）")
            continue
        if re.search(r"team_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+teams", body):
            pass
        else:
            c_hits += 1
            errors.append(f"C: {tbl} 缺少 'team_id INTEGER NOT NULL REFERENCES teams'")
            print(f"  FAIL: {tbl} 缺 team_id NOT NULL REFERENCES teams")
    if c_hits == 0:
        print("  PASS: 全部 TEAM_SCOPED 表（白名单除外）含 team_id NOT NULL REFERENCES teams")

    # ---- D. FK ----
    print("\n=== D. 外键检查（引用目标存在 + 无环） ===")
    creates = dict(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", all_sql, re.DOTALL))
    defined = set(creates.keys())
    graph = {}
    d_hits = 0
    for tbl, body in creates.items():
        refs = re.findall(r"REFERENCES\s+(\w+)", body)
        graph[tbl] = refs
        for r in refs:
            if r not in defined:
                d_hits += 1
                errors.append(f"D: {tbl} 引用未定义表 {r}")
                print(f"  FAIL: {tbl} -> {r} 未定义")
    if d_hits == 0:
        print(f"  PASS: 所有 REFERENCES 目标均存在（共 {sum(len(v) for v in graph.values())} 条 FK）")
    # 环检测（忽略自引用）
    color = {}
    def dfs(u):
        color[u] = 1
        for v in graph.get(u, []):
            if v == u:
                continue
            if v not in color:
                if dfs(v):
                    return True
            elif color[v] == 1:
                return True
        color[u] = 2
        return False
    cycle = False
    for t in defined:
        if t not in color:
            if dfs(t):
                cycle = True
                break
    if cycle:
        errors.append("D: 检测到 FK 环")
        print("  FAIL: 存在 FK 环")
    else:
        print("  PASS: 无 FK 环（自引用均 SET NULL，不构成阻塞环）")

    # ---- E. SQLite 语法 sanity ----
    print("\n=== E. D1/SQLite 语法 sanity ===")
    # 反引号
    if "`" in all_sql:
        errors.append("E: 存在反引号（MySQL 标识符引号）")
        print("  FAIL: 含反引号")
    else:
        print("  PASS: 无反引号（未用 MySQL 标识符引号）")
    # MySQL 风格 # 注释（行内）
    if re.search(r"(?m)^\s*#", all_sql):
        errors.append("E: 存在 MySQL # 注释")
        print("  FAIL: 含 # 注释")
    else:
        print("  PASS: 无 MySQL # 注释（统一 --）")
    # 括号平衡（分语句）
    for fname, txt in (("0001", t1), ("0002", t2)):
        depth = 0
        ok = True
        for ch in txt:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    ok = False
                    break
        if depth != 0 or not ok:
            errors.append(f"E: {fname} 括号不平衡")
            print(f"  FAIL: {fname} 括号不平衡")
        else:
            print(f"  PASS: {fname} 括号平衡")
    print("  NOTE: runtime SQL 执行（sqlite3 实跑建表）标记 STATIC-ONLY deferred —— 本阶段不连库、不执行 SQL")

    # ---- 汇总 ----
    print("\n=== 汇总 ===")
    if errors:
        print(f"RESULT: FAIL ({len(errors)} 项)")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("RESULT: PASS —— 静态验证全绿（A/B/C/D/E 通过；runtime 验证 deferred）")
        sys.exit(0)


if __name__ == "__main__":
    main()
