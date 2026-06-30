#!/usr/bin/env node
/**
 * diagnose-payroll.js
 *
 * READ-ONLY diagnostic for payroll generation errors.
 * Run on the VPS to identify why "Erro ao gerar payroll" is thrown.
 *
 *   node scripts/diagnose-payroll.js
 *
 * Optional: supply a date range to test specifically:
 *   node scripts/diagnose-payroll.js --start 2026-01-01 --end 2026-01-31
 *
 * Does NOT generate or write any payroll data.
 */

"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DATABASE_PATH || "/var/www/restaurant-system/data/restaurant-system.db";

const args = process.argv.slice(2);
const startArg = args[args.indexOf("--start") + 1] || null;
const endArg   = args[args.indexOf("--end")   + 1] || null;

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error("Cannot open database:", e.message);
  process.exit(1);
}

function section(title) {
  console.log("\n" + "═".repeat(64));
  console.log("  " + title);
  console.log("═".repeat(64));
}

// ─── 1. payroll_items schema ──────────────────────────────────────────────────
section("1. payroll_items COLUMNS (via PRAGMA)");
try {
  const cols = db.prepare("PRAGMA table_info(payroll_items)").all();
  if (cols.length === 0) {
    console.log("  ⚠ Table payroll_items does NOT exist.");
  } else {
    console.log(`  Total columns: ${cols.length}`);
    const required = [
      "payroll_period_id","employee_id","employee_name","total_hours","regular_hours",
      "overtime_hours","hourly_rate","regular_pay","overtime_pay","gross_pay",
      "gross_pay_total","holiday_hours","holiday_pay","holiday_label","vacation_rate",
      "vacation_pay","vacation_payout","vacation_accrued","vacation_pay_schedule",
      "pay_date","cheque_number","wage_rate_label","cpp_deduction","cpp_employer",
      "cpp2_deduction","ei_deduction","ei_employer","federal_tax","provincial_tax",
      "total_deductions","net_pay","country","province","tax_year","pay_frequency",
      "pay_periods_per_year","pensionable_earnings","insurable_earnings","ytd_cpp",
      "ytd_cpp2","ytd_ei","ytd_federal_tax","ytd_provincial_tax","is_regular_day",
      "average_daily_wage","worked_on_holiday","holiday_pay_option","holiday_pay_calculated",
      "holiday_regular_weekday_count","holiday_adw_period_start","holiday_adw_period_end",
      "holiday_debug_notes","created_at","updated_at",
      // salaried columns
      "pay_type","salary_base","salary_vacation_pay","salary_bonus","vacation_pay_pct",
      // send columns
      "send_status","sent_at","payment_reference",
    ];
    const existingNames = new Set(cols.map(c => c.name));
    const missing = required.filter(n => !existingNames.has(n));
    if (missing.length === 0) {
      console.log("  ✓ All expected columns present.");
    } else {
      console.log(`  ⛔ MISSING COLUMNS (will cause INSERT to throw):`);
      missing.forEach(n => console.log(`     - ${n}`));
    }
    console.log("\n  All existing columns:");
    cols.forEach(c => console.log(`    ${c.name.padEnd(36)} type:${c.type}  notnull:${c.notnull}  dflt:${c.dflt_value}`));
  }
} catch (e) {
  console.error("  ERROR reading payroll_items schema:", e.message);
}

// ─── 2. payroll_item_alberta_holidays schema ──────────────────────────────────
section("2. payroll_item_alberta_holidays COLUMNS");
try {
  const cols = db.prepare("PRAGMA table_info(payroll_item_alberta_holidays)").all();
  if (cols.length === 0) {
    console.log("  ⚠ Table does NOT exist yet (will be created on first payroll generation).");
  } else {
    console.log(`  Total columns: ${cols.length}`);
    cols.forEach(c => console.log(`    ${c.name.padEnd(36)} type:${c.type}  dflt:${c.dflt_value}`));
  }
} catch (e) {
  console.error("  ERROR:", e.message);
}

// ─── 3. employees schema (pay_type, salary columns) ───────────────────────────
section("3. employees COLUMNS (pay_type, salary, federal/provincial claim)");
try {
  const cols = db.prepare("PRAGMA table_info(employees)").all();
  const relevant = ["pay_type","annual_salary","federal_claim_amount","provincial_claim_amount","accrued_vacation_balance","start_date","vacation_pay_schedule"];
  const existingNames = new Set(cols.map(c => c.name));
  relevant.forEach(n => {
    const present = existingNames.has(n) ? "✓" : "⛔ MISSING";
    console.log(`  ${present}  ${n}`);
  });
} catch (e) {
  console.error("  ERROR:", e.message);
}

// ─── 4. Active salaried employees ─────────────────────────────────────────────
section("4. SALARIED EMPLOYEES");
try {
  const hasSalaryCol = db.prepare("PRAGMA table_info(employees)").all().some(c => c.name === "annual_salary");
  if (!hasSalaryCol) {
    console.log("  ⚠ employees.annual_salary column does not exist — no salaried INSERT will run.");
  } else {
    const salaried = db.prepare(
      "SELECT id, name, annual_salary FROM employees WHERE is_active_employee = 1 AND pay_type = 'salaried' AND annual_salary > 0"
    ).all();
    if (salaried.length === 0) {
      console.log("  None — no salaried employees found (salaried INSERT block will be skipped).");
    } else {
      console.log(`  ${salaried.length} salaried employee(s):`);
      salaried.forEach(e => console.log(`    [${e.id}] ${e.name}  salary=$${e.annual_salary}/yr`));
    }
  }
} catch (e) {
  console.error("  ERROR:", e.message);
}

// ─── 5. Time records summary for date range ───────────────────────────────────
section("5. TIME RECORDS AVAILABLE FOR PAYROLL");

// Auto-detect date range if not supplied: use the earliest month with data
let startDate = startArg;
let endDate   = endArg;

if (!startDate || !endDate) {
  try {
    const row = db.prepare(
      "SELECT MIN(date(recorded_at)) AS mn, MAX(date(recorded_at)) AS mx FROM time_records WHERE deleted_at IS NULL"
    ).get();
    if (row && row.mn) {
      // Use the first full calendar month found
      const mn = new Date(row.mn + "T00:00:00Z");
      startDate = `${mn.getUTCFullYear()}-${String(mn.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(Date.UTC(mn.getUTCFullYear(), mn.getUTCMonth() + 1, 0));
      endDate = lastDay.toISOString().slice(0, 10);
      console.log(`  Auto-detected first month: ${startDate} → ${endDate}`);
    }
  } catch (e) {
    console.error("  Could not auto-detect date range:", e.message);
  }
}

if (!startDate || !endDate) {
  console.log("  No time records found — cannot test date range.");
} else {
  console.log(`  Testing range: ${startDate} → ${endDate}`);

  try {
    const records = db.prepare(`
      SELECT tr.id, tr.employee_id, e.name AS employee_name,
             tr.type, tr.entry_mode, tr.manual_category,
             tr.recorded_at, tr.worked_hours, tr.deleted_at
      FROM time_records tr
      LEFT JOIN employees e ON e.id = tr.employee_id
      WHERE tr.deleted_at IS NULL
        AND datetime(tr.recorded_at) >= datetime(?)
        AND datetime(tr.recorded_at) <= datetime(?)
      ORDER BY e.name ASC, datetime(tr.recorded_at) ASC, tr.id ASC
    `).all(`${startDate}T00:00:00`, `${endDate}T23:59:59`);

    console.log(`  Records found in range: ${records.length}`);
    if (records.length === 0) {
      console.log("  ⛔ NO RECORDS FOUND — payroll would have 0 employees, generating empty payroll.");
      console.log("     Check if recorded_at timezone offsets are shifting dates outside this range.");

      // Show a sample of records to see the raw recorded_at values
      const sample = db.prepare(
        "SELECT id, employee_id, type, recorded_at FROM time_records WHERE deleted_at IS NULL LIMIT 5"
      ).all();
      if (sample.length > 0) {
        console.log("\n  Sample recorded_at values from database:");
        sample.forEach(r => console.log(`    id=${r.id}  type=${r.type}  recorded_at=${r.recorded_at}`));
        console.log("\n  SQLite datetime() interpretation of first record:");
        const parsed = db.prepare(
          "SELECT datetime(recorded_at) AS dt FROM time_records WHERE deleted_at IS NULL LIMIT 1"
        ).get();
        console.log(`    datetime(recorded_at) = ${parsed?.dt}`);
      }
    } else {
      // Simulate the pairing logic
      const openCheckIns = new Map();
      const employeeHours = new Map();

      for (const record of records) {
        const key = String(record.employee_id);
        if (!employeeHours.has(key)) {
          employeeHours.set(key, { name: record.employee_name, pairs: 0, totalHours: 0 });
        }

        if (record.entry_mode === "manual") continue;

        if (record.type === "check-in") {
          openCheckIns.set(record.employee_id, record);
          continue;
        }

        const openRecord = openCheckIns.get(record.employee_id);
        if (!openRecord) continue;

        const start = new Date(openRecord.recorded_at);
        const end   = new Date(record.recorded_at);
        const hours = (end - start) / (1000 * 60 * 60);
        openCheckIns.delete(record.employee_id);

        if (hours > 0) {
          const emp = employeeHours.get(key);
          emp.pairs++;
          emp.totalHours += hours;
        }
      }

      console.log("\n  Computed hours per employee (simulation):");
      let anyWithHours = false;
      for (const [, emp] of employeeHours) {
        const hrs = emp.totalHours.toFixed(2);
        const marker = emp.totalHours > 0 ? "✓" : "─";
        console.log(`    ${marker} ${(emp.name ?? "?").padEnd(30)} pairs:${emp.pairs}  hours:${hrs}`);
        if (emp.totalHours > 0) anyWithHours = true;
      }

      if (!anyWithHours) {
        console.log("\n  ⛔ ALL employees have 0 computed hours in this range.");
        console.log("     generatePayroll would return an empty payroll (0 employees).");
        console.log("     This should NOT cause a 500 error — investigate the salaried employee path instead.");
      } else {
        console.log("\n  ✓ Hours computed successfully for at least one employee.");
        console.log("    The error is likely in the payroll INSERT or salaried employee path.");
      }

      // Check for orphan check-ins
      if (openCheckIns.size > 0) {
        console.log(`\n  ⚠ ${openCheckIns.size} unmatched check-in(s) at end of range:`);
        for (const [empId, r] of openCheckIns) {
          const name = employeeHours.get(String(empId))?.name ?? `employee_id=${empId}`;
          console.log(`    ${name}  check-in at ${r.recorded_at}`);
        }
      }
    }
  } catch (e) {
    console.error("  ⛔ QUERY ERROR:", e.message);
    console.error(e.stack);
  }
}

// ─── 6. Employees with no hourly rate ────────────────────────────────────────
section("6. EMPLOYEES WITH MISSING HOURLY RATE");
try {
  const missing = db.prepare(`
    SELECT id, name, pay_type, default_hourly_rate
    FROM employees
    WHERE COALESCE(is_active_employee, 1) = 1
      AND (COALESCE(pay_type, 'hourly') = 'hourly' OR pay_type IS NULL)
      AND (default_hourly_rate IS NULL OR default_hourly_rate <= 0)
  `).all();
  if (missing.length === 0) {
    console.log("  ✓ All active hourly employees have a valid rate.");
  } else {
    console.log("  ⛔ These employees have no hourly rate (will cause MISSING_EMPLOYEE_HOURLY_RATE → 409, not 500):");
    missing.forEach(e => console.log(`    [${e.id}] ${e.name}  rate=${e.default_hourly_rate}`));
  }
} catch (e) {
  console.error("  ERROR:", e.message);
}

// ─── 7. Test the actual generatePayroll function ───────────────────────────────
section("7. LIVE TEST — call generatePayroll directly");
console.log("  This loads the real server db.js and calls generatePayroll in a dry-run-like test.");
console.log("  The DB is opened normally (not read-only) to match what the server does.");
console.log("  If this throws, you'll see the EXACT error.\n");

if (!startDate || !endDate) {
  console.log("  Skipped — no date range available.");
} else {
  db.close(); // close our read-only handle before the live test
  try {
    // Load the real generatePayroll from db.js (this opens the DB in read-write mode)
    const dbModule = require(path.resolve(__dirname, "../db.js"));
    const generate = dbModule.generatePayroll;
    if (typeof generate !== "function") {
      console.log("  ⚠ generatePayroll is not exported from db.js — cannot run live test.");
    } else {
      console.log(`  Calling generatePayroll({ startDate: "${startDate}", endDate: "${endDate}" }) ...`);
      const result = generate({ startDate, endDate, payDate: endDate, adminUser: "diagnose-script" });
      console.log("  ✓ generatePayroll SUCCEEDED.");
      console.log(`    Payroll period ID : ${result?.payrollPeriodId}`);
      console.log(`    Items generated   : ${result?.items?.length ?? 0}`);
      console.log("\n  ⚠ A REAL payroll period was written to the database!");
      console.log("    Run the reset script or delete it manually if you don't want it:");
      console.log("    node scripts/reset-test-data.js --dry-run");
    }
  } catch (e) {
    console.log("  ⛔ generatePayroll THREW AN ERROR:");
    console.log(`    name    : ${e.name}`);
    console.log(`    code    : ${e.code ?? "(none)"}`);
    console.log(`    message : ${e.message}`);
    console.log("    stack   :");
    (e.stack || "").split("\n").forEach(line => console.log("      " + line));
  }
}
