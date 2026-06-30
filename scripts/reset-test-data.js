#!/usr/bin/env node
/**
 * reset-test-data.js
 *
 * Clears ALL payroll and time-record test data from the live production database.
 * Employees, admin users, holidays, and all profile data are preserved.
 *
 * Usage:
 *   node scripts/reset-test-data.js --dry-run   (show counts only, delete nothing)
 *   node scripts/reset-test-data.js --apply     (delete the data)
 *
 * Tables CLEARED:
 *   payroll_item_alberta_holidays   (child of payroll_items — deleted first)
 *   payroll_items                   (child of payroll_periods — deleted second)
 *   payroll_periods                 (parent payroll table — deleted third)
 *   time_records                    (all clock / manual / imported shift records)
 *   audit_logs WHERE entity_type IN ('time_record','payroll_item','payroll_period')
 *   employee_audit_logs             (time-record & payroll related audit entries)
 *
 * Tables PRESERVED (never touched):
 *   employees                (names, emails, rates, PINs, pay types, hire dates, etc.)
 *   admin_users              (admin accounts)
 *   admin_sessions           (active login sessions)
 *   admin_login_attempts     (rate-limit state)
 *   holidays                 (Alberta statutory holiday registry — seed data)
 *
 * CRITICAL:
 *   - Run --dry-run first and verify the counts before using --apply.
 *   - Back up the database before --apply.
 *   - This script does NOT reset employee accrued_vacation_balance.
 *     If needed, that is a separate decision — employees keep their vacation balances.
 */

"use strict";

const path = require("path");
const fs   = require("fs");

const DB_PATH    = "/var/www/restaurant-system/data/restaurant-system.db";
const BACKUP_DIR = "/var/www/restaurant-system-backups";
const BACKUP_PREFIX = "restaurant-system.before-reset-";

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const DO_APPLY  = args.includes("--apply");
const SKIP_BACKUP_CHECK = args.includes("--skip-backup-check");

if (!DRY_RUN && !DO_APPLY) {
  console.error("Usage:");
  console.error("  node scripts/reset-test-data.js --dry-run");
  console.error("  node scripts/reset-test-data.js --apply   (back up DB first!)");
  process.exit(1);
}
if (DRY_RUN && DO_APPLY) {
  console.error("Error: cannot use both --dry-run and --apply.");
  process.exit(1);
}

// ─── Load better-sqlite3 ─────────────────────────────────────────────────────
let Database;
try { Database = require("better-sqlite3"); }
catch (e) {
  console.error("Missing: better-sqlite3. Should already be installed in the project.");
  process.exit(1);
}

// ─── Backup check (--apply only) ─────────────────────────────────────────────
if (DO_APPLY && !SKIP_BACKUP_CHECK) {
  const backups = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db"))
    : [];
  if (backups.length === 0) {
    console.error("⛔  No pre-reset backup found in:", BACKUP_DIR);
    console.error("    Run these commands first, then re-run --apply:");
    console.error("");
    console.error("    mkdir -p /var/www/restaurant-system-backups");
    console.error("    cp /var/www/restaurant-system/data/restaurant-system.db \\");
    console.error("       /var/www/restaurant-system-backups/restaurant-system.before-reset-$(date +%Y%m%d-%H%M%S).db");
    console.error("");
    console.error("    (Override with --skip-backup-check if you are absolutely certain.)");
    process.exit(1);
  }
  const latest = backups.sort().at(-1);
  console.log("✓ Backup found:", path.join(BACKUP_DIR, latest));
}

// ─── Open DB ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: DRY_RUN });

// ─── Helper: count rows in a table safely ────────────────────────────────────
function count(table, where = "") {
  try {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? " WHERE " + where : ""}`;
    return db.prepare(sql).get().n;
  } catch (e) {
    return `(table missing or error: ${e.message})`;
  }
}

// ─── Helper: check if a table exists ─────────────────────────────────────────
function tableExists(name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

// ─── Section header ───────────────────────────────────────────────────────────
function section(title) {
  console.log("\n" + "─".repeat(60));
  console.log("  " + title);
  console.log("─".repeat(60));
}

// ═════════════════════════════════════════════════════════════════════════════
// DRY-RUN
// ═════════════════════════════════════════════════════════════════════════════
section("PRE-RESET COUNTS (current live state)");

const empCount       = count("employees");
const adminCount     = count("admin_users");
const holidayCount   = count("holidays");
const periodCount    = count("payroll_periods");
const itemCount      = count("payroll_items");
const albHolidayCount = tableExists("payroll_item_alberta_holidays")
  ? count("payroll_item_alberta_holidays") : "table not found";
const trCount        = count("time_records");
const trActiveCount  = count("time_records", "deleted_at IS NULL");
const trDeletedCount = count("time_records", "deleted_at IS NOT NULL");
const auditPayCount  = tableExists("audit_logs")
  ? count("audit_logs", "entity_type IN ('time_record','payroll_item','payroll_period')") : "n/a";
const empAuditCount  = tableExists("employee_audit_logs")
  ? count("employee_audit_logs") : "n/a";
const sentCount      = tableExists("payroll_items")
  ? count("payroll_items", "send_status = 'sent'") : "n/a";

console.log(`  employees                          : ${empCount}   ← PRESERVED`);
console.log(`  admin_users                        : ${adminCount}   ← PRESERVED`);
console.log(`  holidays (Alberta registry)        : ${holidayCount}   ← PRESERVED`);
console.log("");
console.log(`  payroll_periods                    : ${periodCount}   ← WILL BE DELETED`);
console.log(`  payroll_items                      : ${itemCount}   ← WILL BE DELETED`);
console.log(`    of which send_status='sent'      : ${sentCount}`);
console.log(`  payroll_item_alberta_holidays      : ${albHolidayCount}   ← WILL BE DELETED`);
console.log(`  time_records (total)               : ${trCount}   ← WILL BE DELETED`);
console.log(`    active (not soft-deleted)        : ${trActiveCount}`);
console.log(`    already soft-deleted             : ${trDeletedCount}`);
console.log(`  audit_logs (payroll/time entries)  : ${auditPayCount}   ← WILL BE DELETED`);
console.log(`  employee_audit_logs                : ${empAuditCount}   ← WILL BE DELETED`);

// Show payroll period details
if (periodCount > 0) {
  section("PAYROLL PERIODS THAT WILL BE DELETED");
  const periods = db.prepare(
    "SELECT id, start_date, end_date, status, pay_date FROM payroll_periods ORDER BY start_date"
  ).all();
  periods.forEach(p =>
    console.log(`  [${p.id}] ${p.start_date} → ${p.end_date}  status:${p.status}  pay_date:${p.pay_date ?? "(none)"}`)
  );
}

// Show sent payroll items
const sentItems = tableExists("payroll_items")
  ? db.prepare(`
      SELECT pi.id, pi.employee_name, pp.start_date, pp.end_date, pi.net_pay, pi.sent_at, pi.payment_reference
      FROM payroll_items pi
      JOIN payroll_periods pp ON pp.id = pi.payroll_period_id
      WHERE pi.send_status = 'sent'
      ORDER BY pi.sent_at
    `).all()
  : [];
if (sentItems.length > 0) {
  section("SENT PAYROLL ITEMS THAT WILL BE DELETED");
  console.log("  (These are test payslip emails — safe to remove per your instruction.)");
  sentItems.forEach(i =>
    console.log(`  [${i.id}] ${i.employee_name.padEnd(28)} ${i.start_date}→${i.end_date}  net:$${Number(i.net_pay).toFixed(2)}  sent:${i.sent_at}`)
  );
}

// Show time record summary
if (trCount > 0) {
  section("TIME RECORDS THAT WILL BE DELETED");
  try {
    const trSummary = db.prepare(`
      SELECT e.name, COUNT(*) AS n,
             SUM(CASE WHEN tr.created_manually=1 THEN 1 ELSE 0 END) AS manual_n,
             SUM(CASE WHEN tr.note LIKE '%Imported%' THEN 1 ELSE 0 END) AS imported_n
      FROM time_records tr
      LEFT JOIN employees e ON e.id = tr.employee_id
      GROUP BY tr.employee_id
      ORDER BY e.name
    `).all();
    trSummary.forEach(r =>
      console.log(`  ${(r.name ?? "?").padEnd(30)} total:${r.n}  manual:${r.manual_n}  imported:${r.imported_n}`)
    );
  } catch (e) {
    console.log("  (could not summarize:", e.message + ")");
  }
}

section("TABLES THAT WILL NOT BE TOUCHED");
console.log("  ✓ employees                  (all profiles, rates, emails, PINs)");
console.log("  ✓ admin_users                (admin accounts)");
console.log("  ✓ admin_sessions             (active sessions)");
console.log("  ✓ admin_login_attempts       (rate-limit state)");
console.log("  ✓ holidays                   (Alberta statutory holidays seed data)");

if (DRY_RUN) {
  console.log("\n" + "═".repeat(60));
  console.log("  DRY RUN COMPLETE — nothing was deleted.");
  console.log("  Employee count before: " + empCount);
  console.log("  To proceed, back up then run --apply:");
  console.log("");
  console.log("    mkdir -p /var/www/restaurant-system-backups");
  console.log("    cp /var/www/restaurant-system/data/restaurant-system.db \\");
  console.log("       /var/www/restaurant-system-backups/restaurant-system.before-reset-$(date +%Y%m%d-%H%M%S).db");
  console.log("");
  console.log("    node scripts/reset-test-data.js --apply");
  console.log("═".repeat(60));
  db.close();
  process.exit(0);
}

// ═════════════════════════════════════════════════════════════════════════════
// APPLY
// ═════════════════════════════════════════════════════════════════════════════
section("APPLYING RESET");
console.log("  Deleting in dependency order...");

const empCountBefore = Number(db.prepare("SELECT COUNT(*) AS n FROM employees").get().n);

db.transaction(() => {

  // 1. Child of payroll_items — must go first
  if (tableExists("payroll_item_alberta_holidays")) {
    const r = db.prepare("DELETE FROM payroll_item_alberta_holidays").run();
    console.log(`  Deleted payroll_item_alberta_holidays : ${r.changes} rows`);
  }

  // 2. Payroll items
  const r2 = db.prepare("DELETE FROM payroll_items").run();
  console.log(`  Deleted payroll_items                 : ${r2.changes} rows`);

  // 3. Payroll periods
  const r3 = db.prepare("DELETE FROM payroll_periods").run();
  console.log(`  Deleted payroll_periods               : ${r3.changes} rows`);

  // 4. All time records (including soft-deleted ones — full wipe)
  const r4 = db.prepare("DELETE FROM time_records").run();
  console.log(`  Deleted time_records                  : ${r4.changes} rows`);

  // 5. Audit log entries related to payroll and time records
  if (tableExists("audit_logs")) {
    const r5 = db.prepare(
      "DELETE FROM audit_logs WHERE entity_type IN ('time_record','payroll_item','payroll_period')"
    ).run();
    console.log(`  Deleted audit_logs (payroll/time)      : ${r5.changes} rows`);
  }

  // 6. Employee audit logs (time/payroll events)
  if (tableExists("employee_audit_logs")) {
    const r6 = db.prepare("DELETE FROM employee_audit_logs").run();
    console.log(`  Deleted employee_audit_logs            : ${r6.changes} rows`);
  }

  // 7. Reset SQLite autoincrement sequences for cleared tables so IDs restart from 1
  //    (optional but clean for a fresh start)
  const seqTables = ["time_records","payroll_periods","payroll_items","payroll_item_alberta_holidays","audit_logs","employee_audit_logs"];
  for (const t of seqTables) {
    try {
      db.prepare("DELETE FROM sqlite_sequence WHERE name=?").run(t);
    } catch (_) {
      // sqlite_sequence only exists if AUTOINCREMENT has been used — safe to ignore
    }
  }
  console.log("  Reset autoincrement sequences for cleared tables");

})(); // end transaction

// ─── Verify employees were NOT touched ───────────────────────────────────────
const empCountAfter = Number(db.prepare("SELECT COUNT(*) AS n FROM employees").get().n);
const empMatch = empCountAfter === empCountBefore;

section("POST-RESET VERIFICATION");
console.log(`  payroll_periods remaining    : ${count("payroll_periods")}`);
console.log(`  payroll_items remaining      : ${count("payroll_items")}`);
console.log(`  payroll_item_alberta_holidays: ${tableExists("payroll_item_alberta_holidays") ? count("payroll_item_alberta_holidays") : "n/a"}`);
console.log(`  time_records remaining       : ${count("time_records")}`);
console.log(`  audit_logs (payroll/time)    : ${tableExists("audit_logs") ? count("audit_logs","entity_type IN ('time_record','payroll_item','payroll_period')") : "n/a"}`);
console.log(`  employee_audit_logs          : ${tableExists("employee_audit_logs") ? count("employee_audit_logs") : "n/a"}`);
console.log("");
console.log(`  employees before : ${empCountBefore}`);
console.log(`  employees after  : ${empCountAfter}`);
console.log(`  employees match  : ${empMatch ? "✓ YES — employees preserved" : "✗ MISMATCH — INVESTIGATE IMMEDIATELY"}`);
console.log(`  holidays         : ${count("holidays")} (unchanged)`);
console.log(`  admin_users      : ${count("admin_users")} (unchanged)`);

if (!empMatch) {
  console.error("\n⛔  Employee count changed! This should never happen. Restore from backup immediately.");
  db.close();
  process.exit(1);
}

db.close();
console.log("\n  ✓ Reset complete. Database is ready for timesheet import.");
console.log("  Next: node scripts/import-timesheet.js --dry-run");
