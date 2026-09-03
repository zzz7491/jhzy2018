#!/usr/bin/env node
// 同步三份手写 MD 文档中的 permission code（旧 2 段 → 新 3 段），与 JSON 单一事实源一致。
// 仅做纯字符串替换，不改语义；CRITICAL 风险文案由后续手动编辑处理。
import { readFileSync, writeFileSync } from 'node:fs';

const RENAME = {
  'team.create': 'team.team.create', 'team.update': 'team.team.update', 'team.disband': 'team.team.disband',
  'activity.create': 'activity.activity.create', 'activity.update': 'activity.activity.update', 'activity.publish': 'activity.activity.publish',
  'activity.cancel': 'activity.activity.cancel', 'activity.delete': 'activity.activity.delete',
  'signup.create': 'signup.signup.create', 'signup.cancel': 'signup.signup.cancel', 'signup.review': 'signup.signup.review',
  'attendance.checkin': 'attendance.record.checkin', 'attendance.checkout': 'attendance.record.checkout', 'attendance.force': 'attendance.record.force',
  'training.enroll': 'training.enrollment.enroll', 'training.learn': 'training.learning.learn',
  'exam.take': 'exam.exam.take', 'exam.grade': 'exam.exam.grade',
  'certificate.issue': 'certificate.certificate.issue', 'certificate.revoke': 'certificate.certificate.revoke',
  'certificate.view': 'certificate.certificate.view', 'certificate.verify': 'certificate.certificate.verify',
  'points.adjust': 'points.ledger.adjust',
  'honor.manage': 'honor.honor.manage', 'honor.award': 'honor.honor.award',
  'content.create': 'content.article.create', 'content.update': 'content.article.update', 'content.publish': 'content.article.publish',
  'content.delete': 'content.article.delete', 'content.audit': 'content.article.audit',
  'content.comment': 'content.comment.create', 'content.like': 'content.like.create', 'content.report': 'content.report.create',
  'notification.view': 'notification.notification.view', 'notification.send': 'notification.notification.send',
  'file.upload': 'file.file.upload', 'file.view': 'file.file.view', 'file.delete': 'file.file.delete',
  'system.config': 'system.config.manage', 'system.backup': 'system.backup.manage'
};

const files = [
  'E:/D盘备份/miniprogram/docs/architecture/PERMISSION-DOMAIN-MAP.md',
  'E:/D盘备份/miniprogram/docs/architecture/RESOURCE-OWNERSHIP-RULES.md',
  'E:/D盘备份/miniprogram/docs/architecture/PERMISSION-SECURITY-REVIEW.md'
];

let total = 0;
for (const f of files) {
  let t = readFileSync(f, 'utf8');
  for (const [old, neu] of Object.entries(RENAME)) {
    if (t.includes(old)) {
      const n = t.split(old).length - 1;
      t = t.split(old).join(neu);
      total += n;
    }
  }
  writeFileSync(f, t, 'utf8');
}
console.log(`synced ${total} code occurrences across ${files.length} docs`);
