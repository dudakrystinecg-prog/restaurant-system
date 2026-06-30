#!/usr/bin/env node
/**
 * import-timesheet.js
 *
 * Imports employee shifts from "2026 Time sheet.xlsx" into the time_records table.
 *
 * Usage:
 *   node scripts/import-timesheet.js --dry-run   (preview only, no DB writes)
 *   node scripts/import-timesheet.js --import    (write to DB — backup first!)
 *
 * Before running --import, create a backup:
 *
 *   mkdir -p /var/www/restaurant-system-backups
 *   cp /var/www/restaurant-system/data/restaurant-system.db \
 *      /var/www/restaurant-system-backups/restaurant-system.before-timesheet-import-$(date +%Y%m%d-%H%M%S).db
 *
 * Safety guarantees:
 *   - Never deletes or modifies existing time records
 *   - Never touches payroll, vacation, or holiday pay data
 *   - Skips duplicates (same employee + same recorded_at already exists)
 *   - Marks every inserted row: created_manually=1, note='Imported from 2026 Time sheet.xlsx'
 *   - Requires explicit --import flag to write anything
 *   - Requires a pre-import backup to exist in BACKUP_DIR before --import runs
 *     (unless --skip-backup-check is passed)
 */

"use strict";

const path = require("path");
const fs   = require("fs");

// ─── Config ──────────────────────────────────────────────────────────────────
const DB_PATH     = process.env.DATABASE_PATH || "/var/www/restaurant-system/data/restaurant-system.db";
const BACKUP_DIR  = "/var/www/restaurant-system-backups";
const BACKUP_PREFIX = "restaurant-system.before-timesheet-import-";
const YEAR      = 2026;
const IMPORT_NOTE = "Imported from 2026 Time sheet.xlsx";
// Timezone offset for Alberta:
// MST (Jan-Mar 8, Nov 2 onwards): UTC-7  → suffix "-07:00"
// MDT (Mar 8 - Nov 2):             UTC-6  → suffix "-06:00"
// We embed the offset so SQLite date() sees the correct local date.
// Switches for 2026: MDT starts Mar 8, ends Nov 1.
const MST_MONTHS = new Set([0, 1, 11]); // Jan, Feb, Dec (0-indexed)
const MDT_MONTHS = new Set([2,3,4,5,6,7,8,9,10]); // Mar-Nov, roughly safe

function tzOffset(monthIndex) {
  // Mar 8 – Nov 1 is MDT; everything else is MST
  // For simplicity use month-level approximation (close enough for shifts)
  if (monthIndex === 2 || monthIndex === 10) return "-07:00"; // March/November — conservative: use MST
  return MDT_MONTHS.has(monthIndex) ? "-06:00" : "-07:00";
}

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN           = args.includes("--dry-run");
const DO_IMPORT         = args.includes("--import");
const SKIP_BACKUP_CHECK = args.includes("--skip-backup-check");

// --file <path>  (required)
const fileArgIndex = args.indexOf("--file");
const XLSX_PATH = fileArgIndex !== -1 && args[fileArgIndex + 1]
  ? path.resolve(args[fileArgIndex + 1])
  : null;

if (!DRY_RUN && !DO_IMPORT) {
  console.error("Usage:");
  console.error('  node scripts/import-timesheet.js --dry-run --file "imports/2026 Time sheet.xlsx"');
  console.error('  node scripts/import-timesheet.js --import  --file "imports/2026 Time sheet.xlsx"');
  process.exit(1);
}
if (DRY_RUN && DO_IMPORT) {
  console.error("Error: cannot use both --dry-run and --import.");
  process.exit(1);
}
if (!XLSX_PATH) {
  console.error('Error: --file <path> is required.');
  console.error('Example: --file "imports/2026 Time sheet.xlsx"');
  process.exit(1);
}

// ─── Check dependencies ───────────────────────────────────────────────────────
let xl, Database;
try { xl = require("xlsx"); } catch (e) {
  console.error("Missing dependency: xlsx\nRun: npm install --no-save xlsx");
  process.exit(1);
}
try { Database = require("better-sqlite3"); } catch (e) {
  console.error("Missing dependency: better-sqlite3 (should already be installed)");
  process.exit(1);
}

// ─── Backup check (for --import only) ────────────────────────────────────────
if (DO_IMPORT && !SKIP_BACKUP_CHECK) {
  const backups = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db"))
    : [];
  if (backups.length === 0) {
    console.error("⛔  No pre-import backup found in:", BACKUP_DIR);
    console.error("    Run these commands first, then re-run --import:");
    console.error("");
    console.error("    mkdir -p /var/www/restaurant-system-backups");
    console.error("    cp /var/www/restaurant-system/data/restaurant-system.db \\");
    console.error("       /var/www/restaurant-system-backups/restaurant-system.before-timesheet-import-$(date +%Y%m%d-%H%M%S).db");
    console.error("");
    console.error("    (Override with --skip-backup-check only if you are absolutely sure.)");
    process.exit(1);
  }
  // Show most recent backup
  const latest = backups.sort().at(-1);
  console.log("✓ Backup found:", path.join(BACKUP_DIR, latest));
}

// ─── Parse Excel ──────────────────────────────────────────────────────────────
console.log("Reading:", XLSX_PATH);
if (!fs.existsSync(XLSX_PATH)) {
  console.error("File not found:", XLSX_PATH);
  process.exit(1);
}
const wb   = xl.readFile(XLSX_PATH);
const ws   = wb.Sheets["Sheet1"];
const rows = xl.utils.sheet_to_json(ws, { header: 1, defval: "" });

const MONTH_NAMES = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december"
];

// ─── Parse time range(s) from a cell ─────────────────────────────────────────
// Handles: "16:00-22:00", "10:00-16:00", "10-12,16-21:30" (split shifts)
// Returns array of { start: "HH:MM", end: "HH:MM" }
function parseTimeRanges(raw) {
  if (!raw || typeof raw !== "string") return [];
  const str = raw.trim().replace(/\s+/g, "");

  // Detect split shift: two ranges separated by comma
  // e.g. "10-12,16-21:30" or "10:00-12:00,16:00-21:30"
  // Strategy: split on comma, then each part is a range
  const parts = str.split(",");
  const ranges = [];

  for (const part of parts) {
    const range = parseSingleRange(part);
    if (range) ranges.push(range);
  }
  return ranges;
}

function parseSingleRange(str) {
  // Normalize: HH-HH:MM or H-H or HH:MM-HH:MM
  // Insert :00 where minutes are missing: "10" → "10:00", "16" → "16:00"
  const normalizeTime = (t) => {
    if (!t) return null;
    if (/^\d{1,2}$/.test(t)) return `${t.padStart(2,"0")}:00`;
    if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5,"0").replace(/^(\d):/, "0$1:");
    return null;
  };

  // Match HH:MM-HH:MM or H-H or H:MM-H:MM etc.
  const m = str.match(/^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/);
  if (!m) return null;
  const start = normalizeTime(m[1]);
  const end   = normalizeTime(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

// ─── Parse hours from cell (handle comma decimal) ─────────────────────────────
function parseHours(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const s = raw.trim().replace(",", ".");
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  return null;
}

// ─── Build ISO timestamp for a date + time string ─────────────────────────────
// Returns string like "2026-01-02T16:00:00-07:00"
// Uses UTC date parts to avoid local-machine-timezone distortion.
function buildTimestamp(dateObj, timeStr, monthIndex) {
  const yyyy = dateObj.getUTCFullYear();
  const mm   = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(dateObj.getUTCDate()).padStart(2, "0");
  const offset = tzOffset(monthIndex);
  return `${yyyy}-${mm}-${dd}T${timeStr}:00${offset}`;
}

// ─── Extract month sections ───────────────────────────────────────────────────
const sections = []; // { monthIndex, monthName, startRow, endRow, employees: [{name, col}] }

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const cell0 = typeof row[0] === "string" ? row[0].trim().toLowerCase() : "";
  const monthIdx = MONTH_NAMES.indexOf(cell0);
  if (monthIdx === -1) continue;

  // Employee names are in this row at cols 3,5,7,9,11,13,15,17,19,21
  const employees = [];
  for (let c = 3; c <= 21; c += 2) {
    const name = typeof row[c] === "string" ? row[c].trim() : "";
    if (name && name !== "Time" && name !== "Hours") {
      employees.push({ name, col: c });
    }
  }

  // Find end of section (next month row or "Total" row)
  let endRow = i + 1;
  while (endRow < rows.length) {
    const r0 = rows[endRow];
    const c0 = typeof r0[0] === "string" ? r0[0].trim() : "";
    if (MONTH_NAMES.indexOf(c0.toLowerCase()) !== -1 && endRow > i) break;
    if (c0 === "Total") { endRow++; break; }
    endRow++;
  }

  sections.push({ monthIndex: monthIdx, monthName: MONTH_NAMES[monthIdx], startRow: i, endRow, employees });
}

console.log(`Found ${sections.length} month sections:`, sections.map(s => s.monthName).join(", "));
sections.forEach(s => {
  console.log(`  ${s.monthName}: employees = [${s.employees.map(e => `${e.name}(col${e.col})`).join(", ")}]`);
});

// ─── Parse all shifts ─────────────────────────────────────────────────────────
const IMPORT_SOURCE = IMPORT_NOTE;

const parsed = []; // { monthName, monthIndex, date, dateStr, employeeName, start, end, rawTime, rawHours, splitIndex }
const invalidRows = [];

for (const section of sections) {
  const { monthIndex, monthName, startRow, endRow, employees } = section;

  // Find first data row (col[0] is a number = Excel serial)
  let firstDataRow = -1;
  for (let i = startRow + 1; i < endRow; i++) {
    if (typeof rows[i][0] === "number") { firstDataRow = i; break; }
  }
  if (firstDataRow === -1) {
    console.warn(`  WARNING: No data rows found in ${monthName}`);
    continue;
  }

  let dayIndex = 0; // 0 = day 1 of month
  for (let i = firstDataRow; i < endRow; i++) {
    const row = rows[i];
    if (typeof row[0] !== "number") continue; // skip header/total/blank rows

    const dateObj = new Date(Date.UTC(YEAR, monthIndex, 1 + dayIndex));
    const dateStr = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD from UTC
    const dayLabel = typeof row[2] === "string" ? row[2].trim() : "";

    // Sanity check: computed day-of-week vs spreadsheet label (UTC to avoid tz distortion)
    const DOW_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const computed  = DOW_SHORT[dateObj.getUTCDay()];
    const labelMap  = { Mon:"Mon",Tues:"Tue",Wed:"Wed",Thurs:"Thu",Fri:"Fri",Sat:"Sat",Sun:"Sun" };
    const expected  = labelMap[dayLabel];
    if (expected && expected !== computed) {
      invalidRows.push({
        reason: "Day-of-week mismatch",
        month: monthName, excelRow: i + 1, dateStr, dayLabel,
        computed, note: "Date offset may be wrong for this section — check manually"
      });
    }

    dayIndex++;

    // Per-employee columns
    for (const emp of employees) {
      const rawTime  = row[emp.col];
      const rawHours = row[emp.col + 1];

      if (rawTime === "" || rawTime === null || rawTime === undefined) continue;

      // Skip annotation cells (not a valid time range)
      if (typeof rawTime !== "string" || !/\d.*-.*\d/.test(rawTime)) {
        if (rawTime !== "") {
          invalidRows.push({
            reason: "Non-time value in Time cell (skipped)",
            month: monthName, excelRow: i + 1, employee: emp.name,
            rawTime: String(rawTime), rawHours: String(rawHours)
          });
        }
        continue;
      }

      const ranges = parseTimeRanges(rawTime);
      if (ranges.length === 0) {
        invalidRows.push({
          reason: "Could not parse time range",
          month: monthName, excelRow: i + 1, employee: emp.name,
          rawTime: String(rawTime)
        });
        continue;
      }

      ranges.forEach((range, splitIdx) => {
        parsed.push({
          monthName,
          monthIndex,
          date: dateObj,
          dateStr,
          employeeName: emp.name,
          start: range.start,
          end: range.end,
          rawTime: String(rawTime),
          rawHours: rawHours,
          splitIndex: splitIdx,
        });
      });
    }
  }
}

console.log(`\nParsed ${parsed.length} shifts total, ${invalidRows.length} invalid/skipped rows.`);

// ─── Open DB (read-only for dry-run) ─────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: DRY_RUN });

// Load employees from DB
const dbEmployees = db.prepare("SELECT id, name FROM employees WHERE deleted_at IS NULL OR deleted_at = ''").all()
  .concat(db.prepare("SELECT id, name FROM employees WHERE 1=1").all()) // catch all
  .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i); // dedupe

// Actually just load all employees without filter since former employees might be in DB
const allDbEmployees = db.prepare("SELECT id, name FROM employees").all();

// ─── Name matching ────────────────────────────────────────────────────────────
// Normalize: lowercase, collapse whitespace
const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

const nameMap = new Map(); // xlsxName → dbEmployee | null
const unmatchedNames = new Set();

// Collect all unique spreadsheet employee names
const xlsxNames = new Set(parsed.map(p => p.employeeName));

for (const xlName of xlsxNames) {
  const xlNorm = normalize(xlName);

  // 1. Exact match (case-insensitive)
  let match = allDbEmployees.find(e => normalize(e.name) === xlNorm);

  // 2. Fuzzy: first+last word match
  if (!match) {
    const xlParts = xlNorm.split(" ");
    match = allDbEmployees.find(e => {
      const dbParts = normalize(e.name).split(" ");
      // All parts of shorter name appear in longer name
      const shorter = xlParts.length <= dbParts.length ? xlParts : dbParts;
      const longer  = xlParts.length <= dbParts.length ? dbParts : xlParts;
      return shorter.every(p => longer.includes(p));
    });
  }

  if (match) {
    nameMap.set(xlName, match);
  } else {
    nameMap.set(xlName, null);
    unmatchedNames.add(xlName);
  }
}

// ─── Summary by employee and month ───────────────────────────────────────────
const byEmployee = {};
const byMonth    = {};

for (const shift of parsed) {
  const db_emp = nameMap.get(shift.employeeName);
  if (!db_emp) continue; // unmatched

  byEmployee[shift.employeeName] = (byEmployee[shift.employeeName] || 0) + 1;
  byMonth[shift.monthName]       = (byMonth[shift.monthName] || 0) + 1;
}

// ─── Duplicate check ──────────────────────────────────────────────────────────
const existsStmt = db.prepare(`
  SELECT id FROM time_records
  WHERE employee_id = ? AND recorded_at = ? AND (deleted_at IS NULL OR deleted_at = '')
  LIMIT 1
`);

// ─── Insert statement (only used in --import mode) ───────────────────────────
const insertStmt = DO_IMPORT ? db.prepare(`
  INSERT INTO time_records (
    employee_id, type, entry_mode, manual_category,
    recorded_at, worked_hours, note, created_manually, updated_at, deleted_at
  ) VALUES (?, ?, 'clock', 'regular', ?, 0, ?, 1, ?, NULL)
`) : null;

// ─── Process shifts ───────────────────────────────────────────────────────────
let willInsert  = 0;
let willSkipDup = 0;
let willSkipUnmatched = 0;
const skippedDuplicates = [];
const skippedUnmatched  = [];
const toInsert = []; // for dry-run reporting

const now = new Date().toISOString();

for (const shift of parsed) {
  const dbEmp = nameMap.get(shift.employeeName);
  if (!dbEmp) {
    willSkipUnmatched++;
    skippedUnmatched.push(shift.employeeName);
    continue;
  }

  const checkInTs  = buildTimestamp(shift.date, shift.start, shift.monthIndex);
  const checkOutTs = buildTimestamp(shift.date, shift.end,   shift.monthIndex);
  const splitNote  = shift.splitIndex > 0 ? ` (split shift ${shift.splitIndex + 1})` : "";
  const note       = IMPORT_SOURCE + splitNote;

  // Check for duplicates
  const dupIn  = existsStmt.get(dbEmp.id, checkInTs);
  const dupOut = existsStmt.get(dbEmp.id, checkOutTs);
  if (dupIn || dupOut) {
    willSkipDup++;
    skippedDuplicates.push({
      employee: shift.employeeName, date: shift.dateStr,
      time: `${shift.start}-${shift.end}`,
      existing: dupIn ? `check-in id=${dupIn.id}` : `check-out id=${dupOut.id}`
    });
    continue;
  }

  willInsert += 2; // check-in + check-out pair
  if (DRY_RUN) {
    toInsert.push(
      { employee: shift.employeeName, dbId: dbEmp.id, type: "check-in",  recorded_at: checkInTs,  note },
      { employee: shift.employeeName, dbId: dbEmp.id, type: "check-out", recorded_at: checkOutTs, note }
    );
  }

  if (DO_IMPORT) {
    insertStmt.run(dbEmp.id, "check-in",  checkInTs,  note, now);
    insertStmt.run(dbEmp.id, "check-out", checkOutTs, note, now);
  }
}

db.close();

// ─── Report ──────────────────────────────────────────────────────────────────
const mode = DRY_RUN ? "DRY-RUN PREVIEW" : "IMPORT COMPLETE";
console.log(`\n${"=".repeat(60)}`);
console.log(`  ${mode}`);
console.log("=".repeat(60));

console.log("\n── Totals by month ──");
for (const [month, count] of Object.entries(byMonth)) {
  console.log(`  ${month.padEnd(12)} ${count} matched shifts`);
}

console.log("\n── Totals by employee ──");
for (const [name, count] of Object.entries(byEmployee)) {
  const dbEmp = nameMap.get(name);
  console.log(`  ${name.padEnd(25)} → DB: ${dbEmp ? `id=${dbEmp.id} "${dbEmp.name}"` : "UNMATCHED"} — ${count} shifts`);
}

if (unmatchedNames.size > 0) {
  console.log(`\n⚠️  UNMATCHED NAMES (${unmatchedNames.size}) — these shifts will NOT be imported:`);
  for (const n of unmatchedNames) {
    console.log(`  "${n}"  → no matching employee in DB`);
  }
  console.log("  → Add employees to DB or update name map in this script.");
}

if (skippedDuplicates.length > 0) {
  console.log(`\n⚠️  DUPLICATES SKIPPED (${skippedDuplicates.length}):`);
  skippedDuplicates.slice(0, 10).forEach(d =>
    console.log(`  ${d.employee} ${d.date} ${d.time} — ${d.existing}`)
  );
  if (skippedDuplicates.length > 10) console.log(`  ... and ${skippedDuplicates.length - 10} more`);
}

if (invalidRows.length > 0) {
  console.log(`\n⚠️  INVALID / SKIPPED ROWS (${invalidRows.length}):`);
  invalidRows.forEach(r =>
    console.log(`  Row ${r.excelRow} ${r.month} ${r.employee || ""}: [${r.reason}] raw="${r.rawTime || r.note || ""}"`)
  );
}

console.log(`\n── Summary ──`);
console.log(`  Total shifts parsed:      ${parsed.length}`);
console.log(`  Shifts skipped (unmatched): ${willSkipUnmatched / 1} names`);
console.log(`  Shifts skipped (duplicate): ${willSkipDup}`);
console.log(`  Records to insert (pairs):  ${willInsert} (${willInsert / 2} check-in/check-out pairs)`);

if (DRY_RUN) {
  console.log("\n  This was a DRY RUN. Nothing was written to the database.");
  console.log("  To import, run these commands on the VPS:");
  console.log("");
  console.log("    mkdir -p /var/www/restaurant-system-backups");
  console.log("    cp /var/www/restaurant-system/data/restaurant-system.db \\");
  console.log("       /var/www/restaurant-system-backups/restaurant-system.before-timesheet-import-$(date +%Y%m%d-%H%M%S).db");
  console.log("");
  console.log("    node scripts/import-timesheet.js --import");
}

if (DO_IMPORT) {
  console.log(`\n✅ Import complete. ${willInsert} records inserted.`);
  console.log("   Next: use Admin → Payroll to generate payrolls for each pay period.");
}
