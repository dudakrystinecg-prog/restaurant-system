const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { hashPin, verifyPin } = require("./security");
const config = require("./config");
const {
  COUNTRY: PAYROLL_COUNTRY,
  PROVINCE: PAYROLL_PROVINCE,
  TAX_YEAR: PAYROLL_TAX_YEAR,
  PAY_FREQUENCIES,
  DEFAULT_PAY_FREQUENCY,
  getPayFrequencyConfig,
  calculateAlbertaPayrollDeductions2026,
} = require("./payrollRules/canada/2026/alberta");

const dataDirectory = path.join(__dirname, "data");
const databasePath = path.resolve(config.databasePath);
const databaseDirectory = path.dirname(databasePath);

if (!fs.existsSync(databaseDirectory)) {
  fs.mkdirSync(databaseDirectory, { recursive: true });
}

const db = new Database(databasePath);

const PAYROLL_OVERTIME_RULE = {
  type: "daily",
  regularHoursPerDay: 8,
  overtimeMultiplier: 1.5,
};

const HOLIDAY_PAY_RULE = {
  type: "hours_or_manual_amount",
  multiplier: 1.5,
  description:
    "Holiday pay can be entered as a manual amount or derived from holiday hours at 1.5x the hourly rate. Use it for Family Day, general holiday pay, or other extra holiday earnings paid in the current period.",
};
const VACATION_PAY_SCHEDULES = {
  monthly: {
    code: "monthly",
    label: "Monthly payout",
  },
  accrued: {
    code: "accrued",
    label: "Accrued balance",
  },
};
const DEFAULT_VACATION_PAY_SCHEDULE = "monthly";
const VACATION_PAY_RULE = {
  type: "service_based_percentage",
  firstYearRate: 0,
  underFiveYearsRate: 0.04,
  fiveYearsOrMoreRate: 0.06,
  description:
    "Vacation pay is calculated at 0% during the first year of service, 4% after 1 year, and 6% after 5 years. Monthly schedules include vacation pay in the current payroll. Accrued schedules store the value in the employee vacation balance and exclude it from the current payout.",
};
const DEFAULT_AUDIT_PAGE_SIZE = 10;
const MAX_AUDIT_PAGE_SIZE = 100;

function calculatePayrollDeductions({
  grossPayTotal,
  payFrequency,
  ytd,
}) {
  return calculateAlbertaPayrollDeductions2026({
    grossPayTotal,
    payFrequency,
    ytd,
  });
}

function roundMoney(value) {
  return Number((Number(value || 0)).toFixed(2));
}

function calculateEmployerContributions({ cppEmployee, eiEmployee }) {
  return {
    cpp_employer: roundMoney(cppEmployee),
    ei_employer: roundMoney(eiEmployee * 1.4),
  };
}

// ─── Alberta General Holiday Pay helpers (Phase 2) ───────────────────────────

/**
 * 5 of 9 rule: count how many of the 9 prior same-weekday dates the employee worked.
 * "Worked" = has at least one non-deleted time record on that calendar date.
 */
function isRegularDayOfWork(employeeId, holidayDate) {
  const refDate = new Date(holidayDate + "T12:00:00");
  const weekday = refDate.getDay(); // 0=Sun … 6=Sat

  // Build the 9 previous occurrences of the same weekday
  const checkedDates = [];
  let cursor = new Date(refDate);
  cursor.setDate(cursor.getDate() - 7);
  while (checkedDates.length < 9) {
    if (cursor.getDay() === weekday) {
      checkedDates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  // Count dates where employee has at least one non-deleted time record
  const stmt = db.prepare(`
    SELECT COUNT(DISTINCT date(recorded_at)) AS worked_days
    FROM time_records
    WHERE employee_id = ?
      AND deleted_at IS NULL
      AND date(recorded_at) IN (${checkedDates.map(() => "?").join(",")})
  `);
  const row = stmt.get(employeeId, ...checkedDates);
  const sameWeekdayWorkedCount = Number(row?.worked_days || 0);

  return {
    isRegularDay: sameWeekdayWorkedCount >= 5,
    sameWeekdayWorkedCount,
    checkedDates,
  };
}

/**
 * Average Daily Wage from the 4 weeks immediately before the holiday.
 * ADW = sum of regular eligible wages ÷ number of distinct days worked.
 * Overtime premium is excluded (only base rate × regular hours).
 */
function calculateAverageDailyWage(employeeId, holidayDate) {
  const endRef = new Date(holidayDate + "T00:00:00");
  endRef.setDate(endRef.getDate() - 1);
  const periodEnd = endRef.toISOString().slice(0, 10);

  const startRef = new Date(endRef);
  startRef.setDate(startRef.getDate() - 27); // 4 weeks = 28 days
  const periodStart = startRef.toISOString().slice(0, 10);

  // Get worked hours and rate from time records in the window.
  // We use worked_hours on records whose manual_category is 'regular' or entry_mode='clock'.
  // Holiday records are excluded so their premium does not inflate ADW.
  const rows = db.prepare(`
    SELECT
      date(recorded_at) AS work_date,
      SUM(worked_hours) AS day_hours
    FROM time_records
    WHERE employee_id = ?
      AND deleted_at IS NULL
      AND date(recorded_at) BETWEEN ? AND ?
      AND (manual_category IS NULL OR manual_category = 'regular')
      AND worked_hours > 0
    GROUP BY date(recorded_at)
  `).all(employeeId, periodStart, periodEnd);

  // Fetch the employee's current hourly rate (best available)
  const emp = db.prepare("SELECT default_hourly_rate FROM employees WHERE id = ?").get(employeeId);
  const hourlyRate = Number(emp?.default_hourly_rate || 0);

  let totalEligibleWages = 0;
  let daysWorked = 0;

  for (const row of rows) {
    // Cap at PAYROLL_OVERTIME_RULE.regularHoursPerDay for ADW (exclude OT premium)
    const regularHours = Math.min(
      Number(row.day_hours || 0),
      PAYROLL_OVERTIME_RULE.regularHoursPerDay
    );
    totalEligibleWages += regularHours * hourlyRate;
    daysWorked += 1;
  }

  totalEligibleWages = roundMoney(totalEligibleWages);
  const averageDailyWage = daysWorked > 0
    ? roundMoney(totalEligibleWages / daysWorked)
    : 0;

  return { averageDailyWage, totalEligibleWages, daysWorked, periodStart, periodEnd };
}

/**
 * Check whether the employee worked on the specific holiday date.
 * "Worked" = has non-deleted time records on that date with worked_hours > 0.
 */
function didEmployeeWorkHoliday(employeeId, holidayDate) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS record_count,
      COALESCE(SUM(worked_hours), 0) AS total_hours
    FROM time_records
    WHERE employee_id = ?
      AND deleted_at IS NULL
      AND date(recorded_at) = ?
      AND worked_hours > 0
  `).get(employeeId, holidayDate);

  const holidayHours = Number(row?.total_hours || 0);
  return {
    workedOnHoliday: holidayHours > 0,
    holidayHours,
  };
}

/**
 * Calculate Alberta-compliant holiday pay for the four cases.
 * Does NOT touch net pay — caller stores result in holiday_pay_calculated only.
 */
function calculateAlbertaHolidayPay({
  isRegularDay,
  workedOnHoliday,
  averageDailyWage,
  holidayHours,
  hourlyRate,
  option = "premium_pay",
}) {
  const adw = roundMoney(Number(averageDailyWage || 0));
  const hours = Number(holidayHours || 0);
  const rate = Number(hourlyRate || 0);

  if (!isRegularDay) {
    // Not a regular workday
    if (workedOnHoliday) {
      // Case d: not regular + worked → 1.5x
      return roundMoney(hours * rate * 1.5);
    }
    // Case e: not regular + did not work → $0
    return 0;
  }

  // Is a regular workday
  if (!workedOnHoliday) {
    // Case a: regular + did not work → ADW
    return adw;
  }

  // Case b/c: regular + worked
  if (option === "future_day_off") {
    // Employer chooses future paid day off: pay regular rate now; ADW paid later
    return roundMoney(hours * rate);
  }
  // Default premium_pay: ADW + 1.5x for hours worked
  return roundMoney(adw + hours * rate * 1.5);
}

/**
 * Fetch the Alberta holiday record for a given date, if it exists.
 */
function getHolidayForDate(date) {
  return db.prepare(
    "SELECT * FROM holidays WHERE date = ? AND is_general_holiday = 1"
  ).get(date) || null;
}

/**
 * List all holidays (for admin UI).
 */
function listHolidays() {
  return db.prepare("SELECT * FROM holidays ORDER BY date ASC").all();
}

/**
 * Find all Alberta general holidays whose date falls within [startDate, endDate].
 */
function getHolidaysInPeriod(startDate, endDate) {
  return db.prepare(`
    SELECT * FROM holidays
    WHERE province = 'AB' AND is_general_holiday = 1
      AND date BETWEEN ? AND ?
    ORDER BY date ASC
  `).all(startDate, endDate);
}

/**
 * Compute the Alberta holiday row for one employee × one holiday.
 * Returns the full data object ready to insert/update.
 */
function computeAlbertaHolidayRow({
  payrollItemId,
  payrollPeriodId,
  employeeId,
  holiday,
  employeeRate,
}) {
  const regularDayResult = isRegularDayOfWork(employeeId, holiday.date);
  const adwResult = calculateAverageDailyWage(employeeId, holiday.date);
  const workedResult = didEmployeeWorkHoliday(employeeId, holiday.date);

  const holidayPayCalculated = calculateAlbertaHolidayPay({
    isRegularDay: regularDayResult.isRegularDay,
    workedOnHoliday: workedResult.workedOnHoliday,
    averageDailyWage: adwResult.averageDailyWage,
    holidayHours: workedResult.holidayHours,
    hourlyRate: employeeRate,
    option: "premium_pay",
  });

  return {
    payroll_item_id: payrollItemId,
    payroll_period_id: payrollPeriodId,
    employee_id: employeeId,
    holiday_id: holiday.id,
    holiday_date: holiday.date,
    holiday_name: holiday.name,
    is_regular_day: regularDayResult.isRegularDay ? 1 : 0,
    weekday_count: regularDayResult.sameWeekdayWorkedCount,
    checked_dates: JSON.stringify(regularDayResult.checkedDates),
    average_daily_wage: adwResult.averageDailyWage,
    adw_period_start: adwResult.periodStart,
    adw_period_end: adwResult.periodEnd,
    adw_days_worked: adwResult.daysWorked,
    adw_total_wages: adwResult.totalEligibleWages,
    worked_on_holiday: workedResult.workedOnHoliday ? 1 : 0,
    holiday_hours_worked: workedResult.holidayHours,
    holiday_pay_calculated: holidayPayCalculated,
    // Resolved = auto values (no override yet)
    resolved_is_regular_day: regularDayResult.isRegularDay ? 1 : 0,
    resolved_worked_on_holiday: workedResult.workedOnHoliday ? 1 : 0,
    resolved_holiday_hours: workedResult.holidayHours,
    resolved_average_daily_wage: adwResult.averageDailyWage,
    resolved_holiday_pay_calculated: holidayPayCalculated,
    resolved_holiday_pay_option: "premium_pay",
  };
}

/**
 * Insert or regenerate auto Alberta holiday rows for a payroll item.
 * Only runs when is_manual_override = 0.
 */
function upsertAlbertaHolidayAutoRows({ payrollItemId, payrollPeriodId, employeeId, startDate, endDate, employeeRate }) {
  const holidays = getHolidaysInPeriod(startDate, endDate);
  const timestamp = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO payroll_item_alberta_holidays (
      payroll_item_id, payroll_period_id, employee_id,
      holiday_id, holiday_date, holiday_name,
      is_regular_day, weekday_count, checked_dates,
      average_daily_wage, adw_period_start, adw_period_end, adw_days_worked, adw_total_wages,
      worked_on_holiday, holiday_hours_worked, holiday_pay_calculated,
      resolved_is_regular_day, resolved_worked_on_holiday, resolved_holiday_hours,
      resolved_average_daily_wage, resolved_holiday_pay_calculated, resolved_holiday_pay_option,
      is_manual_override, created_at, updated_at
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?
    )
    ON CONFLICT(payroll_item_id, holiday_id) DO UPDATE SET
      is_regular_day = excluded.is_regular_day,
      weekday_count = excluded.weekday_count,
      checked_dates = excluded.checked_dates,
      average_daily_wage = excluded.average_daily_wage,
      adw_period_start = excluded.adw_period_start,
      adw_period_end = excluded.adw_period_end,
      adw_days_worked = excluded.adw_days_worked,
      adw_total_wages = excluded.adw_total_wages,
      worked_on_holiday = excluded.worked_on_holiday,
      holiday_hours_worked = excluded.holiday_hours_worked,
      holiday_pay_calculated = excluded.holiday_pay_calculated,
      resolved_is_regular_day = CASE WHEN is_manual_override = 1 THEN resolved_is_regular_day ELSE excluded.resolved_is_regular_day END,
      resolved_worked_on_holiday = CASE WHEN is_manual_override = 1 THEN resolved_worked_on_holiday ELSE excluded.resolved_worked_on_holiday END,
      resolved_holiday_hours = CASE WHEN is_manual_override = 1 THEN resolved_holiday_hours ELSE excluded.resolved_holiday_hours END,
      resolved_average_daily_wage = CASE WHEN is_manual_override = 1 THEN resolved_average_daily_wage ELSE excluded.resolved_average_daily_wage END,
      resolved_holiday_pay_calculated = CASE WHEN is_manual_override = 1 THEN resolved_holiday_pay_calculated ELSE excluded.resolved_holiday_pay_calculated END,
      updated_at = excluded.updated_at
    WHERE is_manual_override = 0
  `);

  for (const holiday of holidays) {
    try {
      const row = computeAlbertaHolidayRow({ payrollItemId, payrollPeriodId, employeeId, holiday, employeeRate });
      upsert.run(
        row.payroll_item_id, row.payroll_period_id, row.employee_id,
        row.holiday_id, row.holiday_date, row.holiday_name,
        row.is_regular_day, row.weekday_count, row.checked_dates,
        row.average_daily_wage, row.adw_period_start, row.adw_period_end, row.adw_days_worked, row.adw_total_wages,
        row.worked_on_holiday, row.holiday_hours_worked, row.holiday_pay_calculated,
        row.resolved_is_regular_day, row.resolved_worked_on_holiday, row.resolved_holiday_hours,
        row.resolved_average_daily_wage, row.resolved_holiday_pay_calculated, row.resolved_holiday_pay_option,
        timestamp, timestamp,
      );
    } catch (e) {
      // Log but don't crash payroll generation
      console.error(`Alberta holiday calc error for employee ${employeeId}, holiday ${holiday.date}:`, e.message);
    }
  }
}

/**
 * Fetch all Alberta holiday rows for a payroll period (all employees).
 */
function getAlbertaHolidaysForPayroll(payrollPeriodId) {
  return db.prepare(`
    SELECT h.*, e.name AS employee_name
    FROM payroll_item_alberta_holidays h
    LEFT JOIN employees e ON e.id = h.employee_id
    WHERE h.payroll_period_id = ?
    ORDER BY h.holiday_date ASC, e.name ASC
  `).all(payrollPeriodId);
}

/**
 * Save a manual override for one employee × holiday row.
 * Recalculates resolved_holiday_pay_calculated from the override inputs.
 */
function saveAlbertaHolidayOverride({
  payrollPeriodId,
  payrollItemId,
  holidayId,
  overrideIsRegularDay,
  overrideWorkedOnHoliday,
  overrideHolidayHours,
  overrideAverageDailyWage,
  overrideHolidayPayOption,
  overrideNotes,
  employeeRate,
}) {
  const row = db.prepare(`
    SELECT * FROM payroll_item_alberta_holidays
    WHERE payroll_item_id = ? AND holiday_id = ?
  `).get(payrollItemId, holidayId);

  if (!row) return null;

  const resolvedPayCalculated = calculateAlbertaHolidayPay({
    isRegularDay: Boolean(overrideIsRegularDay),
    workedOnHoliday: Boolean(overrideWorkedOnHoliday),
    averageDailyWage: Number(overrideAverageDailyWage || 0),
    holidayHours: Number(overrideHolidayHours || 0),
    hourlyRate: Number(employeeRate || 0),
    option: overrideHolidayPayOption || "premium_pay",
  });

  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE payroll_item_alberta_holidays SET
      is_manual_override = 1,
      override_is_regular_day = ?,
      override_worked_on_holiday = ?,
      override_holiday_hours = ?,
      override_average_daily_wage = ?,
      override_holiday_pay_option = ?,
      override_notes = ?,
      resolved_is_regular_day = ?,
      resolved_worked_on_holiday = ?,
      resolved_holiday_hours = ?,
      resolved_average_daily_wage = ?,
      resolved_holiday_pay_calculated = ?,
      resolved_holiday_pay_option = ?,
      updated_at = ?
    WHERE payroll_item_id = ? AND holiday_id = ?
  `).run(
    overrideIsRegularDay ? 1 : 0,
    overrideWorkedOnHoliday ? 1 : 0,
    Number(overrideHolidayHours || 0),
    Number(overrideAverageDailyWage || 0),
    overrideHolidayPayOption || "premium_pay",
    overrideNotes || null,
    overrideIsRegularDay ? 1 : 0,
    overrideWorkedOnHoliday ? 1 : 0,
    Number(overrideHolidayHours || 0),
    Number(overrideAverageDailyWage || 0),
    resolvedPayCalculated,
    overrideHolidayPayOption || "premium_pay",
    timestamp,
    payrollItemId,
    holidayId,
  );

  return db.prepare(`SELECT * FROM payroll_item_alberta_holidays WHERE payroll_item_id = ? AND holiday_id = ?`)
    .get(payrollItemId, holidayId);
}

/**
 * Clear manual override — revert to auto for one employee × holiday.
 */
function clearAlbertaHolidayOverride({ payrollItemId, holidayId }) {
  const row = db.prepare(`
    SELECT * FROM payroll_item_alberta_holidays WHERE payroll_item_id = ? AND holiday_id = ?
  `).get(payrollItemId, holidayId);
  if (!row) return null;

  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE payroll_item_alberta_holidays SET
      is_manual_override = 0,
      override_is_regular_day = NULL,
      override_worked_on_holiday = NULL,
      override_holiday_hours = NULL,
      override_average_daily_wage = NULL,
      override_notes = NULL,
      resolved_is_regular_day = is_regular_day,
      resolved_worked_on_holiday = worked_on_holiday,
      resolved_holiday_hours = holiday_hours_worked,
      resolved_average_daily_wage = average_daily_wage,
      resolved_holiday_pay_calculated = holiday_pay_calculated,
      updated_at = ?
    WHERE payroll_item_id = ? AND holiday_id = ?
  `).run(timestamp, payrollItemId, holidayId);

  return db.prepare(`SELECT * FROM payroll_item_alberta_holidays WHERE payroll_item_id = ? AND holiday_id = ?`)
    .get(payrollItemId, holidayId);
}

// ─── End Alberta helpers ──────────────────────────────────────────────────────

function calculateHolidayPayAmount({ holidayPay, holidayHours, hourlyRate }) {
  if (holidayPay !== undefined && holidayPay !== null && holidayPay !== "") {
    return roundMoney(Number(holidayPay));
  }

  return roundMoney(
    Number(holidayHours || 0) *
      Number(hourlyRate || 0) *
      HOLIDAY_PAY_RULE.multiplier,
  );
}

function buildChequeNumber(prefix, itemIndex) {
  if (!prefix) {
    return null;
  }

  return `${prefix}-${String(itemIndex + 1).padStart(3, "0")}`;
}

function normalizeVacationPaySchedule(value) {
  return VACATION_PAY_SCHEDULES[value]
    ? value
    : DEFAULT_VACATION_PAY_SCHEDULE;
}

function getYearsOfService(startDate, referenceDate) {
  if (!startDate || !referenceDate) {
    return 0;
  }

  const start = new Date(`${startDate}T00:00:00`);
  const reference = new Date(`${referenceDate}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(reference.getTime())) {
    return 0;
  }

  let years = reference.getUTCFullYear() - start.getUTCFullYear();
  const referenceMonth = reference.getUTCMonth();
  const startMonth = start.getUTCMonth();

  if (
    referenceMonth < startMonth ||
    (referenceMonth === startMonth && reference.getUTCDate() < start.getUTCDate())
  ) {
    years -= 1;
  }

  return Math.max(0, years);
}

function getVacationRateForServiceYears(yearsOfService) {
  if (yearsOfService >= 5) {
    return VACATION_PAY_RULE.fiveYearsOrMoreRate;
  }

  if (yearsOfService >= 1) {
    return VACATION_PAY_RULE.underFiveYearsRate;
  }

  return VACATION_PAY_RULE.firstYearRate;
}

function calculateVacationPayForEmployee({
  startDate,
  payrollEndDate,
  vacationPaySchedule,
  baseGrossPay,
}) {
  const normalizedSchedule = normalizeVacationPaySchedule(vacationPaySchedule);
  const yearsOfService = getYearsOfService(startDate, payrollEndDate);
  const vacationRate = getVacationRateForServiceYears(yearsOfService);
  const vacationPay = roundMoney(baseGrossPay * vacationRate);
  const vacationPayout =
    normalizedSchedule === "monthly" ? vacationPay : 0;
  const vacationAccrued =
    normalizedSchedule === "accrued" ? vacationPay : 0;

  return {
    years_of_service: yearsOfService,
    vacation_rate: vacationRate,
    vacation_pay: vacationPay,
    vacation_payout: vacationPayout,
    vacation_accrued: vacationAccrued,
    vacation_pay_schedule: normalizedSchedule,
  };
}

function ensureColumnExists(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    return true; // column was just added — caller can run one-time migration
  }
  return false; // column already existed — no migration needed
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      pin_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      federal_claim_amount REAL,
      provincial_claim_amount REAL,
      default_hourly_rate REAL,
      default_pay_frequency TEXT,
      start_date TEXT,
      vacation_pay_schedule TEXT NOT NULL DEFAULT 'monthly',
      accrued_vacation_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS time_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('check-in', 'check-out')),
      entry_mode TEXT NOT NULL DEFAULT 'clock',
      manual_category TEXT NOT NULL DEFAULT 'regular',
      recorded_at TEXT NOT NULL,
      worked_hours REAL NOT NULL DEFAULT 0,
      note TEXT,
      holiday_label TEXT,
      holiday_multiplier REAL NOT NULL DEFAULT 1.5,
      kiosk_id TEXT,
      created_manually INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees (id)
    );

    CREATE TABLE IF NOT EXISTS employee_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_fields TEXT,
      admin_user TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees (id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      employee_id INTEGER,
      action TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_fields TEXT,
      admin_user TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      ip_address TEXT PRIMARY KEY,
      attempts_count INTEGER NOT NULL,
      window_start TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payroll_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      pay_date TEXT,
      wage_rate_label TEXT,
      cheque_number_prefix TEXT,
      country TEXT NOT NULL DEFAULT 'CA',
      province TEXT NOT NULL DEFAULT 'AB',
      tax_year INTEGER NOT NULL DEFAULT 2026,
      pay_frequency TEXT NOT NULL DEFAULT 'biweekly',
      pay_periods_per_year INTEGER NOT NULL DEFAULT 26,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payroll_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_period_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      employee_name TEXT NOT NULL,
      total_hours REAL NOT NULL,
      hourly_rate REAL NOT NULL,
      gross_pay REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (payroll_period_id) REFERENCES payroll_periods (id),
      FOREIGN KEY (employee_id) REFERENCES employees (id)
    );
  `);

  ensureColumnExists("time_records", "created_manually", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists("time_records", "updated_at", "TEXT");
  ensureColumnExists("time_records", "deleted_at", "TEXT");
  ensureColumnExists(
    "time_records",
    "entry_mode",
    "TEXT NOT NULL DEFAULT 'clock'",
  );
  ensureColumnExists(
    "time_records",
    "worked_hours",
    "REAL NOT NULL DEFAULT 0",
  );
  ensureColumnExists("time_records", "note", "TEXT");
  ensureColumnExists(
    "time_records",
    "manual_category",
    "TEXT NOT NULL DEFAULT 'regular'",
  );
  ensureColumnExists("time_records", "holiday_label", "TEXT");
  ensureColumnExists(
    "time_records",
    "holiday_multiplier",
    "REAL NOT NULL DEFAULT 1.5",
  );
  ensureColumnExists("employees", "federal_claim_amount", "REAL");
  ensureColumnExists("employees", "provincial_claim_amount", "REAL");
  ensureColumnExists("employees", "default_hourly_rate", "REAL");
  ensureColumnExists("employees", "default_pay_frequency", "TEXT");
  ensureColumnExists("employees", "pin_hash", "TEXT");
  ensureColumnExists("employees", "start_date", "TEXT");
  ensureColumnExists(
    "employees",
    "vacation_pay_schedule",
    "TEXT NOT NULL DEFAULT 'monthly'",
  );
  ensureColumnExists(
    "employees",
    "accrued_vacation_balance",
    "REAL NOT NULL DEFAULT 0",
  );
  ensureColumnExists("audit_logs", "employee_id", "INTEGER");
  ensureColumnExists("payroll_periods", "country", "TEXT NOT NULL DEFAULT 'CA'");
  ensureColumnExists("payroll_periods", "province", "TEXT NOT NULL DEFAULT 'AB'");
  ensureColumnExists("payroll_periods", "tax_year", "INTEGER NOT NULL DEFAULT 2026");
  ensureColumnExists("payroll_periods", "pay_date", "TEXT");
  ensureColumnExists("payroll_periods", "wage_rate_label", "TEXT");
  ensureColumnExists("payroll_periods", "cheque_number_prefix", "TEXT");
  ensureColumnExists(
    "payroll_periods",
    "pay_frequency",
    "TEXT NOT NULL DEFAULT 'biweekly'",
  );
  ensureColumnExists(
    "payroll_periods",
    "pay_periods_per_year",
    "INTEGER NOT NULL DEFAULT 26",
  );
  ensureColumnExists("payroll_items", "regular_hours", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "overtime_hours", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "regular_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "overtime_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "gross_pay_total", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "holiday_hours", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "holiday_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "holiday_label", "TEXT");
  ensureColumnExists("payroll_items", "cpp_deduction", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "cpp_employer", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ei_deduction", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ei_employer", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "federal_tax", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "provincial_tax", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "total_deductions", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "net_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "country", "TEXT NOT NULL DEFAULT 'CA'");
  ensureColumnExists("payroll_items", "province", "TEXT NOT NULL DEFAULT 'AB'");
  ensureColumnExists("payroll_items", "tax_year", "INTEGER NOT NULL DEFAULT 2026");
  ensureColumnExists("payroll_items", "pay_frequency", "TEXT NOT NULL DEFAULT 'biweekly'");
  ensureColumnExists("payroll_items", "pay_periods_per_year", "INTEGER NOT NULL DEFAULT 26");
  ensureColumnExists("payroll_items", "cpp2_deduction", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "pensionable_earnings", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "insurable_earnings", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ytd_cpp", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ytd_cpp2", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ytd_ei", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "federal_claim_amount", "REAL");
  ensureColumnExists("payroll_items", "provincial_claim_amount", "REAL");
  ensureColumnExists("payroll_items", "ytd_federal_tax", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "ytd_provincial_tax", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "vacation_rate", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "vacation_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "vacation_payout", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "vacation_accrued", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "pay_date", "TEXT");
  ensureColumnExists("payroll_items", "cheque_number", "TEXT");
  ensureColumnExists("payroll_items", "wage_rate_label", "TEXT");
  ensureColumnExists(
    "payroll_items",
    "vacation_pay_schedule",
    "TEXT NOT NULL DEFAULT 'monthly'",
  );

  // Salaried employee support
  ensureColumnExists("employees", "pay_type", "TEXT NOT NULL DEFAULT 'hourly'");
  ensureColumnExists("employees", "annual_salary", "REAL");
  ensureColumnExists("employees", "vacation_pay_pct", "REAL NOT NULL DEFAULT 4.0");
  ensureColumnExists("employees", "phone", "TEXT");
  ensureColumnExists("employees", "email", "TEXT");
  ensureColumnExists("employees", "sin", "TEXT");
  ensureColumnExists("employees", "home_address", "TEXT");
  ensureColumnExists("employees", "hire_date", "TEXT");
  ensureColumnExists("employees", "proserve_number", "TEXT");
  ensureColumnExists("employees", "proserve_expiry", "TEXT");
  ensureColumnExists("employees", "roe_last_day", "TEXT");
  ensureColumnExists("employees", "roe_hours", "REAL");
  ensureColumnExists("employees", "roe_wage", "REAL");
  ensureColumnExists("employees", "benefits_note", "TEXT");
  ensureColumnExists("payroll_items", "pay_type", "TEXT NOT NULL DEFAULT 'hourly'");
  ensureColumnExists("payroll_items", "salary_base", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "salary_vacation_pay", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "salary_bonus", "REAL NOT NULL DEFAULT 0");
  ensureColumnExists("payroll_items", "vacation_pay_pct", "REAL NOT NULL DEFAULT 4.0");

  // Alberta general holiday pay — additive columns on payroll_items (kept for backward compat)
  ensureColumnExists("payroll_items", "is_regular_day", "INTEGER");
  ensureColumnExists("payroll_items", "average_daily_wage", "REAL");
  ensureColumnExists("payroll_items", "worked_on_holiday", "INTEGER");
  ensureColumnExists("payroll_items", "holiday_pay_option", "TEXT NOT NULL DEFAULT 'premium_pay'");
  ensureColumnExists("payroll_items", "holiday_pay_calculated", "REAL");
  ensureColumnExists("payroll_items", "holiday_regular_weekday_count", "INTEGER");
  ensureColumnExists("payroll_items", "holiday_adw_period_start", "TEXT");
  ensureColumnExists("payroll_items", "holiday_adw_period_end", "TEXT");
  ensureColumnExists("payroll_items", "holiday_debug_notes", "TEXT");

  // Per-employee per-holiday Alberta calculation rows (supports multiple holidays per period)
  db.prepare(`CREATE TABLE IF NOT EXISTS payroll_item_alberta_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payroll_item_id INTEGER NOT NULL,
    payroll_period_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    holiday_id INTEGER NOT NULL,
    holiday_date TEXT NOT NULL,
    holiday_name TEXT NOT NULL,
    -- Auto-calculated values
    is_regular_day INTEGER,
    weekday_count INTEGER,
    checked_dates TEXT,
    average_daily_wage REAL,
    adw_period_start TEXT,
    adw_period_end TEXT,
    adw_days_worked INTEGER,
    adw_total_wages REAL,
    worked_on_holiday INTEGER,
    holiday_hours_worked REAL NOT NULL DEFAULT 0,
    holiday_pay_calculated REAL,
    -- Manual override fields
    is_manual_override INTEGER NOT NULL DEFAULT 0,
    override_is_regular_day INTEGER,
    override_worked_on_holiday INTEGER,
    override_holiday_hours REAL,
    override_average_daily_wage REAL,
    override_holiday_pay_option TEXT NOT NULL DEFAULT 'premium_pay',
    override_notes TEXT,
    -- Final resolved value (auto or manual)
    resolved_is_regular_day INTEGER,
    resolved_worked_on_holiday INTEGER,
    resolved_holiday_hours REAL,
    resolved_average_daily_wage REAL,
    resolved_holiday_pay_calculated REAL,
    resolved_holiday_pay_option TEXT NOT NULL DEFAULT 'premium_pay',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (payroll_item_id) REFERENCES payroll_items (id),
    FOREIGN KEY (holiday_id) REFERENCES holidays (id),
    UNIQUE (payroll_item_id, holiday_id)
  )`).run();

  // Alberta holidays registry table (Phase 5)
  db.prepare(`CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    province TEXT NOT NULL DEFAULT 'AB',
    is_general_holiday INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();

  // Seed Alberta general holidays if table is empty
  const holidayCount = db.prepare("SELECT COUNT(*) AS cnt FROM holidays").get().cnt;
  if (holidayCount === 0) {
    const insertHoliday = db.prepare(
      "INSERT OR IGNORE INTO holidays (date, name, province, is_general_holiday) VALUES (?, ?, 'AB', 1)"
    );
    const seedHolidays = db.transaction(() => {
      // 2025
      insertHoliday.run("2025-01-01", "New Year's Day");
      insertHoliday.run("2025-02-17", "Alberta Family Day");
      insertHoliday.run("2025-04-18", "Good Friday");
      insertHoliday.run("2025-05-19", "Victoria Day");
      insertHoliday.run("2025-07-01", "Canada Day");
      insertHoliday.run("2025-09-01", "Labour Day");
      insertHoliday.run("2025-10-13", "Thanksgiving Day");
      insertHoliday.run("2025-11-11", "Remembrance Day");
      insertHoliday.run("2025-12-25", "Christmas Day");
      // 2026
      insertHoliday.run("2026-01-01", "New Year's Day");
      insertHoliday.run("2026-02-16", "Alberta Family Day");
      insertHoliday.run("2026-04-03", "Good Friday");
      insertHoliday.run("2026-05-18", "Victoria Day");
      insertHoliday.run("2026-07-01", "Canada Day");
      insertHoliday.run("2026-09-07", "Labour Day");
      insertHoliday.run("2026-10-12", "Thanksgiving Day");
      insertHoliday.run("2026-11-11", "Remembrance Day");
      insertHoliday.run("2026-12-25", "Christmas Day");
    });
    seedHolidays();
  }

  // Admin users table
  db.prepare(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'super_admin',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();

  ensureColumnExists("admin_sessions", "admin_user_id", "INTEGER");
  ensureColumnExists("admin_sessions", "user_name", "TEXT");
  ensureColumnExists("admin_users", "active", "INTEGER NOT NULL DEFAULT 1");

  // Employee status / kiosk visibility columns (added after initial schema)
  const showInKioskAdded = ensureColumnExists("employees", "show_in_kiosk", "INTEGER NOT NULL DEFAULT 1");
  ensureColumnExists("employees", "is_active_employee", "INTEGER NOT NULL DEFAULT 1");

  // One-time migration: seed show_in_kiosk from active only on the first startup
  // after the column is created. Never runs again — show_in_kiosk is the source of
  // truth from this point forward. is_active_employee is NOT seeded from active;
  // all existing employees stay is_active_employee=1 (current employee).
  if (showInKioskAdded) {
    db.prepare(`UPDATE employees SET show_in_kiosk = active`).run();
  }

  // Pay & Send columns
  ensureColumnExists("payroll_items", "send_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumnExists("payroll_items", "sent_at", "TEXT");
  ensureColumnExists("payroll_items", "payment_reference", "TEXT");

  const employeesNeedingMigration = db
    .prepare(
      `
      SELECT id, pin
      FROM employees
      WHERE pin_hash IS NULL
        AND pin IS NOT NULL
      `,
    )
    .all();

  const migratePins = db.transaction((employees) => {
    const statement = db.prepare(
      `
      UPDATE employees
      SET pin_hash = ?
      WHERE id = ?
      `,
    );

    for (const employee of employees) {
      statement.run(hashPin(employee.pin), employee.id);
    }
  });

  if (employeesNeedingMigration.length > 0) {
    migratePins(employeesNeedingMigration);
  }

  db.prepare(
    `
    UPDATE employees
    SET pin = ''
    WHERE pin_hash IS NOT NULL
      AND pin != ''
    `,
  ).run();

  db.prepare(
    `
    UPDATE employees
    SET start_date = COALESCE(start_date, substr(created_at, 1, 10))
    WHERE start_date IS NULL
       OR trim(start_date) = ''
    `,
  ).run();

  db.prepare(
    `
    UPDATE employees
    SET vacation_pay_schedule = ?
    WHERE vacation_pay_schedule IS NULL
       OR vacation_pay_schedule NOT IN ('monthly', 'accrued')
    `,
  ).run(DEFAULT_VACATION_PAY_SCHEDULE);

  db.prepare(
    `
    UPDATE employees
    SET accrued_vacation_balance = COALESCE(accrued_vacation_balance, 0)
    WHERE accrued_vacation_balance IS NULL
    `,
  ).run();
}

function listEmployees() {
  return db
    .prepare(
      `
      SELECT id, name
      FROM employees
      WHERE show_in_kiosk = 1 AND is_active_employee = 1
      ORDER BY name ASC
      `,
    )
    .all();
}

function listAdminEmployees() {
  return db
    .prepare(
      `
      SELECT
        id,
        name,
        active,
        show_in_kiosk,
        is_active_employee,
        default_hourly_rate,
        default_pay_frequency,
        start_date,
        vacation_pay_schedule,
        accrued_vacation_balance,
        pay_type,
        annual_salary,
        vacation_pay_pct,
        phone,
        email,
        sin,
        home_address,
        hire_date,
        proserve_number,
        proserve_expiry,
        roe_last_day,
        roe_hours,
        roe_wage,
        benefits_note,
        (
          SELECT COUNT(*)
          FROM time_records tr
          WHERE tr.employee_id = employees.id
        ) AS time_records_count,
        (
          SELECT COUNT(*)
          FROM payroll_items pi
          WHERE pi.employee_id = employees.id
        ) AS payroll_items_count,
        (
          SELECT COUNT(*)
          FROM audit_logs al
          WHERE al.employee_id = employees.id
        ) AS audit_logs_count
      FROM employees
      ORDER BY name ASC
      `,
    )
    .all()
    .map((employee) => ({
      ...employee,
      default_hourly_rate:
        employee.default_hourly_rate === null
          ? null
          : Number(employee.default_hourly_rate),
      default_pay_frequency: employee.default_pay_frequency || null,
      start_date: employee.start_date || null,
      vacation_pay_schedule:
        employee.vacation_pay_schedule || DEFAULT_VACATION_PAY_SCHEDULE,
      accrued_vacation_balance: Number(employee.accrued_vacation_balance || 0),
      pay_type: employee.pay_type || 'hourly',
      annual_salary: employee.annual_salary != null ? Number(employee.annual_salary) : null,
      vacation_pay_pct: Number(employee.vacation_pay_pct ?? 4),
      time_records_count: Number(employee.time_records_count || 0),
      payroll_items_count: Number(employee.payroll_items_count || 0),
      audit_logs_count: Number(employee.audit_logs_count || 0),
      can_delete:
        Number(employee.time_records_count || 0) === 0 &&
        Number(employee.payroll_items_count || 0) === 0,
    }));
}

function listActiveSalariedEmployees() {
  return db.prepare(`
    SELECT id, name, start_date, annual_salary, vacation_pay_pct,
           federal_claim_amount, provincial_claim_amount
    FROM employees
    WHERE is_active_employee = 1 AND pay_type = 'salaried' AND annual_salary > 0
    ORDER BY name ASC
  `).all();
}

function getEmployeeDependencySummary(employeeId) {
  const counts = db
    .prepare(
      `
      SELECT
        (
          SELECT COUNT(*)
          FROM time_records
          WHERE employee_id = ?
        ) AS time_records_count,
        (
          SELECT COUNT(*)
          FROM payroll_items
          WHERE employee_id = ?
        ) AS payroll_items_count,
        (
          SELECT COUNT(*)
          FROM audit_logs
          WHERE employee_id = ?
        ) AS audit_logs_count
      `,
    )
    .get(employeeId, employeeId, employeeId);

  const timeRecordsCount = Number(counts.time_records_count || 0);
  const payrollItemsCount = Number(counts.payroll_items_count || 0);
  const auditLogsCount = Number(counts.audit_logs_count || 0);

  return {
    time_records_count: timeRecordsCount,
    payroll_items_count: payrollItemsCount,
    audit_logs_count: auditLogsCount,
    can_delete: timeRecordsCount === 0 && payrollItemsCount === 0,
  };
}

function findEmployeeById(employeeId) {
  return db
    .prepare(
      `
      SELECT
        id,
        name,
        pin,
        pin_hash,
        active,
        show_in_kiosk,
        is_active_employee,
        default_hourly_rate,
        default_pay_frequency,
        start_date,
        vacation_pay_schedule,
        accrued_vacation_balance,
        pay_type,
        annual_salary,
        vacation_pay_pct,
        federal_claim_amount,
        provincial_claim_amount
      FROM employees
      WHERE id = ?
      `,
    )
    .get(employeeId);
}

function updateEmployeePayrollSettings({
  employeeId,
  name,
  pin,
  active,
  showInKiosk = undefined,
  isActiveEmployee = undefined,
  defaultHourlyRate,
  defaultPayFrequency,
  startDate,
  vacationPaySchedule,
  payType = undefined,
  annualSalary = undefined,
  vacationPayPct = undefined,
  phone = undefined,
  email = undefined,
  sin = undefined,
  homeAddress = undefined,
  hireDate = undefined,
  proserveNumber = undefined,
  proserveExpiry = undefined,
  roeLastDay = undefined,
  roeHours = undefined,
  roeWage = undefined,
  benefitsNote = undefined,
  adminUser = null,
}) {
  const currentEmployee = findEmployeeById(employeeId);
  const normalizedPin = pin === null ? null : pin;
  const nextPinHash =
    normalizedPin === null
      ? currentEmployee.pin_hash
      : hashPin(normalizedPin);

  db.prepare(
    `
    UPDATE employees
    SET
      name = COALESCE(?, name),
      pin = '',
      pin_hash = ?,
      active = COALESCE(?, active),
      show_in_kiosk = CASE WHEN ? IS NULL THEN show_in_kiosk ELSE ? END,
      is_active_employee = CASE WHEN ? IS NULL THEN is_active_employee ELSE ? END,
      default_hourly_rate = ?,
      default_pay_frequency = ?,
      start_date = COALESCE(?, start_date),
      vacation_pay_schedule = COALESCE(?, vacation_pay_schedule),
      pay_type = CASE WHEN ? IS NULL THEN pay_type ELSE ? END,
      annual_salary = CASE WHEN ? IS NULL THEN annual_salary ELSE ? END,
      vacation_pay_pct = CASE WHEN ? IS NULL THEN vacation_pay_pct ELSE ? END,
      phone = CASE WHEN ? IS NULL THEN phone ELSE ? END,
      email = CASE WHEN ? IS NULL THEN email ELSE ? END,
      sin = CASE WHEN ? IS NULL THEN sin ELSE ? END,
      home_address = CASE WHEN ? IS NULL THEN home_address ELSE ? END,
      hire_date = CASE WHEN ? IS NULL THEN hire_date ELSE ? END,
      proserve_number = CASE WHEN ? IS NULL THEN proserve_number ELSE ? END,
      proserve_expiry = CASE WHEN ? IS NULL THEN proserve_expiry ELSE ? END,
      roe_last_day = CASE WHEN ? IS NULL THEN roe_last_day ELSE ? END,
      roe_hours = CASE WHEN ? IS NULL THEN roe_hours ELSE ? END,
      roe_wage = CASE WHEN ? IS NULL THEN roe_wage ELSE ? END,
      benefits_note = CASE WHEN ? IS NULL THEN benefits_note ELSE ? END
    WHERE id = ?
    `,
  ).run(
    name,
    nextPinHash,
    active,
    showInKiosk === undefined ? null : showInKiosk,
    showInKiosk === undefined ? null : showInKiosk,
    isActiveEmployee === undefined ? null : isActiveEmployee,
    isActiveEmployee === undefined ? null : isActiveEmployee,
    defaultHourlyRate,
    defaultPayFrequency,
    startDate,
    vacationPaySchedule,
    payType === undefined ? null : payType,
    payType === undefined ? null : payType,
    annualSalary === undefined ? null : annualSalary,
    annualSalary === undefined ? null : annualSalary,
    vacationPayPct === undefined ? null : vacationPayPct,
    vacationPayPct === undefined ? null : vacationPayPct,
    phone === undefined ? null : phone,
    phone === undefined ? null : phone,
    email === undefined ? null : email,
    email === undefined ? null : email,
    sin === undefined ? null : sin,
    sin === undefined ? null : sin,
    homeAddress === undefined ? null : homeAddress,
    homeAddress === undefined ? null : homeAddress,
    hireDate === undefined ? null : hireDate,
    hireDate === undefined ? null : hireDate,
    proserveNumber === undefined ? null : proserveNumber,
    proserveNumber === undefined ? null : proserveNumber,
    proserveExpiry === undefined ? null : proserveExpiry,
    proserveExpiry === undefined ? null : proserveExpiry,
    roeLastDay === undefined ? null : roeLastDay,
    roeLastDay === undefined ? null : roeLastDay,
    roeHours === undefined ? null : roeHours,
    roeHours === undefined ? null : roeHours,
    roeWage === undefined ? null : roeWage,
    roeWage === undefined ? null : roeWage,
    benefitsNote === undefined ? null : benefitsNote,
    benefitsNote === undefined ? null : benefitsNote,
    employeeId,
  );

  const updatedEmployee = findEmployeeById(employeeId);

  insertAuditLog({
    entityType: "employee",
    entityId: employeeId,
    employeeId,
    action:
      currentEmployee.active === 1 && updatedEmployee.active === 0
        ? "deactivated"
        : currentEmployee.active === 0 && updatedEmployee.active === 1
          ? "activated"
          : "updated",
    changedFields: {
      before: sanitizeEmployeeForAudit(currentEmployee),
      after: sanitizeEmployeeForAudit(updatedEmployee),
    },
    adminUser,
  });

  return updatedEmployee;
}

function createEmployee({
  name,
  pin,
  active = 1,
  showInKiosk = 1,
  isActiveEmployee = 1,
  defaultHourlyRate = null,
  defaultPayFrequency = null,
  startDate,
  vacationPaySchedule = DEFAULT_VACATION_PAY_SCHEDULE,
  payType = 'hourly',
  annualSalary = null,
  vacationPayPct = 4.0,
  adminUser = null,
}) {
  const pinHash = hashPin(pin);
  const result = db
    .prepare(
      `
      INSERT INTO employees (
        name,
        pin,
        pin_hash,
        active,
        show_in_kiosk,
        is_active_employee,
        default_hourly_rate,
        default_pay_frequency,
        start_date,
        vacation_pay_schedule,
        accrued_vacation_balance,
        pay_type,
        annual_salary,
        vacation_pay_pct
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      name,
      "",
      pinHash,
      active,
      showInKiosk,
      isActiveEmployee,
      defaultHourlyRate,
      defaultPayFrequency,
      startDate,
      vacationPaySchedule,
      0,
      payType,
      annualSalary,
      vacationPayPct,
    );

  const employee = findEmployeeById(result.lastInsertRowid);

  insertAuditLog({
    entityType: "employee",
    entityId: employee.id,
    employeeId: employee.id,
    action: "created",
    changedFields: {
      after: sanitizeEmployeeForAudit(employee),
    },
    adminUser,
  });

  return employee;
}

function deleteEmployee(employeeId, adminUser = null) {
  const employee = findEmployeeById(employeeId);

  if (!employee) {
    return null;
  }

  const dependencies = getEmployeeDependencySummary(employeeId);

  if (!dependencies.can_delete) {
    const error = new Error(
      "This employee cannot be deleted because time records or payroll history already exist. Hide the employee instead.",
    );
    error.code = "EMPLOYEE_HAS_DEPENDENCIES";
    error.details = dependencies;
    throw error;
  }

  insertAuditLog({
    entityType: "employee",
    entityId: employeeId,
    employeeId,
    action: "deleted",
    changedFields: {
      before: sanitizeEmployeeForAudit(employee),
      dependencies,
    },
    adminUser,
  });

  db.prepare(
    `
    DELETE FROM employees
    WHERE id = ?
    `,
  ).run(employeeId);

  return {
    success: true,
    deleted_employee_id: employeeId,
    employee_name: employee.name,
    dependencies,
  };
}

function sanitizeEmployeeForAudit(employee) {
  if (!employee) {
    return null;
  }

  return {
    id: employee.id,
    name: employee.name,
    active: employee.active,
    default_hourly_rate: employee.default_hourly_rate,
    default_pay_frequency: employee.default_pay_frequency,
    start_date: employee.start_date,
    vacation_pay_schedule:
      employee.vacation_pay_schedule || DEFAULT_VACATION_PAY_SCHEDULE,
    accrued_vacation_balance: Number(employee.accrued_vacation_balance || 0),
    has_pin_hash: Boolean(employee.pin_hash),
  };
}

function insertAuditLog({
  entityType,
  entityId,
  employeeId = null,
  action,
  changedFields,
  adminUser,
}) {
  db.prepare(
    `
    INSERT INTO audit_logs (
      entity_type,
      entity_id,
      employee_id,
      action,
      changed_at,
      changed_fields,
      admin_user
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    entityType,
    entityId,
    employeeId,
    action,
    new Date().toISOString(),
    changedFields ? JSON.stringify(changedFields) : null,
    adminUser,
  );
}

function normalizeAuditPageSize(pageSize) {
  const normalized = Number(pageSize) || DEFAULT_AUDIT_PAGE_SIZE;
  return Math.min(Math.max(normalized, 1), MAX_AUDIT_PAGE_SIZE);
}

function buildAuditLogFilters({
  entityType,
  entityId = null,
  action = null,
  employeeId = null,
  startDate = null,
  endDate = null,
}) {
  const params = [];
  let whereClause = "WHERE l.entity_type = ?";
  params.push(entityType);

  if (entityId) {
    whereClause += " AND l.entity_id = ?";
    params.push(entityId);
  }

  if (action) {
    whereClause += " AND l.action = ?";
    params.push(action);
  }

  if (employeeId) {
    whereClause += " AND l.employee_id = ?";
    params.push(employeeId);
  }

  if (startDate) {
    whereClause += " AND datetime(l.changed_at) >= datetime(?)";
    params.push(startDate);
  }

  if (endDate) {
    whereClause += " AND datetime(l.changed_at) <= datetime(?)";
    params.push(endDate);
  }

  return { whereClause, params };
}

function mapAuditLog(log) {
  return {
    ...log,
    employee_id: log.employee_id === null ? null : Number(log.employee_id),
    changed_fields: log.changed_fields ? JSON.parse(log.changed_fields) : null,
  };
}

function listAuditLogs(entityType, entityId = null) {
  const { whereClause, params } = buildAuditLogFilters({ entityType, entityId });

  return db
    .prepare(
      `
      SELECT
        l.id,
        l.entity_type,
        l.entity_id,
        l.employee_id,
        l.action,
        l.changed_at,
        l.changed_fields,
        l.admin_user
      FROM audit_logs l
      ${whereClause}
      ORDER BY datetime(l.changed_at) DESC, l.id DESC
      `,
    )
    .all(...params)
    .map(mapAuditLog);
}

function listAuditLogsPaginated({
  entityType,
  entityId = null,
  action = null,
  employeeId = null,
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = DEFAULT_AUDIT_PAGE_SIZE,
}) {
  const safePage = Number(page) > 0 ? Number(page) : 1;
  const safePageSize = normalizeAuditPageSize(pageSize);
  const offset = (safePage - 1) * safePageSize;
  const { whereClause, params } = buildAuditLogFilters({
    entityType,
    entityId,
    action,
    employeeId,
    startDate,
    endDate,
  });
  const total = db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM audit_logs l
      ${whereClause}
      `,
    )
    .get(...params).total;
  const items = db
    .prepare(
      `
      SELECT
        l.id,
        l.entity_type,
        l.entity_id,
        l.employee_id,
        l.action,
        l.changed_at,
        l.changed_fields,
        l.admin_user
      FROM audit_logs l
      ${whereClause}
      ORDER BY datetime(l.changed_at) DESC, l.id DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, safePageSize, offset)
    .map(mapAuditLog);

  return {
    items,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / safePageSize),
  };
}

function listAuditLogsForExport({
  entityType,
  entityId = null,
  action = null,
  employeeId = null,
  startDate = null,
  endDate = null,
}) {
  const { whereClause, params } = buildAuditLogFilters({
    entityType,
    entityId,
    action,
    employeeId,
    startDate,
    endDate,
  });

  return db
    .prepare(
      `
      SELECT
        l.id,
        l.entity_type,
        l.entity_id,
        l.employee_id,
        l.action,
        l.changed_at,
        l.changed_fields,
        l.admin_user
      FROM audit_logs l
      ${whereClause}
      ORDER BY datetime(l.changed_at) DESC, l.id DESC
      `,
    )
    .all(...params)
    .map(mapAuditLog);
}

function listEmployeeAuditLogs(employeeId = null) {
  return listAuditLogs("employee", employeeId);
}

function listTimeRecordAuditLogs(recordId = null) {
  return listAuditLogs("time_record", recordId);
}

function listPayrollAuditLogs(payrollId = null) {
  return listAuditLogs("payroll", payrollId);
}

function createAdminSession({ token, username, createdAt, expiresAt, adminUserId = null, userName = null }) {
  db.prepare(
    `
    INSERT OR REPLACE INTO admin_sessions (token, username, created_at, expires_at, admin_user_id, user_name)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(token, username, createdAt, expiresAt, adminUserId, userName);

  return getAdminSession(token);
}

function getAdminSession(token) {
  return db
    .prepare(
      `
      SELECT token, username, created_at, expires_at, admin_user_id, user_name
      FROM admin_sessions
      WHERE token = ?
      `,
    )
    .get(token);
}

function deleteAdminSession(token) {
  return db
    .prepare(
      `
      DELETE FROM admin_sessions
      WHERE token = ?
      `,
    )
    .run(token);
}

function cleanupExpiredAdminSessions(referenceIso = new Date().toISOString()) {
  return db
    .prepare(
      `
      DELETE FROM admin_sessions
      WHERE datetime(expires_at) <= datetime(?)
      `,
    )
    .run(referenceIso);
}

function getAdminLoginAttempt(ipAddress) {
  return db
    .prepare(
      `
      SELECT ip_address, attempts_count, window_start, updated_at
      FROM admin_login_attempts
      WHERE ip_address = ?
      `,
    )
    .get(ipAddress);
}

function upsertAdminLoginAttempt({
  ipAddress,
  attemptsCount,
  windowStart,
  updatedAt,
}) {
  db.prepare(
    `
    INSERT INTO admin_login_attempts (
      ip_address,
      attempts_count,
      window_start,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip_address) DO UPDATE SET
      attempts_count = excluded.attempts_count,
      window_start = excluded.window_start,
      updated_at = excluded.updated_at
    `,
  ).run(ipAddress, attemptsCount, windowStart, updatedAt);
}

function clearAdminLoginAttempt(ipAddress) {
  return db
    .prepare(
      `
      DELETE FROM admin_login_attempts
      WHERE ip_address = ?
      `,
    )
    .run(ipAddress);
}

function cleanupAdminLoginAttempts(referenceIso) {
  return db
    .prepare(
      `
      DELETE FROM admin_login_attempts
      WHERE datetime(updated_at) <= datetime(?)
      `,
    )
    .run(referenceIso);
}

function verifyEmployeePin(employeeId, pin) {
  const employee = findEmployeeById(employeeId);

  if (!employee || employee.show_in_kiosk !== 1 || employee.is_active_employee !== 1) {
    return null;
  }

  if (!employee.pin_hash) {
    return false;
  }

  return verifyPin(pin, employee.pin_hash);
}

function normalizeRecordFilters({
  employeeId,
  startDate,
  endDate,
  recordStatus = "active",
}) {
  const conditions = [];
  const params = [];

  if (employeeId) {
    conditions.push("tr.employee_id = ?");
    params.push(employeeId);
  }

  if (startDate) {
    conditions.push("datetime(tr.recorded_at) >= datetime(?)");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("datetime(tr.recorded_at) <= datetime(?)");
    params.push(endDate);
  }

  if (recordStatus === "active") {
    conditions.push("tr.deleted_at IS NULL");
  } else if (recordStatus === "deleted") {
    conditions.push("tr.deleted_at IS NOT NULL");
  }

  return {
    whereClause:
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildTimeRecordSelect(whereClause, orderClause, paginationClause = "") {
  return `
    SELECT
      tr.id,
      tr.employee_id,
      e.name AS employee_name,
      tr.type,
      COALESCE(tr.entry_mode, 'clock') AS entry_mode,
      COALESCE(tr.manual_category, 'regular') AS manual_category,
      tr.recorded_at,
      COALESCE(tr.worked_hours, 0) AS worked_hours,
      tr.note,
      tr.holiday_label,
      COALESCE(tr.holiday_multiplier, 1.5) AS holiday_multiplier,
      tr.kiosk_id,
      tr.created_manually,
      tr.updated_at,
      tr.deleted_at,
      CASE
        WHEN tr.type = 'check-in' AND tr.deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM time_records tr2
          WHERE tr2.employee_id = tr.employee_id
            AND tr2.type = 'check-out'
            AND tr2.deleted_at IS NULL
            AND tr2.recorded_at > tr.recorded_at
        ) THEN 1
        ELSE 0
      END AS is_open
    FROM time_records tr
    INNER JOIN employees e ON e.id = tr.employee_id
    ${whereClause}
    ${orderClause}
    ${paginationClause}
  `;
}

function findTimeRecordById(recordId) {
  return db
    .prepare(buildTimeRecordSelect("WHERE tr.id = ?", ""))
    .get(recordId);
}

function getLastTimeRecord(employeeId) {
  return db
    .prepare(
      `
      SELECT id, type, recorded_at, kiosk_id, created_manually, updated_at
      FROM time_records
      WHERE employee_id = ?
        AND deleted_at IS NULL
        AND COALESCE(entry_mode, 'clock') = 'clock'
      ORDER BY datetime(recorded_at) DESC, id DESC
      LIMIT 1
      `,
    )
    .get(employeeId);
}

function createTimeRecord({ employeeId, type, kioskId, recordedAt }) {
  const result = db
    .prepare(
      `
      INSERT INTO time_records (
        employee_id,
        type,
        entry_mode,
        recorded_at,
        worked_hours,
        note,
        kiosk_id,
        created_manually,
        updated_at,
        deleted_at
      )
      VALUES (?, ?, 'clock', ?, 0, NULL, ?, 0, NULL, NULL)
      `,
    )
    .run(employeeId, type, recordedAt, kioskId || null);

  return findTimeRecordById(result.lastInsertRowid);
}

function listTimeRecords({
  employeeId,
  startDate,
  endDate,
  recordStatus = "active",
} = {}) {
  const { whereClause, params } = normalizeRecordFilters({
    employeeId,
    startDate,
    endDate,
    recordStatus,
  });

  return db
    .prepare(
      buildTimeRecordSelect(
        whereClause,
        "ORDER BY datetime(tr.recorded_at) DESC, tr.id DESC",
      ),
    )
    .all(...params);
}

function listTimeRecordsAscending({
  employeeId,
  startDate,
  endDate,
  recordStatus = "active",
} = {}) {
  const { whereClause, params } = normalizeRecordFilters({
    employeeId,
    startDate,
    endDate,
    recordStatus,
  });

  return db
    .prepare(
      buildTimeRecordSelect(
        whereClause,
        "ORDER BY e.name ASC, datetime(tr.recorded_at) ASC, tr.id ASC",
      ),
    )
    .all(...params);
}

function listTimeRecordsPaginated({
  employeeId,
  startDate,
  endDate,
  recordStatus = "active",
  page = 1,
  pageSize = 10,
} = {}) {
  const safePage = Number(page) > 0 ? Number(page) : 1;
  const safePageSize = Number(pageSize) > 0 ? Number(pageSize) : 10;
  const offset = (safePage - 1) * safePageSize;

  const { whereClause, params } = normalizeRecordFilters({
    employeeId,
    startDate,
    endDate,
    recordStatus,
  });

  const total = db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM time_records tr
      INNER JOIN employees e ON e.id = tr.employee_id
      ${whereClause}
      `,
    )
    .get(...params).total;

  const items = db
    .prepare(
      buildTimeRecordSelect(
        whereClause,
        "ORDER BY datetime(tr.recorded_at) DESC, tr.id DESC",
        "LIMIT ? OFFSET ?",
      ),
    )
    .all(...params, safePageSize, offset);

  const totalPages = total === 0 ? 0 : Math.ceil(total / safePageSize);

  return {
    items,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
  };
}

function summarizeTimeRecords({
  employeeId,
  startDate,
  endDate,
  recordStatus = "active",
} = {}) {
  const records = listTimeRecordsAscending({
    employeeId,
    startDate,
    endDate,
    recordStatus,
  });
  const summaryByEmployee = new Map();
  const totals = {
    employees_with_records: 0,
    total_check_ins: 0,
    total_check_outs: 0,
    total_records: 0,
    total_hours: 0,
    complete_shifts: 0,
    open_shifts: 0,
  };

  for (const record of records) {
    if (!summaryByEmployee.has(record.employee_id)) {
      summaryByEmployee.set(record.employee_id, {
        employee_id: record.employee_id,
        employee_name: record.employee_name,
        check_ins: 0,
        check_outs: 0,
        total_records: 0,
        total_hours: 0,
        complete_shifts: 0,
        open_shifts: 0,
        last_open_check_in_at: null,
      });
    }

    const summary = summaryByEmployee.get(record.employee_id);
    summary.total_records += 1;
    totals.total_records += 1;

    if (record.entry_mode === "manual") {
      const manualHours = Number(record.worked_hours || 0);

      if (record.manual_category !== "holiday" && manualHours > 0) {
        summary.total_hours += manualHours;
        summary.complete_shifts += 1;
        totals.total_hours += manualHours;
        totals.complete_shifts += 1;
      }

      continue;
    }

    if (record.type === "check-in") {
      summary.check_ins += 1;
      totals.total_check_ins += 1;
      summary.last_open_check_in_at = record.recorded_at;
      continue;
    }

    summary.check_outs += 1;
    totals.total_check_outs += 1;

    if (summary.last_open_check_in_at) {
      const start = new Date(summary.last_open_check_in_at);
      const end = new Date(record.recorded_at);
      const durationInHours = (end - start) / (1000 * 60 * 60);

      if (durationInHours > 0) {
        summary.total_hours += durationInHours;
        summary.complete_shifts += 1;
        totals.total_hours += durationInHours;
        totals.complete_shifts += 1;
      }

      summary.last_open_check_in_at = null;
    }
  }

  const employees = Array.from(summaryByEmployee.values())
    .map((summary) => {
      const openShifts = summary.last_open_check_in_at ? 1 : 0;
      return {
        employee_id: summary.employee_id,
        employee_name: summary.employee_name,
        check_ins: summary.check_ins,
        check_outs: summary.check_outs,
        total_records: summary.total_records,
        total_hours: Number(summary.total_hours.toFixed(2)),
        complete_shifts: summary.complete_shifts,
        open_shifts: openShifts,
        payroll_ready_hours: Number(summary.total_hours.toFixed(2)),
      };
    })
    .sort((left, right) => left.employee_name.localeCompare(right.employee_name));

  totals.employees_with_records = employees.length;
  totals.open_shifts = employees.reduce(
    (count, employee) => count + employee.open_shifts,
    0,
  );
  totals.total_hours = Number(totals.total_hours.toFixed(2));
  totals.payroll_ready_hours = totals.total_hours;

  return {
    period: {
      start: startDate || null,
      end: endDate || null,
      record_status: recordStatus,
    },
    totals,
    employees,
  };
}

function listEmployeeTimeRecordsForValidation(employeeId, excludedRecordId = null) {
  const params = [employeeId];
  const exclusionClause = excludedRecordId ? "AND tr.id != ?" : "";

  if (excludedRecordId) {
    params.push(excludedRecordId);
  }

  return db
    .prepare(
      `
      SELECT
        tr.id,
        tr.employee_id,
        tr.type,
        tr.recorded_at,
        tr.kiosk_id
      FROM time_records tr
      WHERE tr.employee_id = ?
        AND tr.deleted_at IS NULL
        AND COALESCE(tr.entry_mode, 'clock') = 'clock'
        ${exclusionClause}
      ORDER BY datetime(tr.recorded_at) ASC, tr.id ASC
      `,
    )
    .all(...params);
}

function validateTimeRecordSequence(records) {
  if (records.length === 0) {
    return { valid: true };
  }

  if (records[0].type !== "check-in") {
    return {
      valid: false,
      error: "A sequencia do funcionario deve comecar com um check-in.",
    };
  }

  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].type === records[index].type) {
      return {
        valid: false,
        error:
          records[index].type === "check-in"
            ? "Nao e permitido manter dois check-ins seguidos."
            : "Nao e permitido manter dois check-outs seguidos.",
      };
    }
  }

  return { valid: true };
}

function validateManualRecordChange({
  employeeId,
  recordId = null,
  nextType = null,
  nextRecordedAt = null,
  nextKioskId = null,
  nextEntryMode = "clock",
  mode,
}) {
  if (mode !== "delete" && nextEntryMode !== "clock") {
    return { valid: true };
  }

  const existingRecords = listEmployeeTimeRecordsForValidation(employeeId, recordId);
  let simulatedRecords = existingRecords;

  if (mode !== "delete") {
    simulatedRecords = [
      ...existingRecords,
      {
        id: recordId || Number.MAX_SAFE_INTEGER,
        employee_id: employeeId,
        type: nextType,
        entry_mode: nextEntryMode,
        recorded_at: nextRecordedAt,
        kiosk_id: nextKioskId || null,
      },
    ].sort((left, right) => {
      const timeDifference =
        new Date(left.recorded_at).getTime() - new Date(right.recorded_at).getTime();

      if (timeDifference !== 0) {
        return timeDifference;
      }

      return left.id - right.id;
    });
  }

  return validateTimeRecordSequence(simulatedRecords);
}

function createManualTimeRecord({
  employeeId,
  type,
  recordedAt,
  kioskId,
  adminUser = null,
}) {
  const validation = validateManualRecordChange({
    employeeId,
    nextType: type,
    nextRecordedAt: recordedAt,
    nextKioskId: kioskId,
    nextEntryMode: "clock",
    mode: "create",
  });

  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = "INVALID_SEQUENCE";
    throw error;
  }

  const timestamp = new Date().toISOString();
  const result = db
    .prepare(
      `
      INSERT INTO time_records (
        employee_id,
        type,
        entry_mode,
        recorded_at,
        worked_hours,
        note,
        kiosk_id,
        created_manually,
        updated_at,
        deleted_at
      )
      VALUES (?, ?, 'clock', ?, 0, NULL, ?, 1, ?, NULL)
      `,
    )
    .run(employeeId, type, recordedAt, kioskId || null, timestamp);

  const record = findTimeRecordById(result.lastInsertRowid);
  insertAuditLog({
    entityType: "time_record",
    entityId: record.id,
    employeeId: record.employee_id,
    action: "created",
    changedFields: {
      after: record,
    },
    adminUser,
  });

  return record;
}

function updateManualTimeRecord(
  recordId,
  { type, recordedAt, kioskId, adminUser = null },
) {
  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || existingRecord.deleted_at) {
    return null;
  }

  const validation = validateManualRecordChange({
    employeeId: existingRecord.employee_id,
    recordId,
    nextType: type,
    nextRecordedAt: recordedAt,
    nextKioskId: kioskId,
    nextEntryMode: "clock",
    mode: "update",
  });

  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = "INVALID_SEQUENCE";
    throw error;
  }

  db.prepare(
    `
    UPDATE time_records
    SET
      type = ?,
      entry_mode = 'clock',
      recorded_at = ?,
      worked_hours = 0,
      note = NULL,
      kiosk_id = ?,
      updated_at = ?
    WHERE id = ?
    `,
  ).run(type, recordedAt, kioskId || null, new Date().toISOString(), recordId);

  const record = findTimeRecordById(recordId);
  insertAuditLog({
    entityType: "time_record",
    entityId: record.id,
    employeeId: record.employee_id,
    action: "updated",
    changedFields: {
      before: existingRecord,
      after: record,
    },
    adminUser,
  });

  return record;
}

function deleteManualTimeRecord(recordId, adminUser = null) {
  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || existingRecord.deleted_at) {
    return null;
  }

  const validation = validateManualRecordChange({
    employeeId: existingRecord.employee_id,
    recordId,
    mode: "delete",
  });

  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = "INVALID_SEQUENCE";
    throw error;
  }

  const timestamp = new Date().toISOString();
  db.prepare(
    `
    UPDATE time_records
    SET deleted_at = ?, updated_at = ?
    WHERE id = ?
    `,
  ).run(timestamp, timestamp, recordId);

  const record = findTimeRecordById(recordId);
  insertAuditLog({
    entityType: "time_record",
    entityId: recordId,
    employeeId: existingRecord.employee_id,
    action: "deleted",
    changedFields: {
      before: existingRecord,
      after: record,
    },
    adminUser,
  });

  return {
    success: true,
    deletedRecordId: recordId,
    deletedAt: timestamp,
  };
}

function restoreManualTimeRecord(recordId, adminUser = null) {
  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || !existingRecord.deleted_at) {
    return null;
  }

  const validation = validateManualRecordChange({
    employeeId: existingRecord.employee_id,
    recordId,
    nextType: existingRecord.type,
    nextRecordedAt: existingRecord.recorded_at,
    nextKioskId: existingRecord.kiosk_id,
    nextEntryMode: existingRecord.entry_mode || "clock",
    mode: "restore",
  });

  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = "INVALID_SEQUENCE";
    throw error;
  }

  db.prepare(
    `
    UPDATE time_records
    SET deleted_at = NULL, updated_at = ?
    WHERE id = ?
    `,
  ).run(new Date().toISOString(), recordId);

  const record = findTimeRecordById(recordId);
  insertAuditLog({
    entityType: "time_record",
    entityId: record.id,
    employeeId: record.employee_id,
    action: "restored",
    changedFields: {
      before: existingRecord,
      after: record,
    },
    adminUser,
  });

  return record;
}

function normalizeManualEntryRecordedAt(workDate) {
  return `${workDate}T12:00:00`;
}

function createManualHoursEntry({
  employeeId,
  workDate,
  workedHours,
  note,
  manualCategory = "regular",
  holidayLabel = null,
  holidayMultiplier = HOLIDAY_PAY_RULE.multiplier,
  adminUser = null,
}) {
  const timestamp = new Date().toISOString();
  const recordedAt = normalizeManualEntryRecordedAt(workDate);
  const result = db
    .prepare(
      `
      INSERT INTO time_records (
        employee_id,
        type,
        entry_mode,
        manual_category,
        recorded_at,
        worked_hours,
        note,
        holiday_label,
        holiday_multiplier,
        kiosk_id,
        created_manually,
        updated_at,
        deleted_at
      )
      VALUES (?, 'check-in', 'manual', ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL)
      `,
    )
    .run(
      employeeId,
      manualCategory,
      recordedAt,
      workedHours,
      note || null,
      holidayLabel || null,
      holidayMultiplier,
      timestamp,
    );

  const record = findTimeRecordById(result.lastInsertRowid);
  insertAuditLog({
    entityType: "time_record",
    entityId: record.id,
    employeeId: record.employee_id,
    action: "manual_hours_created",
    changedFields: {
      after: record,
    },
    adminUser,
  });

  return record;
}

function updateManualHoursEntry(
  recordId,
  {
    workDate,
    workedHours,
    note,
    manualCategory = "regular",
    holidayLabel = null,
    holidayMultiplier = HOLIDAY_PAY_RULE.multiplier,
    adminUser = null,
  },
) {
  const existingRecord = findTimeRecordById(recordId);

  if (
    !existingRecord ||
    existingRecord.deleted_at ||
    existingRecord.entry_mode !== "manual"
  ) {
    return null;
  }

  db.prepare(
    `
    UPDATE time_records
    SET
      manual_category = ?,
      recorded_at = ?,
      worked_hours = ?,
      note = ?,
      holiday_label = ?,
      holiday_multiplier = ?,
      updated_at = ?
    WHERE id = ?
    `,
  ).run(
    manualCategory,
    normalizeManualEntryRecordedAt(workDate),
    workedHours,
    note || null,
    holidayLabel || null,
    holidayMultiplier,
    new Date().toISOString(),
    recordId,
  );

  const record = findTimeRecordById(recordId);
  insertAuditLog({
    entityType: "time_record",
    entityId: record.id,
    employeeId: record.employee_id,
    action: "manual_hours_updated",
    changedFields: {
      before: existingRecord,
      after: record,
    },
    adminUser,
  });

  return record;
}

function findPayrollPeriodByRange(startDate, endDate) {
  return db
    .prepare(
      `
      SELECT *
      FROM payroll_periods
      WHERE start_date = ?
        AND end_date = ?
      LIMIT 1
      `,
    )
    .get(startDate, endDate);
}

function getApprovedPayrollYtdForEmployee({
  employeeId,
  taxYear,
  country,
  province,
  periodStartDate,
  excludePayrollPeriodId = null,
}) {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(pi.cpp_deduction), 0) AS cpp,
        COALESCE(SUM(pi.cpp2_deduction), 0) AS cpp2,
        COALESCE(SUM(pi.ei_deduction), 0) AS ei,
        COALESCE(SUM(pi.federal_tax), 0) AS federal_tax,
        COALESCE(SUM(pi.provincial_tax), 0) AS provincial_tax,
        COALESCE(SUM(pi.pensionable_earnings), 0) AS pensionable_earnings,
        COALESCE(SUM(pi.insurable_earnings), 0) AS insurable_earnings
      FROM payroll_items pi
      INNER JOIN payroll_periods pp
        ON pp.id = pi.payroll_period_id
      WHERE pi.employee_id = ?
        AND pi.tax_year = ?
        AND pi.country = ?
        AND pi.province = ?
        AND pp.status = 'approved'
        AND pp.start_date < ?
        AND (? IS NULL OR pp.id <> ?)
      `,
    )
    .get(
      employeeId,
      taxYear,
      country,
      province,
      periodStartDate,
      excludePayrollPeriodId,
      excludePayrollPeriodId,
    );

  return {
    cpp: Number(row.cpp || 0),
    cpp2: Number(row.cpp2 || 0),
    ei: Number(row.ei || 0),
    federalTax: Number(row.federal_tax || 0),
    provincialTax: Number(row.provincial_tax || 0),
    pensionableEarnings: Number(row.pensionable_earnings || 0),
    insurableEarnings: Number(row.insurable_earnings || 0),
  };
}

function listPayrollPeriods() {
  const periods = db
    .prepare(
      `
      SELECT
        pp.id,
        pp.start_date,
        pp.end_date,
        pp.pay_date,
        pp.wage_rate_label,
        pp.cheque_number_prefix,
        pp.country,
        pp.province,
        pp.tax_year,
        pp.pay_frequency,
        pp.pay_periods_per_year,
        pp.status,
        pp.created_at,
        pp.updated_at,
        COUNT(pi.id) AS items_count,
        COALESCE(SUM(COALESCE(pi.gross_pay, 0)), 0) AS total_gross_pay,
        COALESCE(
          SUM(
            COALESCE(pi.gross_pay, 0) +
            COALESCE(pi.vacation_payout, 0) +
            COALESCE(pi.holiday_pay, 0)
          ),
          0
        ) AS total_earnings,
        COALESCE(SUM(pi.total_hours), 0) AS total_hours
      FROM payroll_periods pp
      LEFT JOIN payroll_items pi ON pi.payroll_period_id = pp.id
      GROUP BY pp.id
      ORDER BY datetime(pp.created_at) DESC, pp.id DESC
      `,
    )
    .all();

  return periods.map((period) => ({
    ...period,
    tax_year: Number(period.tax_year || PAYROLL_TAX_YEAR),
    pay_frequency: period.pay_frequency || DEFAULT_PAY_FREQUENCY,
    pay_periods_per_year: Number(
      period.pay_periods_per_year ||
        getPayFrequencyConfig(period.pay_frequency).payPeriodsPerYear,
    ),
    total_gross_pay: Number(period.total_gross_pay || 0),
    total_hours: Number(period.total_hours || 0),
  }));
}

function getPayrollItems(payrollPeriodId) {
  return db
    .prepare(
      `
      SELECT
        pi.id,
        pi.payroll_period_id,
        pi.employee_id,
        pi.employee_name,
        pi.total_hours,
        pi.regular_hours,
        pi.overtime_hours,
        pi.hourly_rate,
        pi.regular_pay,
        pi.overtime_pay,
        pi.gross_pay,
        pi.gross_pay_total,
        pi.holiday_hours,
        pi.holiday_pay,
        pi.holiday_label,
        pi.vacation_rate,
        pi.vacation_pay,
        pi.vacation_payout,
        pi.vacation_accrued,
        pi.vacation_pay_schedule,
        pi.pay_date,
        pi.cheque_number,
        pi.wage_rate_label,
        pi.cpp_deduction,
        pi.cpp_employer,
        pi.cpp2_deduction,
        pi.ei_deduction,
        pi.ei_employer,
        pi.federal_tax,
        pi.provincial_tax,
        pi.total_deductions,
        pi.net_pay,
        pi.country,
        pi.province,
        pi.tax_year,
        pi.pay_frequency,
        pi.pay_periods_per_year,
        pi.pensionable_earnings,
        pi.insurable_earnings,
        pi.ytd_cpp,
        pi.ytd_cpp2,
        pi.ytd_ei,
        pi.ytd_federal_tax,
        pi.ytd_provincial_tax,
        pi.pay_type,
        pi.salary_base,
        pi.salary_vacation_pay,
        pi.salary_bonus,
        pi.vacation_pay_pct,
        pi.send_status,
        pi.sent_at,
        pi.payment_reference,
        pi.created_at,
        pi.updated_at,
        e.email AS employee_email,
        e.benefits_note AS benefits_note,
        pi.is_regular_day,
        pi.average_daily_wage,
        pi.worked_on_holiday,
        pi.holiday_pay_option,
        pi.holiday_pay_calculated,
        pi.holiday_regular_weekday_count,
        pi.holiday_adw_period_start,
        pi.holiday_adw_period_end,
        pi.holiday_debug_notes
      FROM payroll_items pi
      LEFT JOIN employees e ON e.id = pi.employee_id
      WHERE pi.payroll_period_id = ?
      ORDER BY pi.employee_name ASC
      `,
    )
    .all(payrollPeriodId)
    .map((item) => ({
      ...item,
      total_hours: Number(item.total_hours),
      regular_hours: Number(item.regular_hours || 0),
      overtime_hours: Number(item.overtime_hours || 0),
      hourly_rate: Number(item.hourly_rate),
      regular_pay: Number(item.regular_pay || 0),
      overtime_pay: Number(item.overtime_pay || 0),
      gross_pay: Number(item.gross_pay),
      gross_pay_total: Number(item.gross_pay_total || item.gross_pay || 0),
      total_earnings: Number(
        (
          Number(item.gross_pay || 0) +
          Number(item.vacation_payout || 0) +
          Number(item.holiday_pay || 0)
        ).toFixed(2),
      ),
      holiday_hours: Number(item.holiday_hours || 0),
      holiday_pay: Number(item.holiday_pay || 0),
      holiday_label: item.holiday_label || null,
      vacation_rate: Number(item.vacation_rate || 0),
      vacation_pay: Number(item.vacation_pay || 0),
      vacation_payout: Number(item.vacation_payout || 0),
      vacation_accrued: Number(item.vacation_accrued || 0),
      vacation_pay_schedule:
        item.vacation_pay_schedule || DEFAULT_VACATION_PAY_SCHEDULE,
      pay_date: item.pay_date || null,
      cheque_number: item.cheque_number || null,
      wage_rate_label: item.wage_rate_label || "Hourly rate",
      cpp_deduction: Number(item.cpp_deduction || 0),
      cpp_employer: Number(item.cpp_employer || 0),
      cpp2_deduction: Number(item.cpp2_deduction || 0),
      ei_deduction: Number(item.ei_deduction || 0),
      ei_employer: Number(item.ei_employer || 0),
      federal_tax: Number(item.federal_tax || 0),
      provincial_tax: Number(item.provincial_tax || 0),
      tax_total: Number((Number(item.federal_tax || 0) + Number(item.provincial_tax || 0)).toFixed(2)),
      cpp_total: Number((Number(item.cpp_deduction || 0) + Number(item.cpp2_deduction || 0)).toFixed(2)),
      total_deductions: Number(item.total_deductions || 0),
      net_pay: Number(item.net_pay || 0),
      country: item.country || PAYROLL_COUNTRY,
      province: item.province || PAYROLL_PROVINCE,
      tax_year: Number(item.tax_year || PAYROLL_TAX_YEAR),
      pay_frequency: item.pay_frequency || DEFAULT_PAY_FREQUENCY,
      pay_periods_per_year: Number(
        item.pay_periods_per_year ||
          getPayFrequencyConfig(item.pay_frequency).payPeriodsPerYear,
      ),
      pensionable_earnings: Number(item.pensionable_earnings || 0),
      insurable_earnings: Number(item.insurable_earnings || 0),
      ytd_cpp: Number(item.ytd_cpp || 0),
      ytd_cpp2: Number(item.ytd_cpp2 || 0),
      ytd_ei: Number(item.ytd_ei || 0),
      ytd_federal_tax: Number(item.ytd_federal_tax || 0),
      ytd_provincial_tax: Number(item.ytd_provincial_tax || 0),
      pay_type: item.pay_type || 'hourly',
      salary_base: Number(item.salary_base || 0),
      salary_vacation_pay: Number(item.salary_vacation_pay || 0),
      salary_bonus: Number(item.salary_bonus || 0),
      vacation_pay_pct: Number(item.vacation_pay_pct ?? 4),
      benefits_note: item.benefits_note || null,
      // Alberta holiday pay fields (comparison only — not applied to net pay)
      is_regular_day: item.is_regular_day !== null && item.is_regular_day !== undefined
        ? Boolean(item.is_regular_day) : null,
      average_daily_wage: item.average_daily_wage !== null && item.average_daily_wage !== undefined
        ? Number(item.average_daily_wage) : null,
      worked_on_holiday: item.worked_on_holiday !== null && item.worked_on_holiday !== undefined
        ? Boolean(item.worked_on_holiday) : null,
      holiday_pay_option: item.holiday_pay_option || 'premium_pay',
      holiday_pay_calculated: item.holiday_pay_calculated !== null && item.holiday_pay_calculated !== undefined
        ? Number(item.holiday_pay_calculated) : null,
      holiday_regular_weekday_count: item.holiday_regular_weekday_count !== null
        ? Number(item.holiday_regular_weekday_count) : null,
      holiday_adw_period_start: item.holiday_adw_period_start || null,
      holiday_adw_period_end: item.holiday_adw_period_end || null,
      holiday_debug_notes: item.holiday_debug_notes || null,
    }));
}

function getPayrollDetails(payrollPeriodId) {
  const period = db
    .prepare(
      `
      SELECT *
      FROM payroll_periods
      WHERE id = ?
      `,
    )
    .get(payrollPeriodId);

  if (!period) {
    return null;
  }

  const items = getPayrollItems(payrollPeriodId);
  const totals = items.reduce(
    (accumulator, item) => ({
      total_hours: accumulator.total_hours + item.total_hours,
      total_gross_pay:
        accumulator.total_gross_pay + (item.gross_pay || 0),
      total_earnings:
        accumulator.total_earnings + (item.total_earnings || 0),
      total_holiday_pay: accumulator.total_holiday_pay + (item.holiday_pay || 0),
      total_vacation_pay: accumulator.total_vacation_pay + (item.vacation_pay || 0),
      total_vacation_payout:
        accumulator.total_vacation_payout + (item.vacation_payout || 0),
      total_vacation_accrued:
        accumulator.total_vacation_accrued + (item.vacation_accrued || 0),
      total_cpp_deduction:
        accumulator.total_cpp_deduction + (item.cpp_deduction || 0),
      total_cpp_employer:
        accumulator.total_cpp_employer + (item.cpp_employer || 0),
      total_cpp2_deduction:
        accumulator.total_cpp2_deduction + (item.cpp2_deduction || 0),
      total_ei_deduction:
        accumulator.total_ei_deduction + (item.ei_deduction || 0),
      total_ei_employer:
        accumulator.total_ei_employer + (item.ei_employer || 0),
      total_federal_tax:
        accumulator.total_federal_tax + (item.federal_tax || 0),
      total_provincial_tax:
        accumulator.total_provincial_tax + (item.provincial_tax || 0),
      total_tax: accumulator.total_tax + (item.tax_total || 0),
      total_ytd_federal_tax:
        accumulator.total_ytd_federal_tax + (item.ytd_federal_tax || 0),
      total_ytd_provincial_tax:
        accumulator.total_ytd_provincial_tax + (item.ytd_provincial_tax || 0),
      total_deductions:
        accumulator.total_deductions + (item.total_deductions || 0),
      total_net_pay: accumulator.total_net_pay + (item.net_pay || 0),
      employees_count: accumulator.employees_count + 1,
    }),
    {
      total_hours: 0,
      total_gross_pay: 0,
      total_earnings: 0,
      total_holiday_pay: 0,
      total_vacation_pay: 0,
      total_vacation_payout: 0,
      total_vacation_accrued: 0,
      total_cpp_deduction: 0,
      total_cpp_employer: 0,
      total_cpp2_deduction: 0,
      total_ei_deduction: 0,
      total_ei_employer: 0,
      total_federal_tax: 0,
      total_provincial_tax: 0,
      total_tax: 0,
      total_ytd_federal_tax: 0,
      total_ytd_provincial_tax: 0,
      total_deductions: 0,
      total_net_pay: 0,
      employees_count: 0,
    },
  );

  return {
    ...period,
    pay_date: period.pay_date || null,
    wage_rate_label: period.wage_rate_label || "Hourly rate",
    cheque_number_prefix: period.cheque_number_prefix || null,
    tax_year: Number(period.tax_year || PAYROLL_TAX_YEAR),
    pay_frequency: period.pay_frequency || DEFAULT_PAY_FREQUENCY,
    pay_periods_per_year: Number(
      period.pay_periods_per_year ||
        getPayFrequencyConfig(period.pay_frequency).payPeriodsPerYear,
    ),
    items,
    totals: {
      employees_count: totals.employees_count,
      total_hours: Number(totals.total_hours.toFixed(2)),
      total_gross_pay: Number(totals.total_gross_pay.toFixed(2)),
      total_earnings: Number(totals.total_earnings.toFixed(2)),
      total_holiday_pay: Number(totals.total_holiday_pay.toFixed(2)),
      total_vacation_pay: Number(totals.total_vacation_pay.toFixed(2)),
      total_vacation_payout: Number(totals.total_vacation_payout.toFixed(2)),
      total_vacation_accrued: Number(totals.total_vacation_accrued.toFixed(2)),
      total_cpp_deduction: Number(totals.total_cpp_deduction.toFixed(2)),
      total_cpp_employer: Number(totals.total_cpp_employer.toFixed(2)),
      total_cpp2_deduction: Number(totals.total_cpp2_deduction.toFixed(2)),
      total_cpp: Number(
        (totals.total_cpp_deduction + totals.total_cpp2_deduction).toFixed(2),
      ),
      total_ei_deduction: Number(totals.total_ei_deduction.toFixed(2)),
      total_ei_employer: Number(totals.total_ei_employer.toFixed(2)),
      total_federal_tax: Number(totals.total_federal_tax.toFixed(2)),
      total_provincial_tax: Number(totals.total_provincial_tax.toFixed(2)),
      total_tax: Number(totals.total_tax.toFixed(2)),
      total_ytd_federal_tax: Number(totals.total_ytd_federal_tax.toFixed(2)),
      total_ytd_provincial_tax: Number(
        totals.total_ytd_provincial_tax.toFixed(2),
      ),
      total_deductions: Number(totals.total_deductions.toFixed(2)),
      total_net_pay: Number(totals.total_net_pay.toFixed(2)),
    },
  };
}

function getPayrollPayslip(payrollPeriodId, payrollItemId) {
  const payroll = getPayrollDetails(payrollPeriodId);

  if (!payroll) {
    return null;
  }

  const item = payroll.items.find((currentItem) => currentItem.id === payrollItemId);

  if (!item) {
    return null;
  }

  const isSalaried = item.pay_type === 'salaried';

  let totalEarnings;
  let header;
  let earnings;

  if (isSalaried) {
    totalEarnings = roundMoney(item.gross_pay_total);
    header = {
      employee: item.employee_name,
      pay_period: `${payroll.start_date} to ${payroll.end_date}`,
      wage_rate: `Monthly Salary: $${roundMoney(item.salary_base).toFixed(2)}`,
      wage_rate_label: "Monthly Salary",
      wage_rate_value: roundMoney(item.salary_base),
      pay_date: item.pay_date || payroll.pay_date || payroll.end_date,
      payment_reference: item.payment_reference || item.cheque_number || null,
      cheque_no: item.payment_reference || item.cheque_number || null,
      total_hours: 0,
    };
    earnings = {
      regular_earnings: roundMoney(item.salary_base),
      vacation_pay: roundMoney(item.salary_vacation_pay),
      extra_pay: roundMoney(item.salary_bonus),
      extra_pay_label: "Bonus",
      total_earnings: totalEarnings,
      accrued_vacation: 0,
    };
  } else {
    totalEarnings = roundMoney(
      item.gross_pay + item.vacation_payout + item.holiday_pay,
    );
    header = {
      employee: item.employee_name,
      pay_period: `${payroll.start_date} to ${payroll.end_date}`,
      wage_rate: `${item.wage_rate_label || payroll.wage_rate_label || "Hourly rate"}: $${item.hourly_rate.toFixed(2)}`,
      wage_rate_label: item.wage_rate_label || payroll.wage_rate_label || "Hourly rate",
      wage_rate_value: item.hourly_rate,
      pay_date: item.pay_date || payroll.pay_date || payroll.end_date,
      payment_reference: item.payment_reference || item.cheque_number || null,
      cheque_no: item.payment_reference || item.cheque_number || null,
      total_hours: Number(item.total_hours || 0),
    };
    earnings = {
      regular_earnings: roundMoney(item.gross_pay),
      vacation_pay: roundMoney(item.vacation_payout),
      extra_pay: roundMoney(item.holiday_pay),
      extra_pay_label: item.holiday_label || "Holiday Pay",
      total_earnings: totalEarnings,
      accrued_vacation: roundMoney(item.vacation_accrued),
    };
  }

  const totalDeductions = roundMoney(
    item.federal_tax +
      item.provincial_tax +
      item.cpp_total +
      item.ei_deduction,
  );
  const netPay = roundMoney(totalEarnings - totalDeductions);

  return {
    payroll_period_id: payroll.id,
    payroll_item_id: item.id,
    employee_id: item.employee_id,
    employee_name: item.employee_name,
    benefits_note: item.benefits_note || null,
    pay_type: item.pay_type || 'hourly',
    pay_period: {
      start_date: payroll.start_date,
      end_date: payroll.end_date,
      pay_date: item.pay_date || payroll.pay_date || payroll.end_date,
      status: payroll.status,
    },
    header,
    earnings,
    deductions: {
      federal_tax: roundMoney(item.federal_tax),
      provincial_tax: roundMoney(item.provincial_tax),
      cpp: roundMoney(item.cpp_total),
      ei: roundMoney(item.ei_deduction),
      total_deductions: totalDeductions,
    },
    totals: {
      total_earnings: totalEarnings,
      total_deductions: totalDeductions,
      net_pay: netPay,
    },
    notes: {
      vacation_schedule: item.vacation_pay_schedule,
      accrued_vacation_balance_note:
        item.vacation_pay_schedule === "accrued"
          ? `Vacation pay of $${roundMoney(item.vacation_accrued).toFixed(2)} was accrued and not included in this payout.`
          : null,
    },
    raw: {
      gross_pay: roundMoney(item.gross_pay),
      vacation_rate: Number(item.vacation_rate || 0),
      vacation_pay: roundMoney(item.vacation_pay),
      vacation_payout: roundMoney(item.vacation_payout),
      vacation_accrued: roundMoney(item.vacation_accrued),
      holiday_pay: roundMoney(item.holiday_pay),
      holiday_label: item.holiday_label || "Holiday Pay",
      federal_tax: roundMoney(item.federal_tax),
      provincial_tax: roundMoney(item.provincial_tax),
      cpp_total: roundMoney(item.cpp_total),
      cpp_employer: roundMoney(item.cpp_employer),
      ei_deduction: roundMoney(item.ei_deduction),
      ei_employer: roundMoney(item.ei_employer),
      total_deductions: roundMoney(item.total_deductions),
      net_pay: roundMoney(item.net_pay),
      pay_type: item.pay_type || 'hourly',
      vacation_pay_pct: item.vacation_pay_pct ?? 4,
      salary_base: roundMoney(item.salary_base || 0),
      salary_vacation_pay: roundMoney(item.salary_vacation_pay || 0),
      salary_bonus: roundMoney(item.salary_bonus || 0),
    },
  };
}

function resolvePayrollPayFrequency(requestedPayFrequency, employeesWithHours) {
  if (requestedPayFrequency) {
    return getPayFrequencyConfig(requestedPayFrequency).code;
  }

  const missingFrequencyEmployees = employeesWithHours
    .filter((employee) => !employee.default_pay_frequency)
    .map((employee) => employee.name || employee.employee_name || `Employee #${employee.id || employee.employee_id}`);

  if (missingFrequencyEmployees.length > 0) {
    const error = new Error(
      `Payroll cannot be generated because pay frequency is missing for: ${missingFrequencyEmployees.join(", ")}.`,
    );
    error.code = "MISSING_EMPLOYEE_PAY_FREQUENCY";
    throw error;
  }

  const employeeFrequencies = Array.from(
    new Set(employeesWithHours.map((employee) => employee.default_pay_frequency)),
  );

  if (employeeFrequencies.length === 1) {
    return getPayFrequencyConfig(employeeFrequencies[0]).code;
  }

  const error = new Error(
    "Payroll cannot be generated because employees in this run have different pay frequencies. Select an explicit payroll pay frequency override first.",
  );
  error.code = "MIXED_EMPLOYEE_PAY_FREQUENCIES";
  throw error;
}

function summarizeVacationAccruedByEmployee(items = []) {
  return items.reduce((accumulator, item) => {
    const employeeKey = String(item.employee_id);
    accumulator.set(
      employeeKey,
      roundMoney(
        (accumulator.get(employeeKey) || 0) + Number(item.vacation_accrued || 0),
      ),
    );
    return accumulator;
  }, new Map());
}

function generatePayroll({
  startDate,
  endDate,
  payDate = null,
  wageRateLabel = "Hourly rate",
  chequeNumberPrefix = null,
  taxYear = PAYROLL_TAX_YEAR,
  country = PAYROLL_COUNTRY,
  province = PAYROLL_PROVINCE,
  payFrequency = null,
  defaultHourlyRate = null,
  hourlyRatesByEmployee = {},
  holidayAdjustmentsByEmployee = {},
  salariedBonusByEmployee = {},
  allowApprovedRebuild = false,
  auditAction = "generated",
  adminUser = null,
}) {
  if (Number(taxYear) !== PAYROLL_TAX_YEAR || String(startDate).slice(0, 4) !== String(taxYear)) {
    const error = new Error(
      `Este modulo de payroll suporta apenas tax_year ${PAYROLL_TAX_YEAR}.`,
    );
    error.code = "UNSUPPORTED_TAX_YEAR";
    throw error;
  }

  if (country !== PAYROLL_COUNTRY || province !== PAYROLL_PROVINCE) {
    const error = new Error(
      `Este modulo de payroll suporta apenas ${PAYROLL_COUNTRY}/${PAYROLL_PROVINCE}.`,
    );
    error.code = "UNSUPPORTED_JURISDICTION";
    throw error;
  }

  const existingPeriod = findPayrollPeriodByRange(startDate, endDate);

  if (existingPeriod?.status === "approved" && !allowApprovedRebuild) {
    const error = new Error("Este payroll ja foi aprovado e nao pode ser regenerado.");
    error.code = "PAYROLL_APPROVED";
    throw error;
  }

  const employees = calculatePayrollHours({
    startDate,
    endDate,
  })
    .filter((employee) => employee.total_hours > 0)
    .map((employee) => ({
      ...employee,
      settings: findEmployeeById(employee.employee_id),
    }));

  const payFrequencyConfig = employees.length > 0
    ? getPayFrequencyConfig(resolvePayrollPayFrequency(
        payFrequency,
        employees.map((employee) => employee.settings || {}),
      ))
    : getPayFrequencyConfig(payFrequency || DEFAULT_PAY_FREQUENCY);

  const timestamp = new Date().toISOString();
  const resolvedPayDate = payDate || endDate;
  const previousItems = existingPeriod?.id ? getPayrollItems(existingPeriod.id) : [];
  const previousAccruedByEmployee = summarizeVacationAccruedByEmployee(previousItems);

  const transaction = db.transaction(() => {
    let payrollPeriodId = existingPeriod?.id;
    let resolvedChequePrefix =
      chequeNumberPrefix ||
      existingPeriod?.cheque_number_prefix ||
      null;
    const nextStatus =
      existingPeriod?.status === "approved" && allowApprovedRebuild
        ? "approved"
        : "draft";
    const nextAccruedByEmployee = new Map();
    const updateAccruedVacationBalance = db.prepare(
      `
      UPDATE employees
      SET accrued_vacation_balance = COALESCE(accrued_vacation_balance, 0) + ?
      WHERE id = ?
      `,
    );

    if (payrollPeriodId) {
      db.prepare(
        `
        UPDATE payroll_periods
        SET
          updated_at = ?,
          status = ?,
          pay_date = ?,
          wage_rate_label = ?,
          cheque_number_prefix = ?,
          country = ?,
          province = ?,
          tax_year = ?,
          pay_frequency = ?,
          pay_periods_per_year = ?
        WHERE id = ?
        `,
      ).run(
        timestamp,
        nextStatus,
        resolvedPayDate,
        wageRateLabel,
        resolvedChequePrefix,
        country,
        province,
        taxYear,
        payFrequencyConfig.code,
        payFrequencyConfig.payPeriodsPerYear,
        payrollPeriodId,
      );

      db.prepare("DELETE FROM payroll_item_alberta_holidays WHERE payroll_period_id = ?").run(
        payrollPeriodId,
      );
      db.prepare("DELETE FROM payroll_items WHERE payroll_period_id = ?").run(
        payrollPeriodId,
      );
    } else {
      const result = db
        .prepare(
          `
          INSERT INTO payroll_periods (
            start_date,
            end_date,
            pay_date,
            wage_rate_label,
            cheque_number_prefix,
            country,
            province,
            tax_year,
            pay_frequency,
            pay_periods_per_year,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
          `,
        )
        .run(
          startDate,
          endDate,
          resolvedPayDate,
          wageRateLabel,
          chequeNumberPrefix,
          country,
          province,
          taxYear,
          payFrequencyConfig.code,
          payFrequencyConfig.payPeriodsPerYear,
          timestamp,
          timestamp,
        );

      payrollPeriodId = result.lastInsertRowid;
      resolvedChequePrefix = chequeNumberPrefix || null;
    }

    const insertItem = db.prepare(
      `
      INSERT INTO payroll_items (
        payroll_period_id,
        employee_id,
        employee_name,
        total_hours,
        regular_hours,
        overtime_hours,
        hourly_rate,
        regular_pay,
        overtime_pay,
        gross_pay,
        gross_pay_total,
        holiday_hours,
        holiday_pay,
        holiday_label,
        vacation_rate,
        vacation_pay,
        vacation_payout,
        vacation_accrued,
        vacation_pay_schedule,
        pay_date,
        cheque_number,
        wage_rate_label,
        cpp_deduction,
        cpp_employer,
        cpp2_deduction,
        ei_deduction,
        ei_employer,
        federal_tax,
        provincial_tax,
        total_deductions,
        net_pay,
        country,
        province,
        tax_year,
        pay_frequency,
        pay_periods_per_year,
        pensionable_earnings,
        insurable_earnings,
        ytd_cpp,
        ytd_cpp2,
        ytd_ei,
        ytd_federal_tax,
        ytd_provincial_tax,
        is_regular_day,
        average_daily_wage,
        worked_on_holiday,
        holiday_pay_option,
        holiday_pay_calculated,
        holiday_regular_weekday_count,
        holiday_adw_period_start,
        holiday_adw_period_end,
        holiday_debug_notes,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    employees.forEach((employee, itemIndex) => {
      const employeeSettings = employee.settings;
      const resolvedRateValue =
        hourlyRatesByEmployee[employee.employee_id] ??
        defaultHourlyRate ??
        employeeSettings?.default_hourly_rate;
      const employeeRate = Number(resolvedRateValue);

      if (!Number.isFinite(employeeRate) || employeeRate <= 0) {
        const error = new Error(
          `Payroll cannot be generated because hourly rate is missing for ${employee.employee_name}.`,
        );
        error.code = "MISSING_EMPLOYEE_HOURLY_RATE";
        throw error;
      }
      const totalHours = Number(employee.total_hours);
      const regularHours = Number(employee.regular_hours);
      const overtimeHours = Number(employee.overtime_hours);
      const regularPay = roundMoney(regularHours * employeeRate);
      const overtimePay = roundMoney(
        overtimeHours *
          employeeRate *
          PAYROLL_OVERTIME_RULE.overtimeMultiplier,
      );
      const grossPay = roundMoney(regularPay + overtimePay);
      const holidayAdjustment = {
        holidayHours: employee.holiday_hours || 0,
        holidayLabel: employee.holiday_label || null,
        ...(holidayAdjustmentsByEmployee[employee.employee_id] || {}),
      };
      const holidayPay = calculateHolidayPayAmount({
        holidayPay: holidayAdjustment.holidayPay,
        holidayHours: holidayAdjustment.holidayHours,
        hourlyRate: employeeRate,
      });
      const holidayHours = Number(holidayAdjustment.holidayHours || 0);
      const holidayLabel =
        holidayPay > 0 ? holidayAdjustment.holidayLabel || "Holiday Pay" : null;

      // ── Alberta holiday pay — stored in payroll_item_alberta_holidays (comparison only) ──
      // Runs for ALL holidays in the period — not just when holiday_hours > 0.
      // Does NOT touch holiday_pay or net_pay.
      const albertaHolidayData = {
        is_regular_day: null,
        average_daily_wage: null,
        worked_on_holiday: null,
        holiday_pay_calculated: null,
        holiday_regular_weekday_count: null,
        holiday_adw_period_start: null,
        holiday_adw_period_end: null,
        holiday_debug_notes: null,
      };
      // Note: the detailed per-holiday rows are inserted AFTER insertItem.run()
      // so we have the payrollItemId. See the deferred block below.
      // ── End Alberta holiday pay header ──────────────────────────────────────

      const vacation = calculateVacationPayForEmployee({
        startDate: employeeSettings?.start_date,
        payrollEndDate: endDate,
        vacationPaySchedule: employeeSettings?.vacation_pay_schedule,
        baseGrossPay: grossPay,
      });
      const grossPayTotal = roundMoney(
        grossPay + vacation.vacation_payout + holidayPay,
      );
      const ytd = getApprovedPayrollYtdForEmployee({
        employeeId: employee.employee_id,
        taxYear,
        country,
        province,
        periodStartDate: startDate,
        excludePayrollPeriodId: payrollPeriodId,
      });
      const deductions = calculatePayrollDeductions({
        grossPayTotal,
        payFrequency: payFrequencyConfig.code,
        ytd,
      });
      const employerContributions = calculateEmployerContributions({
        cppEmployee: deductions.cpp_deduction + deductions.cpp2_deduction,
        eiEmployee: deductions.ei_deduction,
      });
      const chequeNumber = buildChequeNumber(resolvedChequePrefix, itemIndex);
      nextAccruedByEmployee.set(
        String(employee.employee_id),
        roundMoney(vacation.vacation_accrued),
      );

      insertItem.run(
        payrollPeriodId,
        employee.employee_id,
        employee.employee_name,
        totalHours,
        regularHours,
        overtimeHours,
        employeeRate,
        regularPay,
        overtimePay,
        grossPay,
        grossPayTotal,
        holidayHours,
        holidayPay,
        holidayLabel,
        vacation.vacation_rate,
        vacation.vacation_pay,
        vacation.vacation_payout,
        vacation.vacation_accrued,
        vacation.vacation_pay_schedule,
        resolvedPayDate,
        chequeNumber,
        wageRateLabel,
        deductions.cpp_deduction,
        employerContributions.cpp_employer,
        deductions.cpp2_deduction,
        deductions.ei_deduction,
        employerContributions.ei_employer,
        deductions.federal_tax,
        deductions.provincial_tax,
        deductions.total_deductions,
        deductions.net_pay,
        deductions.country,
        deductions.province,
        deductions.tax_year,
        deductions.pay_frequency,
        deductions.pay_periods_per_year,
        deductions.pensionable_earnings,
        deductions.insurable_earnings,
        deductions.ytd_cpp,
        deductions.ytd_cpp2,
        deductions.ytd_ei,
        deductions.ytd_federal_tax,
        deductions.ytd_provincial_tax,
        albertaHolidayData.is_regular_day,
        albertaHolidayData.average_daily_wage,
        albertaHolidayData.worked_on_holiday,
        "premium_pay",
        albertaHolidayData.holiday_pay_calculated,
        albertaHolidayData.holiday_regular_weekday_count,
        albertaHolidayData.holiday_adw_period_start,
        albertaHolidayData.holiday_adw_period_end,
        albertaHolidayData.holiday_debug_notes,
        timestamp,
        timestamp,
      );

      // ── Alberta: insert per-holiday rows for every holiday in the period ──
      // Runs unconditionally so case "regular day + did not work" is captured.
      const newPayrollItemId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
      upsertAlbertaHolidayAutoRows({
        payrollItemId: newPayrollItemId,
        payrollPeriodId,
        employeeId: employee.employee_id,
        startDate,
        endDate,
        employeeRate,
      });
      // ── End Alberta per-holiday rows ─────────────────────────────────────
    });

    // NEW: salaried employees — additive, no changes to hourly logic above
    const activeSalariedEmployees = listActiveSalariedEmployees();

    const insertSalariedItem = db.prepare(`
      INSERT INTO payroll_items (
        payroll_period_id, employee_id, employee_name,
        total_hours, regular_hours, overtime_hours,
        hourly_rate, regular_pay, overtime_pay,
        gross_pay, gross_pay_total,
        holiday_hours, holiday_pay, holiday_label,
        vacation_rate, vacation_pay, vacation_payout, vacation_accrued,
        vacation_pay_schedule,
        pay_date, cheque_number, wage_rate_label,
        cpp_deduction, cpp_employer, cpp2_deduction,
        ei_deduction, ei_employer,
        federal_tax, provincial_tax,
        total_deductions, net_pay,
        country, province, tax_year,
        pay_frequency, pay_periods_per_year,
        pensionable_earnings, insurable_earnings,
        ytd_cpp, ytd_cpp2, ytd_ei,
        ytd_federal_tax, ytd_provincial_tax,
        pay_type, salary_base, salary_vacation_pay, salary_bonus, vacation_pay_pct,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
    `);

    activeSalariedEmployees.forEach((emp, sIdx) => {
      const salaryBase = roundMoney((emp.annual_salary || 0) / 12);
      const vacation = calculateVacationPayForEmployee({
        startDate: emp.start_date,
        payrollEndDate: endDate,
        vacationPaySchedule: "monthly",
        baseGrossPay: salaryBase,
      });
      const vacPct = Number((vacation.vacation_rate * 100).toFixed(2));
      const vacPay = vacation.vacation_pay;
      const bonus = roundMoney(Number(salariedBonusByEmployee[emp.id] || 0));
      const grossPayTotal = roundMoney(salaryBase + vacPay + bonus);

      const ytd = getApprovedPayrollYtdForEmployee({
        employeeId: emp.id,
        taxYear,
        country,
        province,
        periodStartDate: startDate,
        excludePayrollPeriodId: payrollPeriodId,
      });

      const deductions = calculateAlbertaPayrollDeductions2026({
        grossPayTotal,
        payFrequency: 'monthly',
        ytd,
        federalClaimAmount: emp.federal_claim_amount,
        provincialClaimAmount: emp.provincial_claim_amount,
      });

      const empContrib = calculateEmployerContributions({
        cppEmployee: deductions.cpp_deduction + deductions.cpp2_deduction,
        eiEmployee: deductions.ei_deduction,
      });

      const chequeNumber = buildChequeNumber(resolvedChequePrefix, employees.length + sIdx);

      insertSalariedItem.run(
        payrollPeriodId, emp.id, emp.name,
        0, 0, 0,
        0, 0, 0,
        salaryBase, grossPayTotal,
        0, 0, null,
        vacPct / 100, vacPay, vacPay, 0,
        'monthly',
        resolvedPayDate, chequeNumber, 'Monthly Salary',
        deductions.cpp_deduction, empContrib.cpp_employer, deductions.cpp2_deduction,
        deductions.ei_deduction, empContrib.ei_employer,
        deductions.federal_tax, deductions.provincial_tax,
        deductions.total_deductions, deductions.net_pay,
        deductions.country, deductions.province, deductions.tax_year,
        deductions.pay_frequency, deductions.pay_periods_per_year,
        deductions.pensionable_earnings, deductions.insurable_earnings,
        deductions.ytd_cpp, deductions.ytd_cpp2, deductions.ytd_ei,
        deductions.ytd_federal_tax, deductions.ytd_provincial_tax,
        'salaried', salaryBase, vacPay, bonus, vacPct,
        timestamp, timestamp,
      );
    });

    if (existingPeriod?.status === "approved" && allowApprovedRebuild) {
      const employeeIds = new Set([
        ...previousAccruedByEmployee.keys(),
        ...nextAccruedByEmployee.keys(),
      ]);

      employeeIds.forEach((employeeId) => {
        const previousAccrued = previousAccruedByEmployee.get(employeeId) || 0;
        const nextAccrued = nextAccruedByEmployee.get(employeeId) || 0;
        const delta = roundMoney(nextAccrued - previousAccrued);

        if (delta !== 0) {
          updateAccruedVacationBalance.run(delta, Number(employeeId));
        }
      });
    }

    return payrollPeriodId;
  });

  const payrollPeriodId = transaction();
  const payroll = getPayrollDetails(payrollPeriodId);
  insertAuditLog({
    entityType: "payroll",
    entityId: payroll.id,
    action: auditAction,
    changedFields: {
      after: {
        id: payroll.id,
        start_date: payroll.start_date,
        end_date: payroll.end_date,
        status: payroll.status,
        pay_frequency: payroll.pay_frequency,
        items_count: payroll.items.length,
      },
    },
    adminUser,
  });

  return payroll;
}

function recalculatePayroll(
  payrollPeriodId,
  { adminUser = null, allowApprovedRebuild = false } = {},
) {
  const payroll = getPayrollDetails(payrollPeriodId);

  if (!payroll) {
    return null;
  }

  return generatePayroll({
    startDate: payroll.start_date,
    endDate: payroll.end_date,
    payDate: payroll.pay_date || payroll.end_date,
    wageRateLabel: payroll.wage_rate_label || "Hourly rate",
    chequeNumberPrefix: payroll.cheque_number_prefix || null,
    taxYear: payroll.tax_year || PAYROLL_TAX_YEAR,
    country: payroll.country || PAYROLL_COUNTRY,
    province: payroll.province || PAYROLL_PROVINCE,
    payFrequency: payroll.pay_frequency || null,
    hourlyRatesByEmployee: Object.fromEntries(
      payroll.items
        .filter((i) => i.pay_type !== 'salaried')
        .map((item) => [item.employee_id, item.hourly_rate]),
    ),
    holidayAdjustmentsByEmployee: Object.fromEntries(
      payroll.items
        .filter((i) => i.pay_type !== 'salaried')
        .map((item) => [
          item.employee_id,
          {
            holidayPay: (item.holiday_hours || 0) > 0 ? null : item.holiday_pay || 0,
            holidayHours: item.holiday_hours || 0,
            holidayLabel: item.holiday_label || null,
          },
        ]),
    ),
    salariedBonusByEmployee: Object.fromEntries(
      payroll.items
        .filter((i) => i.pay_type === 'salaried')
        .map((i) => [i.employee_id, i.salary_bonus || 0]),
    ),
    allowApprovedRebuild,
    auditAction: "recalculated",
    adminUser,
  });
}

function updateSalariedItemBonus({ payrollPeriodId, payrollItemId, bonus, adminUser = null }) {
  const payroll = getPayrollDetails(payrollPeriodId);
  if (!payroll) {
    const error = new Error("Payroll not found.");
    error.code = "PAYROLL_NOT_FOUND";
    throw error;
  }
  if (payroll.status === 'approved') {
    const error = new Error("Payroll aprovado nao pode ser alterado.");
    error.code = "PAYROLL_APPROVED";
    throw error;
  }
  const item = payroll.items.find((i) => i.id === payrollItemId);
  if (!item || item.pay_type !== 'salaried') return null;

  const salaryBase = roundMoney(item.salary_base);
  const vacPay = roundMoney(item.salary_vacation_pay);
  const normalizedBonus = roundMoney(Number(bonus || 0));
  const grossPayTotal = roundMoney(salaryBase + vacPay + normalizedBonus);

  const ytd = getApprovedPayrollYtdForEmployee({
    employeeId: item.employee_id,
    taxYear: payroll.tax_year,
    country: payroll.country,
    province: payroll.province,
    periodStartDate: payroll.start_date,
    excludePayrollPeriodId: payrollPeriodId,
  });

  const emp = findEmployeeById(item.employee_id);
  const deductions = calculateAlbertaPayrollDeductions2026({
    grossPayTotal,
    payFrequency: 'monthly',
    ytd,
    federalClaimAmount: emp?.federal_claim_amount,
    provincialClaimAmount: emp?.provincial_claim_amount,
  });
  const empContrib = calculateEmployerContributions({
    cppEmployee: deductions.cpp_deduction + deductions.cpp2_deduction,
    eiEmployee: deductions.ei_deduction,
  });

  db.prepare(`
    UPDATE payroll_items
    SET salary_bonus = ?, gross_pay_total = ?,
        cpp_deduction = ?, cpp_employer = ?, cpp2_deduction = ?,
        ei_deduction = ?, ei_employer = ?,
        federal_tax = ?, provincial_tax = ?,
        total_deductions = ?, net_pay = ?,
        pensionable_earnings = ?, insurable_earnings = ?,
        ytd_cpp = ?, ytd_cpp2 = ?, ytd_ei = ?,
        ytd_federal_tax = ?, ytd_provincial_tax = ?,
        updated_at = ?
    WHERE id = ? AND payroll_period_id = ?
  `).run(
    normalizedBonus, grossPayTotal,
    deductions.cpp_deduction, empContrib.cpp_employer, deductions.cpp2_deduction,
    deductions.ei_deduction, empContrib.ei_employer,
    deductions.federal_tax, deductions.provincial_tax,
    deductions.total_deductions, deductions.net_pay,
    deductions.pensionable_earnings, deductions.insurable_earnings,
    deductions.ytd_cpp, deductions.ytd_cpp2, deductions.ytd_ei,
    deductions.ytd_federal_tax, deductions.ytd_provincial_tax,
    new Date().toISOString(),
    payrollItemId, payrollPeriodId,
  );

  db.prepare(`UPDATE payroll_periods SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), payrollPeriodId);

  return getPayrollDetails(payrollPeriodId);
}

function approvePayroll(payrollPeriodId, adminUser = null) {
  const payroll = getPayrollDetails(payrollPeriodId);

  if (!payroll) {
    return null;
  }

  if (payroll.status === "approved") {
    return payroll;
  }

  const applyAccruedVacationBalances = db.prepare(
    `
    UPDATE employees
    SET accrued_vacation_balance = COALESCE(accrued_vacation_balance, 0) + ?
    WHERE id = ?
    `,
  );

  const transaction = db.transaction(() => {
    for (const item of payroll.items) {
      if ((item.vacation_accrued || 0) > 0) {
        applyAccruedVacationBalances.run(item.vacation_accrued, item.employee_id);
      }
    }

    db.prepare(
      `
      UPDATE payroll_periods
      SET status = 'approved', updated_at = ?
      WHERE id = ?
      `,
    ).run(new Date().toISOString(), payrollPeriodId);
  });

  transaction();

  const approvedPayroll = getPayrollDetails(payrollPeriodId);
  insertAuditLog({
    entityType: "payroll",
    entityId: approvedPayroll.id,
    action: "approved",
    changedFields: {
      before: {
        id: payroll.id,
        status: payroll.status,
      },
      after: {
        id: approvedPayroll.id,
        status: approvedPayroll.status,
      },
    },
    adminUser,
  });

  return approvedPayroll;
}

function updatePayrollItemHoliday({
  payrollPeriodId,
  payrollItemId,
  holidayPay,
  holidayHours,
  holidayLabel,
  adminUser = null,
}) {
  const payroll = getPayrollDetails(payrollPeriodId);

  if (!payroll) {
    return null;
  }

  if (payroll.status === "approved") {
    const error = new Error("Payroll aprovado nao pode ser alterado.");
    error.code = "PAYROLL_APPROVED";
    throw error;
  }

  const item = payroll.items.find((currentItem) => currentItem.id === payrollItemId);

  if (!item) {
    return null;
  }

  const normalizedHolidayPay = calculateHolidayPayAmount({
    holidayPay,
    holidayHours,
    hourlyRate: item.hourly_rate,
  });

  if (normalizedHolidayPay < 0) {
    const error = new Error("holiday_pay cannot be negative.");
    error.code = "INVALID_HOLIDAY_PAY";
    throw error;
  }

  const normalizedHolidayHours =
    holidayPay !== undefined && holidayPay !== null && holidayPay !== ""
      ? 0
      : Number(holidayHours || 0);
  const normalizedHolidayLabel =
    normalizedHolidayPay > 0
      ? String(holidayLabel || item.holiday_label || "Holiday Pay").trim() || "Holiday Pay"
      : null;
  const grossPayTotal = Number(
    (
      item.gross_pay +
      normalizedHolidayPay +
      (item.vacation_payout || 0)
    ).toFixed(2),
  );
  const ytd = getApprovedPayrollYtdForEmployee({
    employeeId: item.employee_id,
    taxYear: payroll.tax_year || item.tax_year || PAYROLL_TAX_YEAR,
    country: payroll.country || item.country || PAYROLL_COUNTRY,
    province: payroll.province || item.province || PAYROLL_PROVINCE,
    periodStartDate: payroll.start_date,
    excludePayrollPeriodId: payrollPeriodId,
  });
  const deductions = calculatePayrollDeductions({
    grossPayTotal,
    payFrequency: payroll.pay_frequency || item.pay_frequency,
    ytd,
  });
  const employerContributions = calculateEmployerContributions({
    cppEmployee: deductions.cpp_deduction + deductions.cpp2_deduction,
    eiEmployee: deductions.ei_deduction,
  });

  db.prepare(
    `
    UPDATE payroll_items
    SET
      holiday_hours = ?,
      holiday_pay = ?,
      holiday_label = ?,
      gross_pay_total = ?,
      gross_pay = ?,
      cpp_deduction = ?,
      cpp_employer = ?,
      cpp2_deduction = ?,
      ei_deduction = ?,
      ei_employer = ?,
      federal_tax = ?,
      provincial_tax = ?,
      total_deductions = ?,
      net_pay = ?,
      country = ?,
      province = ?,
      tax_year = ?,
      pay_frequency = ?,
      pay_periods_per_year = ?,
      pensionable_earnings = ?,
      insurable_earnings = ?,
      ytd_cpp = ?,
      ytd_cpp2 = ?,
      ytd_ei = ?,
      ytd_federal_tax = ?,
      ytd_provincial_tax = ?,
      updated_at = ?
    WHERE id = ?
      AND payroll_period_id = ?
    `,
  ).run(
    normalizedHolidayHours,
    normalizedHolidayPay,
    normalizedHolidayLabel,
    grossPayTotal,
    item.gross_pay,
    deductions.cpp_deduction,
    employerContributions.cpp_employer,
    deductions.cpp2_deduction,
    deductions.ei_deduction,
    employerContributions.ei_employer,
    deductions.federal_tax,
    deductions.provincial_tax,
    deductions.total_deductions,
    deductions.net_pay,
    deductions.country,
    deductions.province,
    deductions.tax_year,
    deductions.pay_frequency,
    deductions.pay_periods_per_year,
    deductions.pensionable_earnings,
    deductions.insurable_earnings,
    deductions.ytd_cpp,
    deductions.ytd_cpp2,
    deductions.ytd_ei,
    deductions.ytd_federal_tax,
    deductions.ytd_provincial_tax,
    new Date().toISOString(),
    payrollItemId,
    payrollPeriodId,
  );

  db.prepare(
    `
    UPDATE payroll_periods
    SET updated_at = ?
    WHERE id = ?
    `,
  ).run(new Date().toISOString(), payrollPeriodId);

  const updatedPayroll = getPayrollDetails(payrollPeriodId);
  const updatedItem = updatedPayroll.items.find((item) => item.id === payrollItemId);
  insertAuditLog({
    entityType: "payroll",
    entityId: updatedPayroll.id,
    employeeId: item.employee_id,
    action: "holiday_updated",
    changedFields: {
      payroll_item_id: payrollItemId,
      before: {
        holiday_hours: item.holiday_hours,
        holiday_pay: item.holiday_pay,
        holiday_label: item.holiday_label,
        gross_pay_total: item.gross_pay_total,
      },
      after: {
        holiday_hours: updatedItem?.holiday_hours,
        holiday_pay: updatedItem?.holiday_pay,
        holiday_label: updatedItem?.holiday_label,
        gross_pay_total: updatedItem?.gross_pay_total,
      },
    },
    adminUser,
  });

  return updatedPayroll;
}

function calculatePayrollHours({ startDate, endDate }) {
  const records = listTimeRecordsAscending({
    startDate: `${startDate}T00:00:00`,
    endDate: `${endDate}T23:59:59`,
    recordStatus: "active",
  });

  const employeeDailyHours = new Map();
  const openCheckIns = new Map();

  for (const record of records) {
    const employeeId = record.employee_id;
    const employeeKey = String(employeeId);

    if (!employeeDailyHours.has(employeeKey)) {
      employeeDailyHours.set(employeeKey, {
        employee_id: employeeId,
        employee_name: record.employee_name,
        daily_hours: new Map(),
        holiday_hours: 0,
        holiday_weighted_hours: 0,
        holiday_labels: new Set(),
      });
    }

    const employeeHours = employeeDailyHours.get(employeeKey);

    if (!employeeHours.daily_hours.has(record.recorded_at.slice(0, 10))) {
      employeeHours.daily_hours.set(record.recorded_at.slice(0, 10), {
        clock_hours: 0,
        manual_hours: 0,
      });
    }

    if (record.entry_mode === "manual") {
      const workDate = record.recorded_at.slice(0, 10);
      if (record.manual_category === "holiday") {
        const holidayHours = Number(record.worked_hours || 0);
        const holidayMultiplier = Number(
          record.holiday_multiplier || HOLIDAY_PAY_RULE.multiplier,
        );
        employeeHours.holiday_hours += holidayHours;
        employeeHours.holiday_weighted_hours += holidayHours * holidayMultiplier;

        if (record.holiday_label) {
          employeeHours.holiday_labels.add(record.holiday_label);
        }
      } else {
        const dailyHours = employeeHours.daily_hours.get(workDate);
        dailyHours.manual_hours += Number(record.worked_hours || 0);
      }
      continue;
    }

    if (record.type === "check-in") {
      openCheckIns.set(employeeId, record);
      continue;
    }

    const openRecord = openCheckIns.get(employeeId);

    if (!openRecord) {
      continue;
    }

    const start = new Date(openRecord.recorded_at);
    const end = new Date(record.recorded_at);
    const durationInHours = (end - start) / (1000 * 60 * 60);

    openCheckIns.delete(employeeId);

    if (durationInHours <= 0) {
      continue;
    }

    const workDate = openRecord.recorded_at.slice(0, 10);
    const dailyHours = employeeHours.daily_hours.get(workDate) || {
      clock_hours: 0,
      manual_hours: 0,
    };
    dailyHours.clock_hours += durationInHours;
    employeeHours.daily_hours.set(workDate, dailyHours);
  }

  return Array.from(employeeDailyHours.values()).map((employee) => {
    let regularHours = 0;
    let overtimeHours = 0;

    for (const dailyHours of employee.daily_hours.values()) {
      const clockHours = Number(dailyHours.clock_hours || 0);
      const manualHours = Number(dailyHours.manual_hours || 0);

      regularHours += Math.min(
        clockHours,
        PAYROLL_OVERTIME_RULE.regularHoursPerDay,
      );
      regularHours += manualHours;
      overtimeHours += Math.max(
        0,
        clockHours - PAYROLL_OVERTIME_RULE.regularHoursPerDay,
      );
    }

    const totalHours = regularHours + overtimeHours;

    return {
      employee_id: employee.employee_id,
      employee_name: employee.employee_name,
      regular_hours: Number(regularHours.toFixed(2)),
      overtime_hours: Number(overtimeHours.toFixed(2)),
      total_hours: Number(totalHours.toFixed(2)),
      holiday_hours: Number(employee.holiday_hours.toFixed(2)),
      holiday_weighted_hours: Number(employee.holiday_weighted_hours.toFixed(2)),
      holiday_label:
        employee.holiday_labels.size === 1
          ? Array.from(employee.holiday_labels)[0]
          : employee.holiday_labels.size > 1
            ? "Holiday Pay"
            : null,
    };
  });
}

function createAdminUser({ name, email, passwordHash, role = "super_admin" }) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO admin_users (name, email, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(name, email, passwordHash, role, now, now);
}

function findAdminUserByEmail(email) {
  return db.prepare(`SELECT * FROM admin_users WHERE email = ? AND active = 1`).get(email);
}

function findAdminUserById(id) {
  return db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(id);
}

function listAdminUsers() {
  return db.prepare(`SELECT id, name, email, role, active, created_at FROM admin_users ORDER BY id ASC`).all();
}

function countAdminUsers() {
  return db.prepare(`SELECT COUNT(*) as count FROM admin_users WHERE active = 1`).get().count;
}

function updateAdminUser(id, { name }) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE admin_users SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
}

function updateAdminUserPassword(id, passwordHash) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(passwordHash, now, id);
}

function deactivateAdminUser(id) {
  db.prepare(`UPDATE admin_users SET active = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

function reactivateAdminUser(id) {
  db.prepare(`UPDATE admin_users SET active = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

function getClockStats() {
  const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: "America/Edmonton" });
  const todayStart = `${todayLocal}T00:00:00`;
  const todayEnd = `${todayLocal}T23:59:59`;

  const currentlyWorkingRows = db.prepare(`
    SELECT DISTINCT tr.employee_id, e.name as employee_name
    FROM time_records tr
    JOIN employees e ON e.id = tr.employee_id
    WHERE tr.deleted_at IS NULL
      AND tr.recorded_at >= ? AND tr.recorded_at <= ?
      AND tr.type = 'check-in'
      AND NOT EXISTS (
        SELECT 1 FROM time_records tr2
        WHERE tr2.employee_id = tr.employee_id
          AND tr2.type = 'check-out'
          AND tr2.deleted_at IS NULL
          AND tr2.recorded_at > tr.recorded_at
          AND tr2.recorded_at >= ? AND tr2.recorded_at <= ?
      )
  `).all(todayStart, todayEnd, todayStart, todayEnd);

  const allOpenRows = db.prepare(`
    SELECT COUNT(DISTINCT employee_id) as count
    FROM (
      SELECT employee_id, MAX(recorded_at) as last_record, type
      FROM time_records
      WHERE deleted_at IS NULL
      GROUP BY employee_id
      HAVING type = 'check-in'
    )
  `).get();

  const lastEvent = db.prepare(`
    SELECT tr.type as entry_type, tr.recorded_at, e.name as employee_name
    FROM time_records tr
    JOIN employees e ON e.id = tr.employee_id
    WHERE tr.deleted_at IS NULL
    ORDER BY tr.recorded_at DESC
    LIMIT 1
  `).get();

  return {
    currentlyWorking: currentlyWorkingRows.length,
    allOpen: allOpenRows?.count || 0,
    lastEvent: lastEvent || null,
  };
}

function updatePayrollItemCheque(itemId, { paymentReference, sendStatus }) {
  db.prepare(`UPDATE payroll_items SET payment_reference = ?, send_status = ?, updated_at = ? WHERE id = ?`)
    .run(paymentReference, sendStatus || 'ready', new Date().toISOString(), itemId);
}

function markPayrollItemSent(itemId) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE payroll_items SET send_status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, itemId);
}

function getPayrollItemById(itemId) {
  return db.prepare(`SELECT pi.*, e.name as employee_name, e.email as employee_email FROM payroll_items pi LEFT JOIN employees e ON e.id = pi.employee_id WHERE pi.id = ?`).get(itemId);
}

module.exports = {
  createAdminUser,
  findAdminUserByEmail,
  findAdminUserById,
  listAdminUsers,
  countAdminUsers,
  updateAdminUser,
  updateAdminUserPassword,
  deactivateAdminUser,
  reactivateAdminUser,
  getClockStats,
  updatePayrollItemCheque,
  markPayrollItemSent,
  getPayrollItemById,
  initializeDatabase,
  listEmployees,
  listAdminEmployees,
  listTimeRecordAuditLogs,
  listPayrollAuditLogs,
  listEmployeeAuditLogs,
  listAuditLogsPaginated,
  listAuditLogsForExport,
  createAdminSession,
  getAdminSession,
  deleteAdminSession,
  cleanupExpiredAdminSessions,
  getAdminLoginAttempt,
  upsertAdminLoginAttempt,
  clearAdminLoginAttempt,
  cleanupAdminLoginAttempts,
  findEmployeeById,
  verifyEmployeePin,
  createEmployee,
  updateEmployeePayrollSettings,
  getEmployeeDependencySummary,
  deleteEmployee,
  findTimeRecordById,
  getLastTimeRecord,
  createTimeRecord,
  listTimeRecords,
  listTimeRecordsPaginated,
  summarizeTimeRecords,
  createManualTimeRecord,
  updateManualTimeRecord,
  createManualHoursEntry,
  updateManualHoursEntry,
  deleteManualTimeRecord,
  restoreManualTimeRecord,
  listPayrollPeriods,
  getPayrollDetails,
  getPayrollPayslip,
  generatePayroll,
  recalculatePayroll,
  approvePayroll,
  updatePayrollItemHoliday,
  listActiveSalariedEmployees,
  updateSalariedItemBonus,
  // Alberta holiday pay helpers
  isRegularDayOfWork,
  calculateAverageDailyWage,
  didEmployeeWorkHoliday,
  calculateAlbertaHolidayPay,
  getHolidayForDate,
  getHolidaysInPeriod,
  listHolidays,
  getAlbertaHolidaysForPayroll,
  saveAlbertaHolidayOverride,
  clearAlbertaHolidayOverride,
  PAYROLL_OVERTIME_RULE,
  HOLIDAY_PAY_RULE,
  VACATION_PAY_RULE,
  VACATION_PAY_SCHEDULES,
  DEFAULT_VACATION_PAY_SCHEDULE,
  PAY_FREQUENCIES,
  DEFAULT_PAY_FREQUENCY,
  DEFAULT_AUDIT_PAGE_SIZE,
  MAX_AUDIT_PAGE_SIZE,
  databasePath,
};
