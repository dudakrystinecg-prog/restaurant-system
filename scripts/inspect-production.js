#!/usr/bin/env node
/**
 * inspect-production.js
 *
 * READ-ONLY inspection of the live production database.
 * Run on the VPS:
 *
 *   node scripts/inspect-production.js
 *
 * Does NOT write, modify, or delete anything.
 */

"use strict";

const Database = require("better-sqlite3");

const DB_PATH = "/var/www/restaurant-system/data/restaurant-system.db";

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error("Cannot open database:", e.message);
  console.error("Path:", DB_PATH);
  process.exit(1);
}

function section(title) {
  console.log("\n" + "═".repeat(64));
  console.log("  " + title);
  console.log("═".repeat(64));
}

function safe(fn) {
  try { return fn(); }
  catch (e) { return `[ERROR: ${e.message}]`; }
}

// ─── 1. Employees ─────────────────────────────────────────────────────────────
section("1. EMPLOYEES");
const employees = safe(() =>
  db.prepare(`
    SELECT id, name, pay_type,
           COALESCE(is_active_employee, active, 1) AS is_active_employee,
           COALESCE(show_in_kiosk, active, 1)      AS show_in_kiosk,
           email,
           default_hourly_rate, annual_salary
    FROM employees
    ORDER BY name
  `).all()
);
if (Array.isArray(employees)) {
  console.log(`Total employees: ${employees.length}`);
  console.log("");
  employees.forEach(e => {
    const wage = e.pay_type === "salaried"
      ? `salary=$${e.annual_salary ?? "?"}/yr`
      : `rate=$${e.default_hourly_rate ?? "?"}/hr`;
    const status = e.is_active_employee ? "active" : "former";
    const kiosk  = e.show_in_kiosk ? "visible" : "hidden";
    console.log(
      `  [${String(e.id).padStart(3)}] ${e.name.padEnd(30)} ${e.pay_type.padEnd(8)} ${wage.padEnd(20)} ${status} | kiosk:${kiosk}`
    );
  });
} else {
  console.log(employees);
}

// ─── 2. Payroll Periods ───────────────────────────────────────────────────────
section("2. PAYROLL PERIODS");
const periods = safe(() =>
  db.prepare(`
    SELECT id, start_date, end_date, status, pay_date,
           pay_frequency, created_at, updated_at
    FROM payroll_periods
    ORDER BY start_date ASC
  `).all()
);
if (Array.isArray(periods)) {
  console.log(`Total payroll periods: ${periods.length}`);
  console.log("");
  periods.forEach(p => {
    console.log(`  Period ${p.id}: ${p.start_date} → ${p.end_date}`);
    console.log(`    status     : ${p.status}`);
    console.log(`    pay_date   : ${p.pay_date ?? "(none)"}`);
    console.log(`    frequency  : ${p.pay_frequency}`);
    console.log(`    created_at : ${p.created_at}`);
    console.log(`    updated_at : ${p.updated_at ?? "(none)"}`);
    console.log("");
  });
} else {
  console.log(periods);
}

// ─── 3. Payroll Items ─────────────────────────────────────────────────────────
section("3. PAYROLL ITEMS (all)");
const items = safe(() =>
  db.prepare(`
    SELECT
      pi.id,
      pi.payroll_period_id,
      pp.start_date  AS period_start,
      pp.end_date    AS period_end,
      pp.status      AS period_status,
      pi.employee_name,
      pi.pay_type,
      pi.total_hours,
      pi.gross_pay_total,
      pi.net_pay,
      pi.send_status,
      pi.sent_at,
      pi.payment_reference,
      pi.cheque_number
    FROM payroll_items pi
    JOIN payroll_periods pp ON pp.id = pi.payroll_period_id
    ORDER BY pp.start_date ASC, pi.employee_name ASC
  `).all()
);
if (Array.isArray(items)) {
  console.log(`Total payroll items: ${items.length}`);
  let lastPeriod = null;
  items.forEach(i => {
    if (i.payroll_period_id !== lastPeriod) {
      console.log(`\n  ── Period ${i.payroll_period_id} | ${i.period_start} → ${i.period_end} | status: ${i.period_status} ──`);
      lastPeriod = i.payroll_period_id;
    }
    const hrs   = i.pay_type === "salaried" ? "salaried" : `${i.total_hours ?? 0}h`;
    const gross = `$${Number(i.gross_pay_total ?? 0).toFixed(2)}`;
    const net   = `$${Number(i.net_pay ?? 0).toFixed(2)}`;
    const ref   = i.payment_reference ? `ref:${i.payment_reference}` : "";
    const chq   = i.cheque_number     ? `chq:${i.cheque_number}` : "";
    console.log(
      `    [item ${String(i.id).padStart(4)}] ${i.employee_name.padEnd(28)} ` +
      `${hrs.padEnd(10)} gross:${gross.padEnd(12)} net:${net.padEnd(12)} ` +
      `send:${(i.send_status ?? "none").padEnd(8)} ${ref} ${chq}`
    );
    if (i.sent_at) console.log(`           sent_at: ${i.sent_at}`);
  });
} else {
  console.log(items);
}

// ─── 4. Coverage matrix: which employees/months have payroll ──────────────────
section("4. PAYROLL COVERAGE MATRIX");
if (Array.isArray(items) && Array.isArray(periods)) {
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const empNames = [...new Set(items.map(i => i.employee_name))].sort();
  const periodMonths = periods.map(p => ({
    id: p.id,
    monthKey: p.start_date.slice(0, 7), // "2026-01"
    label: monthNames[Number(p.start_date.slice(5, 7)) - 1] + " " + p.start_date.slice(0, 4),
    status: p.status,
  }));

  // Build lookup: empName + monthKey → send_status
  const coverage = {};
  items.forEach(i => {
    const key = `${i.employee_name}|${i.period_start.slice(0, 7)}`;
    coverage[key] = i.send_status ?? "generated";
  });

  const colW = 14;
  const hdr = "Employee".padEnd(28) + periodMonths.map(m => m.label.padEnd(colW)).join("");
  console.log("  " + hdr);
  console.log("  " + "─".repeat(hdr.length));
  empNames.forEach(name => {
    const row = periodMonths.map(m => {
      const val = coverage[`${name}|${m.monthKey}`];
      return (val ?? "─").padEnd(colW);
    }).join("");
    console.log("  " + name.padEnd(28) + row);
  });

  // Which months have no payroll at all
  const coveredMonths = new Set(periodMonths.map(m => m.monthKey));
  console.log("\n  Months with payroll generated:", [...coveredMonths].join(", ") || "(none)");
}

// ─── 5. Send status summary ───────────────────────────────────────────────────
section("5. SEND STATUS SUMMARY");
const sendSummary = safe(() =>
  db.prepare(`
    SELECT send_status, COUNT(*) AS n
    FROM payroll_items
    GROUP BY send_status
    ORDER BY send_status
  `).all()
);
if (Array.isArray(sendSummary)) {
  sendSummary.forEach(r => console.log(`  ${(r.send_status ?? "null").padEnd(12)} → ${r.n} item(s)`));
}

const sentItems = safe(() =>
  db.prepare(`
    SELECT pi.id, pi.employee_name, pp.start_date, pp.end_date, pi.net_pay, pi.sent_at
    FROM payroll_items pi
    JOIN payroll_periods pp ON pp.id = pi.payroll_period_id
    WHERE pi.send_status = 'sent'
    ORDER BY pi.sent_at
  `).all()
);
if (Array.isArray(sentItems) && sentItems.length > 0) {
  console.log("\n  Items with send_status = sent:");
  sentItems.forEach(i =>
    console.log(`    [${i.id}] ${i.employee_name.padEnd(28)} ${i.start_date}→${i.end_date}  net:$${Number(i.net_pay).toFixed(2)}  sent:${i.sent_at}`)
  );
}

// ─── 6. Active time records ───────────────────────────────────────────────────
section("6. TIME RECORDS (active, not deleted)");
const timeRecords = safe(() =>
  db.prepare(`
    SELECT
      tr.id,
      e.name       AS employee_name,
      tr.type,
      tr.entry_mode,
      tr.recorded_at,
      tr.worked_hours,
      tr.manual_category,
      tr.created_manually,
      tr.note
    FROM time_records tr
    LEFT JOIN employees e ON e.id = tr.employee_id
    WHERE tr.deleted_at IS NULL
    ORDER BY tr.recorded_at ASC
  `).all()
);
if (Array.isArray(timeRecords)) {
  console.log(`Total active time records: ${timeRecords.length}`);

  // Group by source
  const kiosk    = timeRecords.filter(r => !r.created_manually && r.entry_mode === "clock");
  const manual   = timeRecords.filter(r => r.created_manually && (!r.note || !r.note.includes("Imported")));
  const imported = timeRecords.filter(r => r.note && r.note.includes("Imported"));

  console.log(`  From kiosk (clock):      ${kiosk.length}`);
  console.log(`  Manual (admin-created):  ${manual.length}`);
  console.log(`  Imported (from script):  ${imported.length}`);
  console.log("");

  timeRecords.forEach(r => {
    const src = r.note && r.note.includes("Imported") ? "[IMPORT]"
              : r.created_manually ? "[MANUAL]" : "[KIOSK ]";
    console.log(
      `  ${src} id=${String(r.id).padStart(4)} ${(r.employee_name ?? "?").padEnd(28)} ` +
      `${r.type.padEnd(10)} ${r.recorded_at}  hrs=${r.worked_hours}  cat=${r.manual_category}` +
      (r.note ? `  note="${r.note}"` : "")
    );
  });
}

// ─── 7. Open / orphan check-ins ───────────────────────────────────────────────
section("7. OPEN / ORPHAN CHECK-INS (no matching check-out)");
const openCheckIns = safe(() =>
  db.prepare(`
    SELECT tr.id, e.name AS employee_name, tr.recorded_at, tr.entry_mode, tr.created_manually
    FROM time_records tr
    LEFT JOIN employees e ON e.id = tr.employee_id
    WHERE tr.type = 'check-in'
      AND tr.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM time_records tr2
        WHERE tr2.employee_id = tr.employee_id
          AND tr2.type = 'check-out'
          AND tr2.recorded_at > tr.recorded_at
          AND tr2.deleted_at IS NULL
      )
    ORDER BY tr.recorded_at ASC
  `).all()
);
if (Array.isArray(openCheckIns)) {
  if (openCheckIns.length === 0) {
    console.log("  None — no orphan check-ins found.");
  } else {
    console.log(`  ${openCheckIns.length} open check-in(s) with no matching check-out:`);
    openCheckIns.forEach(r =>
      console.log(`  id=${r.id}  ${(r.employee_name ?? "?").padEnd(28)}  at=${r.recorded_at}  mode=${r.entry_mode}`)
    );
  }
}

// ─── 8. Imported / manual records detail ─────────────────────────────────────
section("8. MANUAL & IMPORTED RECORDS DETAIL");
const manualDetail = safe(() =>
  db.prepare(`
    SELECT tr.id, e.name AS employee_name, tr.type, tr.entry_mode,
           tr.recorded_at, tr.worked_hours, tr.manual_category,
           tr.created_manually, tr.note
    FROM time_records tr
    LEFT JOIN employees e ON e.id = tr.employee_id
    WHERE tr.created_manually = 1 AND tr.deleted_at IS NULL
    ORDER BY tr.recorded_at ASC
  `).all()
);
if (Array.isArray(manualDetail)) {
  console.log(`Total manually-created records: ${manualDetail.length}`);
  manualDetail.forEach(r =>
    console.log(
      `  id=${String(r.id).padStart(4)}  ${(r.employee_name ?? "?").padEnd(28)}  ` +
      `${r.type.padEnd(10)}  ${r.recorded_at}  hrs=${r.worked_hours}  cat=${r.manual_category}` +
      (r.note ? `  note="${r.note}"` : "")
    )
  );
}

// ─── 9. Monthly time record coverage per employee ────────────────────────────
section("9. TIME RECORDS — SHIFT COUNT BY EMPLOYEE & MONTH");
const shiftsByMonth = safe(() =>
  db.prepare(`
    SELECT
      e.name AS employee_name,
      strftime('%Y-%m', tr.recorded_at) AS month,
      COUNT(*) AS record_count,
      SUM(CASE WHEN tr.type='check-in' THEN 1 ELSE 0 END) AS check_ins,
      SUM(tr.worked_hours) AS total_worked_hours
    FROM time_records tr
    LEFT JOIN employees e ON e.id = tr.employee_id
    WHERE tr.deleted_at IS NULL
    GROUP BY e.name, month
    ORDER BY month ASC, e.name ASC
  `).all()
);
if (Array.isArray(shiftsByMonth)) {
  if (shiftsByMonth.length === 0) {
    console.log("  No time records found.");
  } else {
    let lastMonth = null;
    shiftsByMonth.forEach(r => {
      if (r.month !== lastMonth) {
        console.log(`\n  ── ${r.month} ──`);
        lastMonth = r.month;
      }
      console.log(
        `    ${(r.employee_name ?? "?").padEnd(30)} records:${String(r.record_count).padStart(4)}  check-ins:${String(r.check_ins).padStart(3)}  worked_hrs:${r.total_worked_hours}`
      );
    });
  }
}

// ─── 10. Summary ─────────────────────────────────────────────────────────────
section("10. SUMMARY");
const totalEmp     = Array.isArray(employees) ? employees.length : "?";
const totalPeriods = Array.isArray(periods)   ? periods.length   : "?";
const totalItems   = Array.isArray(items)     ? items.length     : "?";
const totalTR      = Array.isArray(timeRecords) ? timeRecords.length : "?";
const openCI       = Array.isArray(openCheckIns) ? openCheckIns.length : "?";
const importedTR   = Array.isArray(timeRecords) ? timeRecords.filter(r => r.note && r.note.includes("Imported")).length : "?";

console.log(`  Employees              : ${totalEmp}`);
console.log(`  Payroll periods        : ${totalPeriods}`);
console.log(`  Payroll items          : ${totalItems}`);
console.log(`  Active time records    : ${totalTR}`);
console.log(`    of which imported    : ${importedTR}`);
console.log(`  Open/orphan check-ins  : ${openCI}`);

if (Array.isArray(periods) && periods.length > 0) {
  console.log("\n  Payroll periods by status:");
  const byStatus = {};
  periods.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  Object.entries(byStatus).forEach(([s, n]) => console.log(`    ${s.padEnd(12)} : ${n}`));
}

db.close();
console.log("\n  ✓ Inspection complete. Database was opened read-only — nothing was modified.");
