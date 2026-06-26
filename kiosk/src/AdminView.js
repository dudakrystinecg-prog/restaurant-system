import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UsersRound, Clock, StickyNote, SendHorizontal, Mail, History,
  Settings2, ArrowLeft, LogOut, TriangleAlert, Calendar,
  CheckCircle, IdCard, Timer, ClipboardList, Pencil
} from "lucide-react";
import "./AdminView.css";
import "./PayrollPayslip.css";

const API_BASE_URL = "/api";
const DEFAULT_PAGE_SIZE = 10;
const ADMIN_TOKEN_KEY = "restaurant-admin-token";
const COMPANY_NAME = "Sushi House Banff";
const COMPANY_ADDRESS = "304 Caribou Street, P.O. Box 1985, Banff, Alberta, Canada T1L 1B7";

const initialFormState = {
  employeeId: "",
  type: "check-in",
  recordedAt: "",
  kioskId: "",
};

const initialManualHoursFormState = {
  employeeId: "",
  workDate: "",
  regularHours: "",
  holidayLabel: "Family Day",
  holidayHours: "",
  holidayMultiplier: "1.5",
  note: "",
};

const initialSummaryState = {
  period: {
    start: null,
    end: null,
    record_status: "active",
  },
  totals: {
    employees_with_records: 0,
    total_check_ins: 0,
    total_check_outs: 0,
    total_records: 0,
    total_hours: 0,
    complete_shifts: 0,
    open_shifts: 0,
    payroll_ready_hours: 0,
  },
  employees: [],
};

const initialAuditResponse = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  totalPages: 0,
};

const initialEmployeeFormState = {
  name: "",
  pin: "",
  active: true,
  defaultHourlyRate: "",
  defaultPayFrequency: "",
  startDate: "",
  vacationPaySchedule: "monthly",
  pay_type: "hourly",
  annual_salary: "",
  vacation_pay_pct: 4,
};

function buildHolidayInputState(items = []) {
  return Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        amount: String(item.holiday_pay || 0),
        label: item.holiday_label || "Holiday Pay",
      },
    ]),
  );
}

function getStoredAdminToken() {
  return window.localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setStoredAdminToken(token) {
  window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function clearStoredAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_KEY);
}

const TZ = "America/Edmonton";

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-CA", {
    timeZone: TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach(({ type, value: v }) => { p[type] = v; });
  const h = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${h}:${p.minute}`;
}

function toIsoString(value) {
  return new Date(value).toISOString();
}

function toDateValue(value) {
  return value ? String(value).slice(0, 10) : "";
}

function formatTimeRecordType(record) {
  if (record.entry_mode === "manual") {
    if (record.manual_category === "holiday") {
      return `${record.holiday_label || "Holiday Pay"} - ${Number(record.worked_hours || 0).toFixed(2)} h @ ${Number(record.holiday_multiplier || 1.5).toFixed(2)}x`;
    }

    return `Manual hours (no overtime) - ${Number(record.worked_hours || 0).toFixed(2)} h`;
  }

  return record.type;
}

function normalizeDecimalInput(value) {
  return String(value || "").replace(",", ".").trim();
}

async function parseJsonResponse(response) {
  const responseText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!responseText) {
    return {};
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(responseText);
  }

  try {
    return JSON.parse(responseText);
  } catch (_error) {
    if (responseText.startsWith("<!DOCTYPE") || responseText.startsWith("<html")) {
      throw new Error(
        "The API returned HTML instead of JSON. Restart the backend on port 3001 and try again.",
      );
    }

    throw new Error("The API returned an unexpected response.");
  }
}

function getPayFrequencyLabel(code, payrollConfig) {
  return (
    payrollConfig?.pay_frequency_options?.find((option) => option.code === code)?.label ||
    code ||
    "Use payroll period"
  );
}

function getVacationScheduleLabel(code) {
  return code === "accrued" ? "Accrued balance" : "Monthly payout";
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatHours(value) {
  return `${Number(value || 0).toFixed(2)} hrs`;
}

function getVacationPayPercentForStartDate(startDate, referenceDate = new Date()) {
  if (!startDate) {
    return 0;
  }

  const start = new Date(`${startDate}T00:00:00`);
  const reference = new Date(referenceDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(reference.getTime())) {
    return 0;
  }

  let years = reference.getFullYear() - start.getFullYear();
  const anniversary = new Date(reference.getFullYear(), start.getMonth(), start.getDate());

  if (reference < anniversary) {
    years -= 1;
  }

  if (years >= 5) return 6;
  if (years >= 1) return 4;
  return 0;
}

function getPayslipEarningsRows(payslip) {
  const rows = [
    {
      label: "Regular Earnings",
      value: payslip.earnings.regular_earnings,
    },
  ];

  if (Number(payslip.earnings.vacation_pay || 0) > 0) {
    rows.push({
      label: "Vacation Pay",
      value: payslip.earnings.vacation_pay,
    });
  }

  if (Number(payslip.earnings.extra_pay || 0) > 0) {
    rows.push({
      label: payslip.earnings.extra_pay_label || "Holiday Pay",
      value: payslip.earnings.extra_pay,
    });
  }

  rows.push({
    label: "Total Earnings",
    value: payslip.earnings.total_earnings,
    isTotal: true,
  });

  return rows;
}

function getPayslipDeductionRows(payslip) {
  return [
    {
      label: "Federal Tax",
      value: payslip.deductions.federal_tax,
    },
    {
      label: "Provincial Tax",
      value: payslip.deductions.provincial_tax,
    },
    {
      label: "CPP",
      value: payslip.deductions.cpp,
    },
    {
      label: "EI",
      value: payslip.deductions.ei,
    },
    {
      label: "Total Deductions",
      value: payslip.deductions.total_deductions,
      isTotal: true,
    },
  ];
}

function buildPayslipPrintHtml(payslip) {
  const benefitsNote = payslip.benefits_note || "";
  const earningsRows = getPayslipEarningsRows(payslip)
    .map((row, index) => {
      const benefitCell = index === 0 && benefitsNote ? benefitsNote : "";
      return `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td class="amount">${formatMoney(row.value)}</td><td class="benefits">${benefitCell}</td></tr>`;
    })
    .join("");
  const deductionRows = getPayslipDeductionRows(payslip)
    .map(
      (row) => `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td class="amount">${formatMoney(row.value)}</td><td class="benefits"></td></tr>`,
    )
    .join("");
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Payslip - ${payslip.employee_name}</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; background: #f3f4f6; color: #111111; padding: 24px; }
        .sheet { max-width: 900px; margin: 0 auto; background: white; border: 1px solid #4b5563; }
        .header { padding: 18px 22px 10px; display: flex; align-items: center; gap: 14px; }
        .header-logo { height: 52px; width: auto; }
        .title { font-size: 20px; font-weight: 700; margin: 0; }
        .address { color: #4b5563; font-size: 12px; margin: 2px 0 0; }
        .subtitle { color: #111111; font-size: 13px; font-weight: 600; margin: 4px 0 0; }
        .meta-table, .statement-table { width: calc(100% - 44px); margin: 0 22px 18px; border-collapse: collapse; }
        .meta-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 13px; vertical-align: top; }
        .meta-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #4b5563; margin-bottom: 4px; }
        .meta-value { font-size: 14px; font-weight: 600; color: #111111; }
        .statement-table th, .statement-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 14px; }
        .statement-table th { background: #e5e7eb; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; text-align: left; }
        .statement-table .amount, .statement-table th.amount { text-align: right; width: 160px; }
        .statement-table .benefits, .statement-table th.benefits { width: 260px; white-space: pre-line; }
        .section-row td { background: #f3f4f6; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        .is-total td { font-weight: 700; background: #fafafa; }
        .net-row td { font-weight: 700; font-size: 18px; background: #e5e7eb; }
        .note { margin: 0 22px 22px; padding: 10px 12px; border: 1px solid #9ca3af; font-size: 12px; color: #374151; background: #f9fafb; }
        @media print { body { background: white; padding: 0; } .sheet { border: none; } }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <img class="header-logo" src="/logo.png" alt="${COMPANY_NAME} logo" />
          <div>
            <h1 class="title">${COMPANY_NAME}</h1>
            <p class="address">${COMPANY_ADDRESS}</p>
            <p class="subtitle">Employee Earnings Statement</p>
          </div>
        </div>
        <table class="meta-table">
          <tr>
            <td><span class="meta-label">Employee</span><span class="meta-value">${payslip.header.employee}</span></td>
            <td><span class="meta-label">Pay Period</span><span class="meta-value">${payslip.header.pay_period}</span></td>
            <td><span class="meta-label">Total Hours</span><span class="meta-value">${formatHours(payslip.header.total_hours)}</span></td>
            <td><span class="meta-label">Wage Rate</span><span class="meta-value">${payslip.header.wage_rate}</span></td>
            <td><span class="meta-label">Pay Date</span><span class="meta-value">${payslip.header.pay_date}</span></td>
            <td><span class="meta-label">Cheque No.</span><span class="meta-value">${payslip.header.payment_reference || "-"}</span></td>
          </tr>
        </table>
        <table class="statement-table">
          <thead>
            <tr>
              <th>Description</th>
              <th class="amount">Amount</th>
              <th class="benefits">Benefits</th>
            </tr>
          </thead>
          <tbody>
            <tr class="section-row"><td colspan="3">Income / Earnings</td></tr>
            ${earningsRows}
            <tr class="section-row"><td colspan="3">Deductions</td></tr>
            ${deductionRows}
            <tr class="net-row"><td>Net Pay</td><td class="amount">${formatMoney(payslip.totals.net_pay)}</td><td class="benefits"></td></tr>
          </tbody>
        </table>
        ${payslip.notes.accrued_vacation_balance_note ? `<div class="note">${payslip.notes.accrued_vacation_balance_note}</div>` : ""}
      </div>
      <script>window.onload = () => window.print();</script>
    </body>
  </html>`;
}

function buildTeamPayrollPrintHtml(payroll) {
  const rows = (payroll.items || [])
    .map(
      (item) => `
        <tr>
          <td>${item.employee_name}</td>
          <td>${item.vacation_pay_schedule === "accrued" ? "Accrued balance" : "Monthly payout"}</td>
          <td>$${Number(item.gross_pay || 0).toFixed(2)}</td>
          <td>$${Number(item.total_earnings || 0).toFixed(2)}</td>
          <td>$${Number(item.tax_total || 0).toFixed(2)}</td>
          <td>$${Number(item.cpp_total || 0).toFixed(2)}</td>
          <td>$${Number(item.ei_deduction || 0).toFixed(2)}</td>
          <td>$${Number(item.net_pay || 0).toFixed(2)}</td>
        </tr>`,
    )
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Team Payroll - ${payroll.start_date} to ${payroll.end_date}</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; background: #f3f4f6; color: #111111; padding: 24px; }
        .sheet { max-width: 1100px; margin: 0 auto; background: white; border: 1px solid #4b5563; }
        .header { padding: 18px 22px 10px; }
        .title { font-size: 24px; font-weight: 700; margin: 0; }
        .subtitle { color: #4b5563; font-size: 13px; margin: 4px 0 0; }
        .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 0 22px 18px; }
        .summary-card { border: 1px solid #cbd5e1; padding: 10px 12px; }
        .summary-label { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #4b5563; margin-bottom: 4px; }
        .summary-value { font-size: 16px; font-weight: 700; }
        table { width: calc(100% - 44px); margin: 0 22px 22px; border-collapse: collapse; }
        th, td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 13px; }
        th { background: #e5e7eb; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; text-align: left; }
        td:nth-child(n+3), th:nth-child(n+3) { text-align: right; }
        @media print { body { background: white; padding: 0; } .sheet { border: none; } }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <h1 class="title">Team Payroll Package</h1>
          <p class="subtitle">${payroll.start_date} to ${payroll.end_date} Ã‚Â· ${payroll.pay_frequency} Ã‚Â· ${payroll.status}</p>
        </div>
        <div class="summary">
          <div class="summary-card"><div class="summary-label">Gross</div><div class="summary-value">$${Number(payroll.totals.total_gross_pay || 0).toFixed(2)}</div></div>
          <div class="summary-card"><div class="summary-label">Total earnings</div><div class="summary-value">$${Number(payroll.totals.total_earnings || 0).toFixed(2)}</div></div>
          <div class="summary-card"><div class="summary-label">Vacation paid now</div><div class="summary-value">$${Number(payroll.totals.total_vacation_payout || 0).toFixed(2)}</div></div>
          <div class="summary-card"><div class="summary-label">Net pay</div><div class="summary-value">$${Number(payroll.totals.total_net_pay || 0).toFixed(2)}</div></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Vacation schedule</th>
              <th>Gross</th>
              <th>Total earnings</th>
              <th>Tax total</th>
              <th>CPP</th>
              <th>EI</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <script>window.onload = () => window.print();</script>
    </body>
  </html>`;
}

function buildQueryString(filters, pagination = {}) {
  const query = new URLSearchParams();

  if (filters.employeeId) {
    query.set("employee_id", filters.employeeId);
  }
  if (filters.start) {
    query.set("start", `${filters.start}T00:00:00`);
  }
  if (filters.end) {
    query.set("end", `${filters.end}T23:59:59`);
  }
  if (filters.recordStatus) {
    query.set("record_status", filters.recordStatus);
  }
  if (filters.open_only) {
    query.set("open_only", "true");
  }
  if (pagination.page) {
    query.set("page", pagination.page);
  }
  if (pagination.pageSize) {
    query.set("pageSize", pagination.pageSize);
  }

  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

function buildAuditQueryString(filters = {}, pagination = {}, extra = {}) {
  const query = new URLSearchParams();

  if (filters.action) {
    query.set("action", filters.action);
  }
  if (filters.employeeId) {
    query.set("employee_id", filters.employeeId);
  }
  if (filters.start) {
    query.set("start", filters.start);
  }
  if (filters.end) {
    query.set("end", filters.end);
  }
  if (extra.employeeId) {
    query.set("employee_id", extra.employeeId);
  }
  if (extra.recordId) {
    query.set("record_id", extra.recordId);
  }
  if (extra.payrollId) {
    query.set("payroll_id", extra.payrollId);
  }
  if (pagination.page) {
    query.set("page", pagination.page);
  }
  if (pagination.pageSize) {
    query.set("pageSize", pagination.pageSize);
  }

  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

function PaginationControls({ response, onPageChange, onPageSizeChange }) {
  return (
    <div className="admin-pagination">
      <div className="admin-pagination__meta">
        Total: {response.total} | Page {response.totalPages === 0 ? 0 : response.page} of {response.totalPages}
      </div>

      <div className="admin-pagination__actions">
        <select
          value={response.pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="admin-select admin-select--compact"
        >
          {[10, 20, 50].map((size) => (
            <option key={size} value={size}>
              {size}/page
            </option>
          ))}
        </select>

        <button
          onClick={() => onPageChange(response.page - 1)}
          disabled={response.page <= 1}
          className="admin-button admin-button--secondary admin-button--compact"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(response.page + 1)}
          disabled={response.totalPages === 0 || response.page >= response.totalPages}
          className="admin-button admin-button--secondary admin-button--compact"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function proserveStatus(expiry) {
  if (!expiry) return null;
  const days = Math.floor((new Date(expiry) - new Date()) / 86400000);
  if (days < 0) return "expired";
  if (days < 30) return "expiring";
  return "ok";
}

function getProServeBadgeLabel(status) {
  if (status === "ok") return "Valid";
  if (status === "expiring") return "Expiring";
  if (status === "expired") return "Expired";
  return "No ProServe";
}

function FormSection({ icon, label }) {
  return (
    <div className="admin-form-section">
      {icon && <span>{icon}</span>}
      <span>{label}</span>
    </div>
  );
}

const FIELD_LABELS = {
  name: "Name",
  active: "Status",
  default_hourly_rate: "Hourly rate",
  default_pay_frequency: "Pay frequency",
  start_date: "Start date",
  vacation_pay_schedule: "Vacation pay",
  pay_type: "Pay type",
  annual_salary: "Annual salary",
  email: "Email",
  phone: "Phone",
  sin: "SIN",
  home_address: "Address",
  proserve_number: "ProServe #",
  proserve_expiry: "ProServe expiry",
  roe_last_day: "ROE last day",
  roe_hours: "ROE hours",
  roe_wage: "ROE wage",
  notes: "Notes",
  recorded_at: "Time",
  entry_type: "Type",
  entry_mode: "Mode",
  kiosk_id: "Kiosk ID",
};

function AuditActionBadge({ action }) {
  const a = (action || '').toLowerCase();
  let color = 'var(--c-text-muted)';
  let bg = 'rgba(138,128,120,0.10)';
  if (a.includes('creat') || a.includes('add') || a.includes('restor')) { bg = 'rgba(46,125,82,0.12)'; color = 'var(--c-jade)'; }
  else if (a.includes('delet') || a.includes('remov')) { bg = 'rgba(204,32,32,0.10)'; color = 'var(--c-red)'; }
  else if (a.includes('edit') || a.includes('updat') || a.includes('approv')) { bg = 'rgba(192,112,32,0.12)'; color = 'var(--c-amber)'; }
  const label = (action || '').replace(/_/g, ' ');
  return <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600, background: bg, color }}>{label}</span>;
}

function AuditDiff({ changedFields }) {
  if (!changedFields) return <span style={{ color: 'var(--c-text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>No changes recorded</span>;
  let parsed = changedFields;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return <span style={{ fontSize: '0.75rem', color: 'var(--c-text-muted)' }}>—</span>; }
  }
  const { after } = parsed;
  if (!after) return <span style={{ color: 'var(--c-text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>No changes recorded</span>;
  const SKIP = new Set(['pin_hash', 'pin', 'id', 'employee_id', 'created_at', 'updated_at']);
  const CHIP_COLORS = {
    type:                { bg: 'rgba(46,125,82,0.10)',   color: 'var(--c-jade)' },
    source:              { bg: 'rgba(192,112,32,0.10)',  color: 'var(--c-amber)' },
    hours:               { bg: 'rgba(74,64,64,0.08)',    color: 'var(--c-text-primary)' },
    overtime_multiplier: { bg: 'rgba(74,64,64,0.08)',    color: 'var(--c-text-primary)' },
    holiday_type:        { bg: 'rgba(192,112,32,0.10)',  color: 'var(--c-amber)' },
    holiday_hours:       { bg: 'rgba(74,64,64,0.08)',    color: 'var(--c-text-primary)' },
  };
  const DISPLAY_KEYS = ['type', 'source', 'hours', 'holiday_type', 'holiday_hours', 'overtime_multiplier', 'name', 'wage', 'pay_type', 'active'];
  const chips = DISPLAY_KEYS.filter(k => !SKIP.has(k) && after[k] !== undefined && after[k] !== null && after[k] !== '');
  if (chips.length === 0) return <span style={{ color: 'var(--c-text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>No changes recorded</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
      {chips.map(k => {
        const val = String(after[k]);
        const s = CHIP_COLORS[k] || { bg: 'rgba(74,64,64,0.07)', color: 'var(--c-text-muted)' };
        const label = k === 'hours' || k === 'holiday_hours' ? val + ' h' : k === 'overtime_multiplier' ? val + 'x' : val;
        return (
          <span key={k} style={{ padding: '0.15rem 0.55rem', borderRadius: 20, fontSize: '0.73rem', fontWeight: 500, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
            {label.charAt(0).toUpperCase() + label.slice(1)}
          </span>
        );
      })}
    </div>
  );
}
function SectionTabs({ tabs, activeTab, onChange, columnsClassName = "grid-cols-4" }) {
  const widthClass =
    columnsClassName === "grid-cols-3" ? "admin-tabs--three" : "admin-tabs--four";

  return (
    <div className={`admin-tabs ${widthClass}`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`admin-tab ${activeTab === tab.id ? "is-active" : ""}`}
        >
          <div className="admin-tab__kicker">{tab.kicker}</div>
          <div className="admin-tab__label">{tab.label}</div>
        </button>
      ))}
    </div>
  );
}

function LoginView({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  error,
  isSubmitting,
}) {
  return (
    <div className="admin-login-shell">
      <div className="admin-login-card">
        <div className="admin-login-card__logo"><img src="/logo.png" alt="Sushi House Banff" /></div>
        <h1 className="admin-login-card__title">Sushi House Banff</h1>
        <p className="admin-login-card__subtitle">Sign in to access the admin panel.</p>

        <form onSubmit={onSubmit} className="admin-login-form">
          <label className="admin-field">
            <span className="admin-field__label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              className="admin-input"
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
          </label>

          <label className="admin-field">
            <span className="admin-field__label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              className="admin-input"
              required
            />
          </label>

          {error ? (
            <div className="admin-alert admin-alert--error">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="admin-button admin-button--primary admin-button--full"
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

function SummaryCards({ summary }) {
  const cards = [
    { label: "Employees in period", value: summary.totals.employees_with_records },
    { label: "Records", value: summary.totals.total_records },
    { label: "Total hours", value: `${summary.totals.total_hours.toFixed(2)} h` },
    { label: "Payroll-ready hours", value: `${summary.totals.payroll_ready_hours.toFixed(2)} h` },
    { label: "Completed shifts", value: summary.totals.complete_shifts },
    { label: "Open shifts", value: summary.totals.open_shifts },
  ];

  return (
    <div className="admin-summary-grid">
      {cards.map((card) => (
        <div key={card.label} className="admin-summary-card">
          <div className="admin-summary-card__label">{card.label}</div>
          <div className="admin-summary-card__value">{card.value}</div>
        </div>
      ))}
    </div>
  );
}

function PayslipPreview({ payslip, onPrint, onClose }) {
  if (!payslip) {
    return null;
  }

  const earningsRows = getPayslipEarningsRows(payslip);
  const deductionRows = getPayslipDeductionRows(payslip);
  const benefitsNote = payslip.benefits_note || "";

  return (
    <div className="payslip-sheet">
      <div className="payslip-sheet__header">
        <div className="payslip-sheet__brand">
          <img src="/logo.png" alt={`${COMPANY_NAME} logo`} className="payslip-sheet__logo" />
          <div>
            <h3 className="payslip-sheet__title">{COMPANY_NAME}</h3>
            <p className="payslip-sheet__address">{COMPANY_ADDRESS}</p>
            <p className="payslip-sheet__subtitle">Employee Earnings Statement</p>
          </div>
        </div>
        <div className="admin-actions-row">
          <button onClick={onPrint} className="admin-button admin-button--secondary admin-button--compact">
            Print
          </button>
          <button onClick={onClose} className="admin-button admin-button--secondary admin-button--compact">
            Close
          </button>
        </div>
      </div>

      <table className="payslip-meta-table">
        <tbody>
          <tr>
            {[
              ["Employee", payslip.header.employee],
              ["Pay Period", payslip.header.pay_period],
              ["Total Hours", formatHours(payslip.header.total_hours)],
              ["Wage Rate", payslip.header.wage_rate],
              ["Pay Date", payslip.header.pay_date],
              ["Cheque No.", payslip.header.payment_reference || "-"],
            ].map(([label, value]) => (
              <td key={label}>
                <span className="payslip-meta-table__label">{label}</span>
                <span className="payslip-meta-table__value">{value}</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <table className="payslip-statement-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="payslip-statement-table__amount">Amount</th>
            <th className="payslip-statement-table__benefits">Benefits</th>
          </tr>
        </thead>
        <tbody>
          <tr className="payslip-section-row">
            <td colSpan="3">Income / Earnings</td>
          </tr>
          {earningsRows.map((row, index) => (
            <tr key={row.label} className={row.isTotal ? "is-total" : ""}>
              <td>{row.label}</td>
              <td className="payslip-statement-table__amount">{formatMoney(row.value)}</td>
              <td className="payslip-statement-table__benefits">
                {index === 0 && benefitsNote ? benefitsNote : ""}
              </td>
            </tr>
          ))}
          <tr className="payslip-section-row">
            <td colSpan="3">Deductions</td>
          </tr>
          {deductionRows.map((row) => (
            <tr key={row.label} className={row.isTotal ? "is-total" : ""}>
              <td>{row.label}</td>
              <td className="payslip-statement-table__amount">{formatMoney(row.value)}</td>
              <td className="payslip-statement-table__benefits"></td>
            </tr>
          ))}
          <tr className="payslip-net-row">
            <td>Net Pay</td>
            <td className="payslip-statement-table__amount">{formatMoney(payslip.totals.net_pay)}</td>
            <td className="payslip-statement-table__benefits"></td>
          </tr>
        </tbody>
      </table>

      {payslip.notes.accrued_vacation_balance_note ? (
        <div className="payslip-note">{payslip.notes.accrued_vacation_balance_note}</div>
      ) : null}
    </div>
  );
}

function SettingsView({ adminUser, adminFetch, onUserUpdated }) {
  const [adminUsers, setAdminUsers] = useState([]);
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountForm, setAccountForm] = useState({ name: adminUser?.name || "", currentPassword: "", newPassword: "", confirmPassword: "" });
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUserForm, setNewUserForm] = useState({ name: "", email: "", password: "" });
  const [resetingId, setResetingId] = useState(null);
  const [resetPassword, setResetPassword] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [testEmailStatus, setTestEmailStatus] = useState("");

  const loadUsers = useCallback(async () => {
    const res = await adminFetch("/api/admin/users");
    if (res.ok) { const data = await res.json(); setAdminUsers(data); }
  }, [adminFetch]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const showFeedback = (msg) => { setFeedback(msg); setError(""); setTimeout(() => setFeedback(""), 3000); };
  const showError = (msg) => { setError(msg); setFeedback(""); };

  const handleSaveAccount = async () => {
    if (accountForm.newPassword && accountForm.newPassword !== accountForm.confirmPassword) {
      return showError("Passwords do not match.");
    }
    try {
      if (accountForm.name !== adminUser?.name) {
        const r = await adminFetch("/api/admin/users/me", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: accountForm.name }) });
        if (!r.ok) { const d = await r.json(); return showError(d.error || "Failed to update name."); }
        if (onUserUpdated) onUserUpdated({ ...adminUser, name: accountForm.name });
      }
      if (accountForm.newPassword) {
        const r = await adminFetch("/api/admin/users/me/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: accountForm.currentPassword, newPassword: accountForm.newPassword }) });
        if (!r.ok) { const d = await r.json(); return showError(d.error || "Failed to change password."); }
      }
      showFeedback("Account updated successfully.");
      setEditingAccount(false);
      setAccountForm(f => ({ ...f, currentPassword: "", newPassword: "", confirmPassword: "" }));
    } catch (e) { showError(e.message); }
  };

  const handleAddUser = async () => {
    try {
      const r = await adminFetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newUserForm) });
      const d = await r.json();
      if (!r.ok) return showError(d.error || "Failed to add user.");
      showFeedback("User added.");
      setAddUserOpen(false);
      setNewUserForm({ name: "", email: "", password: "" });
      loadUsers();
    } catch (e) { showError(e.message); }
  };

  const handleDeactivate = async (id) => {
    if (!window.confirm("Deactivate this admin user?")) return;
    const r = await adminFetch(`/api/admin/users/${id}/deactivate`, { method: "PUT" });
    if (r.ok) { showFeedback("User deactivated."); loadUsers(); }
  };

  const handleReactivate = async (id) => {
    const r = await adminFetch(`/api/admin/users/${id}/reactivate`, { method: "PUT" });
    if (r.ok) { showFeedback("User reactivated."); loadUsers(); }
  };

  const handleResetPassword = async (id) => {
    if (!resetPassword) return showError("Enter a new password.");
    const r = await adminFetch(`/api/admin/users/${id}/password`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newPassword: resetPassword }) });
    if (r.ok) { showFeedback("Password reset."); setResetingId(null); setResetPassword(""); }
    else { const d = await r.json(); showError(d.error || "Failed."); }
  };

  const handleTestEmail = async () => {
    setTestEmailStatus("Sending...");
    try {
      const r = await adminFetch("/api/admin/email/test", { method: "POST" });
      const d = await r.json();
      if (r.ok) setTestEmailStatus("Test email sent successfully!");
      else setTestEmailStatus(`Error: ${d.error}`);
    } catch (e) { setTestEmailStatus(`Error: ${e.message}`); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {feedback && <div className="admin-alert admin-alert--success">{feedback}</div>}
      {error && <div className="admin-alert admin-alert--error">{error}</div>}

      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: "1rem" }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">My Account</h2>
          </div>
        </div>
        {!editingAccount ? (
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <div className="emp-table__avatar" style={{ width: 44, height: 44, fontSize: "1.1rem" }}>
              {(adminUser?.name || "A")[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--c-text-primary)" }}>{adminUser?.name || "Admin"}</div>
              <div style={{ fontSize: "0.8rem", color: "var(--c-text-muted)" }}>{adminUser?.email || ""}</div>
            </div>
            <button className="admin-employee-card-btn" style={{ marginLeft: "auto" }} onClick={() => { setEditingAccount(true); setAccountForm(f => ({ ...f, name: adminUser?.name || "" })); }}>
              Edit account
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", maxWidth: 560 }}>
            <label className="admin-field" style={{ gridColumn: "1/-1" }}>
              <span className="admin-field__label">Name</span>
              <input className="admin-input" value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Current password</span>
              <input type="password" className="admin-input" value={accountForm.currentPassword} onChange={e => setAccountForm(f => ({ ...f, currentPassword: e.target.value }))} placeholder="Leave blank to keep" />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">New password</span>
              <input type="password" className="admin-input" value={accountForm.newPassword} onChange={e => setAccountForm(f => ({ ...f, newPassword: e.target.value }))} />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Confirm password</span>
              <input type="password" className="admin-input" value={accountForm.confirmPassword} onChange={e => setAccountForm(f => ({ ...f, confirmPassword: e.target.value }))} />
            </label>
            <div style={{ gridColumn: "1/-1", display: "flex", gap: "0.75rem" }}>
              <button className="admin-button admin-button--primary admin-button--compact" onClick={handleSaveAccount}>Save</button>
              <button className="admin-button admin-button--secondary admin-button--compact" onClick={() => setEditingAccount(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: "1rem" }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">Admin Users</h2>
            <span className="admin-team-header__count">{adminUsers.length} user{adminUsers.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="admin-team-toolbar__right">
            <button className="admin-button admin-button--secondary admin-button--compact" onClick={() => setAddUserOpen(o => !o)}>
              {addUserOpen ? "Ã¢Å“â€¢ Cancel" : "+ Add admin"}
            </button>
          </div>
        </div>

        {addUserOpen && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1.25rem", padding: "1rem", background: "var(--c-bg)", borderRadius: "var(--r-card-inner)" }}>
            <label className="admin-field">
              <span className="admin-field__label">Name</span>
              <input className="admin-input" value={newUserForm.name} onChange={e => setNewUserForm(f => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Email</span>
              <input type="email" className="admin-input" value={newUserForm.email} onChange={e => setNewUserForm(f => ({ ...f, email: e.target.value }))} />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Password (min 8 chars)</span>
              <input type="password" className="admin-input" value={newUserForm.password} onChange={e => setNewUserForm(f => ({ ...f, password: e.target.value }))} />
            </label>
            <div style={{ gridColumn: "1/-1" }}>
              <button className="admin-button admin-button--primary admin-button--compact" onClick={handleAddUser}>Add user</button>
            </div>
          </div>
        )}

        <table className="emp-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Created</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adminUsers.map(user => {
              const isMe = user.id === adminUser?.id;
              return [
                <tr key={user.id} className="emp-table__row" style={{ opacity: user.active ? 1 : 0.5 }}>
                  <td>
                    <div className="emp-table__name-cell">
                      <div className="emp-table__avatar">{(user.name || "?")[0].toUpperCase()}</div>
                      <div className="emp-table__name-stack">
                        <span className="emp-table__name">{user.name}{isMe ? <span style={{ marginLeft: 6, fontSize: "0.7rem", background: "var(--c-jade-soft)", color: "var(--c-jade)", padding: "1px 6px", borderRadius: 50 }}>You</span> : null}</span>
                      </div>
                    </div>
                  </td>
                  <td className="emp-table__data">{user.email}</td>
                  <td><span className={`emp-status-badge ${user.active ? "emp-status-badge--active" : "emp-status-badge--inactive"}`}>{user.active ? "Active" : "Inactive"}</span></td>
                  <td className="emp-table__data">{user.created_at ? new Date(user.created_at).toLocaleDateString("en-CA", { timeZone: TZ }) : "Ã¢â‚¬â€"}</td>
                  <td className="emp-table__actions-cell" style={{ whiteSpace: "nowrap" }}>
                    {!isMe && (
                      <>
                        <button className="admin-employee-card-btn" style={{ marginRight: 4 }} onClick={() => { setResetingId(resetingId === user.id ? null : user.id); setResetPassword(""); }}>Reset pw</button>
                        {user.active
                          ? <button className="admin-employee-card-btn" onClick={() => handleDeactivate(user.id)}>Deactivate</button>
                          : <button className="admin-employee-card-btn" onClick={() => handleReactivate(user.id)}>Reactivate</button>}
                      </>
                    )}
                  </td>
                </tr>,
                resetingId === user.id ? (
                  <tr key={`reset-${user.id}`} className="emp-detail-row">
                    <td colSpan={5} className="emp-detail-cell">
                      <div style={{ padding: "0.75rem 1.5rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                        <input type="password" className="admin-input" placeholder="New password (min 8 chars)" value={resetPassword} onChange={e => setResetPassword(e.target.value)} style={{ maxWidth: 260 }} />
                        <button className="admin-button admin-button--primary admin-button--compact" onClick={() => handleResetPassword(user.id)}>Set password</button>
                        <button className="admin-button admin-button--secondary admin-button--compact" onClick={() => setResetingId(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                ) : null
              ];
            })}
          </tbody>
        </table>
      </div>

      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: "1rem" }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">Email Configuration</h2>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--c-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Sender</div>
            <div style={{ marginTop: 2, fontWeight: 500 }}>Sushi House Banff &lt;payroll@mail.sushihousebanff.ca&gt;</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {testEmailStatus && <span style={{ fontSize: "0.85rem", color: testEmailStatus.includes("Error") ? "var(--c-accent)" : "var(--c-jade)" }}>{testEmailStatus}</span>}
            <button className="admin-button admin-button--secondary admin-button--compact" onClick={handleTestEmail}>Send test email</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PayrollReviewView({ adminFetch, payrolls, adminUser }) {
  const [selectedPayrollId, setSelectedPayrollId] = useState("");
  const [items, setItems] = useState([]);
  const [chequeInputs, setChequeInputs] = useState({});
  const [confirmedCheques, setConfirmedCheques] = useState({});
  const [editingCheques, setEditingCheques] = useState({});
  const [selectedItems, setSelectedItems] = useState({});
  const [previewPayslip, setPreviewPayslip] = useState(null);
  const [previewItemId, setPreviewItemId] = useState(null);
  const previewItemIdRef = useRef(null);
  const [sending, setSending] = useState({});
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  // confirmModal: null | { mode: "bulk", toSend: [] } | { mode: "single", item: {} }
  const [confirmModal, setConfirmModal] = useState(null);

  const approvedPayrolls = useMemo(
    () => (payrolls || [])
      .filter(p => p.status === "approved")
      .sort((left, right) => {
        const rightDate = new Date(right.end_date || right.created_at || 0).getTime();
        const leftDate = new Date(left.end_date || left.created_at || 0).getTime();
        if (rightDate !== leftDate) return rightDate - leftDate;
        return Number(right.id || 0) - Number(left.id || 0);
      }),
    [payrolls],
  );
  const selectedPayroll = approvedPayrolls.find(p => String(p.id) === String(selectedPayrollId));

  useEffect(() => {
    if (approvedPayrolls.length === 0) {
      if (selectedPayrollId) setSelectedPayrollId("");
      return;
    }

    const currentStillExists = approvedPayrolls.some(
      (payroll) => String(payroll.id) === String(selectedPayrollId),
    );

    if (!selectedPayrollId || !currentStillExists) {
      setSelectedPayrollId(String(approvedPayrolls[0].id));
    }
  }, [approvedPayrolls, selectedPayrollId]);

  useEffect(() => {
    if (!selectedPayrollId) return;
    adminFetch(`/api/admin/payrolls/${selectedPayrollId}`).then(r => r.json()).then(data => {
      const payrollItems = data.items || data.payroll?.items || [];
      setItems(payrollItems);
      const initialCheques = {};
      const initialConfirmed = {};
      payrollItems.forEach(item => {
        initialCheques[item.id] = item.payment_reference || "";
        if (item.payment_reference) initialConfirmed[item.id] = true;
      });
      const initialSelected = {};
      payrollItems.forEach(item => {
        if (item.employee_email && item.send_status !== "sent") {
          initialSelected[item.id] = true;
        }
      });
      setChequeInputs(initialCheques);
      setConfirmedCheques(initialConfirmed);
      setSelectedItems(initialSelected);
    });
  }, [selectedPayrollId, adminFetch]);

  const handleSaveAll = async () => {
    try {
      const itemsToSave = items.map(item => ({
        id: item.id,
        payment_reference: chequeInputs[item.id] || "",
        send_status: item.send_status === "sent"
          ? "sent"
          : chequeInputs[item.id] ? "ready" : "pending",
      }));
      const r = await adminFetch(`/api/admin/payrolls/${selectedPayrollId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: itemsToSave }),
      });
      if (r.ok) {
        const newConfirmed = {};
        itemsToSave.forEach(i => { if (i.payment_reference) newConfirmed[i.id] = true; });
        setConfirmedCheques(newConfirmed);
        setItems(prev => prev.map(i => {
          const saved = itemsToSave.find(s => s.id === i.id);
          if (!saved) return i;
          return {
            ...i,
            payment_reference: saved.payment_reference,
            send_status: i.send_status === "sent" ? "sent" : saved.send_status,
          };
        }));
        setFeedback("Saved successfully.");
        setTimeout(() => setFeedback(""), 3000);
      } else {
        const d = await r.json();
        setError(d.error || "Save failed.");
      }
    } catch (e) { setError(e.message); }
  };

  const executeSend = async (toSend) => {
    setConfirmModal(null);
    for (const item of toSend) {
      setSending(s => ({ ...s, [item.id]: true }));
      try {
        const r = await adminFetch(`/api/admin/payrolls/${selectedPayrollId}/items/${item.id}/send`, { method: "POST" });
        if (r.ok) {
          setItems(prev => prev.map(i => i.id === item.id ? { ...i, send_status: "sent" } : i));
        } else {
          const d = await r.json();
          setError(d.error || "Send failed.");
        }
      } catch (e) { setError(e.message); }
      setSending(s => ({ ...s, [item.id]: false }));
    }
    setFeedback("Emails sent.");
    setTimeout(() => setFeedback(""), 3000);
  };

  const handleSaveCheque = async (itemId, chequeVal) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    try {
      const r = await adminFetch(`/api/admin/payrolls/${selectedPayrollId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            id: itemId,
            payment_reference: chequeVal,
            send_status: item.send_status === "sent" ? "sent" : chequeVal ? "ready" : "pending",
          }],
        }),
      });
      if (r.ok) {
        setConfirmedCheques(s => ({ ...s, [itemId]: true }));
        setEditingCheques(s => ({ ...s, [itemId]: false }));
        setItems(prev => prev.map(i => i.id === itemId
          ? {
              ...i,
              payment_reference: chequeVal,
              send_status: i.send_status === "sent" ? "sent" : chequeVal ? "ready" : "pending",
            }
          : i
        ));
        // If preview is open for this item, update payment_reference in place
        if (previewItemIdRef.current === itemId) {
          setPreviewPayslip(prev => prev ? {
            ...prev,
            header: {
              ...prev.header,
              payment_reference: chequeVal,
              cheque_no: chequeVal,
            },
          } : prev);
        }
      } else {
        const d = await r.json();
        setError(d.error || "Failed to save cheque number.");
      }
    } catch (e) { setError(e.message); }
  };

  const handleSendSelected = () => {
    const toSend = items.filter(item => selectedItems[item.id] && item.employee_email);
    if (toSend.length === 0) { setError("No employees selected or no emails registered."); return; }
    setConfirmModal({ mode: "bulk", toSend });
  };

  const handleViewPayslip = async (itemId) => {
    if (previewItemIdRef.current === itemId) {
      setPreviewPayslip(null); setPreviewItemId(null); previewItemIdRef.current = null; return;
    }
    try {
      const r = await adminFetch(`/api/admin/payrolls/${selectedPayrollId}/items/${itemId}/payslip`);
      if (r.ok) {
        const data = await r.json();
        setPreviewPayslip(data);
        setPreviewItemId(itemId);
        previewItemIdRef.current = itemId;
      }
    } catch (_) {}
  };

  const handleExportReview = async () => {
    if (!selectedPayrollId) return;
    try {
      const response = await adminFetch(`/api/admin/payrolls/${selectedPayrollId}/export`);
      if (!response.ok) throw new Error("Failed to export payroll.");
      const workbookBlob = await response.blob();
      const objectUrl = window.URL.createObjectURL(workbookBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `payroll-${selectedPayrollId}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (exportError) {
      setError(exportError.message || "Failed to export payroll.");
    }
  };

  const sentCount = items.filter(i => i.send_status === "sent").length;
  const selectedCount = Object.values(selectedItems).filter(Boolean).length;
  const allSelected = items.length > 0 && items.every(i => selectedItems[i.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {feedback && <div className="admin-alert admin-alert--success">{feedback}</div>}
      {error && <div className="admin-alert admin-alert--error">{error}</div>}

      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: items.length > 0 ? "1.25rem" : 0 }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">Payroll Review &amp; Send</h2>
            {selectedPayroll && (
              <span className="admin-team-header__count">
                {selectedPayroll.start_date} to {selectedPayroll.end_date} - {items.length} employee{items.length !== 1 ? "s" : ""} - {sentCount} sent
              </span>
            )}
          </div>
          <div className="admin-team-toolbar__right">
            <select className="admin-select" value={selectedPayrollId} onChange={e => setSelectedPayrollId(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Ã¢â‚¬â€ Select payroll period Ã¢â‚¬â€</option>
              {approvedPayrolls.map(p => (
                <option key={p.id} value={p.id}>{p.start_date} to {p.end_date}</option>
              ))}
            </select>
            {items.length > 0 && (
              <>
                <button className="admin-button admin-button--secondary admin-button--compact" onClick={handleExportReview}>Export Excel</button>
                <button className="admin-button admin-button--secondary admin-button--compact" onClick={handleSaveAll}>Save all</button>
                <button className="admin-button admin-button--primary admin-button--compact" onClick={handleSendSelected} disabled={selectedCount === 0}>
                  Send selected ({selectedCount})
                </button>
              </>
            )}
          </div>
        </div>

        {items.length > 0 && (
          <div className="emp-table-wrap">
            <table className="emp-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={allSelected} onChange={e => {
                      const next = {};
                      items.forEach(i => { if (i.employee_email) next[i.id] = e.target.checked; });
                      setSelectedItems(next);
                    }} />
                  </th>
                  <th>Employee</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  <th style={{ textAlign: "right" }}>Gross</th>
                  <th style={{ textAlign: "right" }}>Net pay</th>
                  <th>Cheque No.</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const hasEmail = !!item.employee_email;
                  const chequeVal = chequeInputs[item.id] || "";
                  const isConfirmed = confirmedCheques[item.id];
                  const isEditing = editingCheques[item.id];
                  const statusBadge = {
                    sent: <span className="cr-type-badge cr-type-badge--in">Sent</span>,
                    ready: <span className="cr-type-badge cr-type-badge--manual">Ready</span>,
                    pending: <span style={{ fontSize: "0.75rem", color: "var(--c-text-muted)" }}>Pending</span>,
                  }[item.send_status] || null;
                  const rateLabel = item.pay_type === "salaried"
                    ? "Monthly Salary"
                    : item.hourly_rate != null
                      ? `$${Number(item.hourly_rate || 0).toFixed(2)}/hr`
                      : "";

                  return [
                    <tr key={item.id} className="emp-table__row" style={{ opacity: hasEmail ? 1 : 0.6 }}>
                      <td>
                        <input type="checkbox" checked={!!selectedItems[item.id]} disabled={!hasEmail}
                          onChange={e => setSelectedItems(s => ({ ...s, [item.id]: e.target.checked }))} />
                      </td>
                      <td>
                        <div className="emp-table__name-cell">
                          <div className="emp-table__avatar">{(item.employee_name || "?")[0].toUpperCase()}</div>
                          <div className="emp-table__name-stack">
                            <span className="emp-table__name">{item.employee_name}</span>
                            <span className="emp-table__email" style={{ fontStyle: hasEmail ? "normal" : "italic" }}>
                              {item.employee_email || "No email registered"}
                            </span>
                            {rateLabel ? <span className="emp-table__email">{rateLabel}</span> : null}
                          </div>
                        </div>
                      </td>
                      <td className="emp-table__data" style={{ textAlign: "right" }}>
                        {item.pay_type === "salaried" ? "Monthly Salary" : Number(item.total_hours || 0).toFixed(2)}
                      </td>
                      <td className="emp-table__data" style={{ textAlign: "right" }}>${Number(item.gross_pay || 0).toFixed(2)}</td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "var(--c-text-primary)" }}>${Number(item.net_pay || 0).toFixed(2)}</td>
                      <td>
                        {isConfirmed && !isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--c-jade)" }}>No. {chequeVal}</span>
                            <button
                              title="Edit cheque number"
                              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "var(--c-text-muted)", display: "flex", alignItems: "center" }}
                              onClick={() => setEditingCheques(s => ({ ...s, [item.id]: true }))}
                            >
                              <Pencil size={13} strokeWidth={1.8} />
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <input
                              className="admin-input"
                              style={{ width: 86, padding: "0.3rem 0.5rem", fontSize: "0.82rem" }}
                              placeholder="No."
                              value={chequeVal}
                              onChange={e => setChequeInputs(s => ({ ...s, [item.id]: e.target.value }))}
                              onKeyDown={e => {
                                if (e.key === "Enter" && chequeVal) handleSaveCheque(item.id, chequeVal);
                              }}
                            />
                            <button className="cr-action-btn" onClick={() => {
                              if (chequeVal) handleSaveCheque(item.id, chequeVal);
                            }}>OK</button>
                          </div>
                        )}
                      </td>
                      <td>{statusBadge}</td>
                      <td className="emp-table__actions-cell">
                        <button className="admin-employee-card-btn" onClick={() => handleViewPayslip(item.id)}>Preview</button>
                        {hasEmail && item.send_status !== "sent" && (
                          <button className="admin-employee-card-btn" style={{ marginLeft: 4 }} disabled={!!sending[item.id]}
                            onClick={() => setConfirmModal({ mode: "single", toSend: [item] })}>
                            {sending[item.id] ? "..." : "Send"}
                          </button>
                        )}
                      </td>
                    </tr>,
                    previewPayslip && previewItemId === item.id ? (
                      <tr key={`preview-${item.id}`} className="emp-detail-row">
                        <td colSpan={8} className="emp-detail-cell">
                          <div className="admin-employee-inline-detail">
                            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
                              <button className="admin-employee-card-btn admin-employee-card-btn--close" onClick={() => { setPreviewPayslip(null); setPreviewItemId(null); previewItemIdRef.current = null; }}>Close preview</button>
                            </div>
                            {typeof buildPayslipPrintHtml === "function" && (
                              <div dangerouslySetInnerHTML={{ __html: buildPayslipPrintHtml(previewPayslip) }} />
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}

        {!selectedPayrollId && (
          <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--c-text-muted)" }}>
            Select an approved payroll period above to review and send payslips.
          </div>
        )}
      </div>

      {confirmModal && (
        <div className="admin-modal-overlay" onClick={() => setConfirmModal(null)}>
          <div className="admin-modal" onClick={e => e.stopPropagation()}>
            <h3 className="admin-modal__title">Confirm send</h3>
            <p className="admin-modal__subtitle">
              {confirmModal.toSend.length === 1
                ? "The following payslip will be emailed:"
                : `${confirmModal.toSend.length} payslips will be emailed:`}
            </p>
            <div className="admin-modal__list">
              {confirmModal.toSend.map(item => {
                const cheque = chequeInputs[item.id] || item.payment_reference || "";
                const missingCheque = !cheque;
                return (
                  <div key={item.id} className="admin-modal__list-item">
                    <div className="admin-modal__list-name">{item.employee_name}</div>
                    <div className="admin-modal__list-detail">{item.employee_email}</div>
                    {selectedPayroll && (
                      <div className="admin-modal__list-detail">{selectedPayroll.start_date} to {selectedPayroll.end_date}</div>
                    )}
                    {missingCheque
                      ? <div className="admin-modal__list-warn">Cheque number missing Ã¢â‚¬â€ send anyway?</div>
                      : <div className="admin-modal__list-detail">Cheque No. {cheque}</div>
                    }
                  </div>
                );
              })}
            </div>
            <div className="admin-modal__actions">
              <button className="admin-button admin-button--secondary admin-button--compact" onClick={() => setConfirmModal(null)}>Cancel</button>
              <button className="admin-button admin-button--primary admin-button--compact" onClick={() => executeSend(confirmModal.toSend)}>Send</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessagesView({ adminFetch, employees }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [bccSelf, setBccSelf] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [sentHistory, setSentHistory] = useState([]);

  const employeesWithEmail = (employees || []).filter(e => e.email && e.active !== 0);
  const allSelected = employeesWithEmail.length > 0 && employeesWithEmail.every(e => selectedIds.includes(e.id));

  useEffect(() => {
    try {
      const savedDraft = JSON.parse(window.localStorage.getItem("admin-message-draft") || "null");
      if (savedDraft) {
        setSubject(savedDraft.subject || "");
        setBody(savedDraft.body || "");
        setBccSelf(savedDraft.bccSelf !== false);
      }
    } catch (_) {}
  }, []);

  const toggleAll = () => {
    if (allSelected) setSelectedIds([]);
    else setSelectedIds(employeesWithEmail.map(e => e.id));
  };

  const toggleOne = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSend = async () => {
    if (!selectedIds.length) return setError("Select at least one recipient.");
    if (!subject.trim()) return setError("Subject is required.");
    if (!body.trim()) return setError("Message body is required.");
    setSending(true);
    setError("");
    setResult(null);
    try {
      const r = await adminFetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientIds: selectedIds, subject, body, bccSelf }),
      });
      const data = await r.json();
      if (!r.ok) setError(data.error || "Send failed.");
      else {
        setResult(data);
        setSentHistory((current) => [
          {
            id: Date.now(),
            subject,
            recipients: selectedIds.length,
            sent: data.sent,
            failed: data.failed,
            sentAt: new Date().toISOString(),
          },
          ...current,
        ]);
        window.localStorage.removeItem("admin-message-draft");
        setSubject("");
        setBody("");
        setSelectedIds([]);
      }
    } catch (e) { setError(e.message); }
    setSending(false);
  };

  const handleSaveDraft = () => {
    window.localStorage.setItem(
      "admin-message-draft",
      JSON.stringify({ subject, body, bccSelf, updatedAt: new Date().toISOString() }),
    );
    setDraftStatus("Draft saved.");
    setTimeout(() => setDraftStatus(""), 3000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {error && <div className="admin-alert admin-alert--error">{error}</div>}
      {draftStatus && <div className="admin-alert admin-alert--success">{draftStatus}</div>}
      {result && (
        <div className="admin-alert admin-alert--success">
          Sent to {result.sent} employee{result.sent !== 1 ? "s" : ""}{result.failed > 0 ? ` Ã‚Â· ${result.failed} failed` : ""}.
        </div>
      )}

      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: "1.25rem" }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">New Message</h2>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1.5rem", alignItems: "start" }}>
          {/* Recipients */}
          <div>
            <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-text-muted)", marginBottom: "0.6rem" }}>
              Recipients
            </div>
            <div className="cr-emp-chips">
              <div
                className={`cr-emp-chip ${allSelected ? "cr-emp-chip--active" : ""}`}
                onClick={toggleAll}
              >
                <input type="checkbox" readOnly checked={allSelected} style={{ pointerEvents: "none" }} />
                <span className="cr-emp-chip__name">Select all ({employeesWithEmail.length})</span>
              </div>
              {employeesWithEmail.map(e => (
                <div
                  key={e.id}
                  className={`cr-emp-chip ${selectedIds.includes(e.id) ? "cr-emp-chip--active" : ""}`}
                  onClick={() => toggleOne(e.id)}
                >
                  <input type="checkbox" readOnly checked={selectedIds.includes(e.id)} style={{ pointerEvents: "none" }} />
                  <div>
                    <div className="cr-emp-chip__name">{e.name}</div>
                    <div className="cr-emp-chip__hours">{e.email}</div>
                  </div>
                </div>
              ))}
              {employeesWithEmail.length === 0 && (
                <div style={{ padding: "0.75rem", fontSize: "0.8rem", color: "var(--c-text-muted)", textAlign: "center" }}>
                  No employees with email registered.
                </div>
              )}
            </div>
          </div>

          {/* Message */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <label className="admin-field">
              <span className="admin-field__label">Subject</span>
              <input className="admin-input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Schedule update for next week" />
            </label>

            <label className="admin-field">
              <span className="admin-field__label">Message</span>
              <textarea className="admin-input admin-textarea" rows={8} value={body} onChange={e => setBody(e.target.value)} placeholder="Write your message here..." />
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input type="checkbox" checked={bccSelf} onChange={e => setBccSelf(e.target.checked)} />
              <span style={{ fontSize: "0.85rem", color: "var(--c-text-secondary)" }}>BCC me on this message</span>
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                className="admin-button admin-button--secondary"
                onClick={handleSaveDraft}
                disabled={!subject.trim() && !body.trim()}
              >
                Save draft
              </button>
              <button
                className="admin-button admin-button--primary"
                onClick={handleSend}
                disabled={sending || selectedIds.length === 0}
              >
                {sending ? "Sending..." : `Send to ${selectedIds.length} recipient${selectedIds.length !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="admin-panel">
        <div className="admin-team-toolbar" style={{ marginBottom: "1rem" }}>
          <div className="admin-team-toolbar__left">
            <h2 className="admin-panel__title">Sent History</h2>
          </div>
        </div>
        {sentHistory.length === 0 ? (
          <div className="admin-empty-state">No messages sent in this session.</div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-data-table">
              <thead>
                <tr className="admin-data-table__header-row">
                  <th>When</th>
                  <th>Subject</th>
                  <th>Recipients</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sentHistory.map((message) => (
                  <tr key={message.id}>
                    <td>{formatDateTime(message.sentAt)}</td>
                    <td>{message.subject}</td>
                    <td>{message.recipients}</td>
                    <td>{message.sent} sent{message.failed ? `, ${message.failed} failed` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AdminView() {
  const [adminToken, setAdminToken] = useState(getStoredAdminToken());
  const [authStatus, setAuthStatus] = useState("checking");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [adminUser, setAdminUser] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [adminEmployees, setAdminEmployees] = useState([]);
  const [recordsResponse, setRecordsResponse] = useState({
    items: [],
    total: 0,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    totalPages: 0,
  });
  const [summary, setSummary] = useState(initialSummaryState);
  const [adminConfig, setAdminConfig] = useState(null);
  const [filters, setFilters] = useState({ employeeId: "", start: "", end: "", recordStatus: "active" });
  const [openOnly, setOpenOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [formMode, setFormMode] = useState("create");
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [formState, setFormState] = useState(initialFormState);
  const [manualHoursMode, setManualHoursMode] = useState("create");
  const [editingManualHoursId, setEditingManualHoursId] = useState(null);
  const [manualHoursForm, setManualHoursForm] = useState(initialManualHoursFormState);
  const [isHolidayHoursOpen, setIsHolidayHoursOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [payrollPeriods, setPayrollPeriods] = useState([]);
  const [selectedPayroll, setSelectedPayroll] = useState(null);
  const [isGeneratingPayroll, setIsGeneratingPayroll] = useState(false);
  const [showPayrollRules, setShowPayrollRules] = useState(false);
  const [payrollConfig, setPayrollConfig] = useState(null);
  const [payrollHolidayInputs, setPayrollHolidayInputs] = useState({});
  const [salariedBonusInputs, setSalariedBonusInputs] = useState({});
  const [showClockForm, setShowClockForm] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [employeeSearchQuery, setEmployeeSearchQuery] = useState("");
  const [payrollForm, setPayrollForm] = useState({
    startDate: "",
    endDate: "",
    payDate: "",
    wageRateLabel: "Hourly rate",
    chequeNumberPrefix: "",
    hourlyRate: "",
    payFrequency: "",
  });
  const [employeeSettingsDrafts, setEmployeeSettingsDrafts] = useState({});
  const [employeeCreateForm, setEmployeeCreateForm] = useState(initialEmployeeFormState);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(null);
  const [isEmployeeCreateOpen, setIsEmployeeCreateOpen] = useState(false);
  const [employeeAuditResponse, setEmployeeAuditResponse] = useState(initialAuditResponse);
  const [selectedEmployeeAuditId, setSelectedEmployeeAuditId] = useState("");
  const [employeeAuditFilters, setEmployeeAuditFilters] = useState({ action: "", start: "", end: "", page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [timeRecordAuditResponse, setTimeRecordAuditResponse] = useState(initialAuditResponse);
  const [selectedTimeRecordAuditId, setSelectedTimeRecordAuditId] = useState("");
  const [timeRecordAuditFilters, setTimeRecordAuditFilters] = useState({ employeeId: "", action: "", start: "", end: "", page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [payrollAuditResponse, setPayrollAuditResponse] = useState(initialAuditResponse);
  const [selectedPayrollAuditId, setSelectedPayrollAuditId] = useState("");
  const [payrollAuditFilters, setPayrollAuditFilters] = useState({ employeeId: "", action: "", start: "", end: "", page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [activeSection, setActiveSection] = useState("employees");
  const [activeAuditSection, setActiveAuditSection] = useState("time_record");
  const [clockStats, setClockStats] = useState({ currentlyWorking: 0, allOpen: 0, lastEvent: null });
  const [liveTime, setLiveTime] = useState(new Date());
  const [selectedPayslip, setSelectedPayslip] = useState(null);
  const [isPayslipLoading, setIsPayslipLoading] = useState(false);
  const [expandedPayrollItemId, setExpandedPayrollItemId] = useState(null);

  useEffect(() => {
    document.body.classList.add("admin-bg");
    return () => document.body.classList.remove("admin-bg");
  }, []);

  const adminFetch = useCallback(
    async (url, options = {}) => {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (response.status === 401) {
        clearStoredAdminToken();
        setAdminToken("");
        setAuthStatus("unauthenticated");
        throw new Error("Your admin session has expired. Please sign in again.");
      }

      return response;
    },
    [adminToken],
  );

  useEffect(() => {
    if (!adminToken) {
      setAuthStatus("unauthenticated");
      return;
    }

    async function validateSession() {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/session`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });

        if (!response.ok) {
          throw new Error("Invalid session.");
        }

        const sessionData = await response.json();
        if (sessionData.user) setAdminUser(sessionData.user);
        setAuthStatus("authenticated");
      } catch {
        clearStoredAdminToken();
        setAdminToken("");
        setAuthStatus("unauthenticated");
      }
    }

    validateSession();
  }, [adminToken]);

  const loadAdminData = useCallback(async () => {
    if (!adminToken) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const effectiveFilters = openOnly ? { ...filters, open_only: true } : filters;
      const filterQuery = buildQueryString(effectiveFilters);
      const paginatedQuery = buildQueryString(effectiveFilters, { page, pageSize });
      const employeeAuditQuery = buildAuditQueryString(
        employeeAuditFilters,
        { page: employeeAuditFilters.page, pageSize: employeeAuditFilters.pageSize },
        { employeeId: selectedEmployeeAuditId },
      );
      const timeRecordAuditQuery = buildAuditQueryString(
        timeRecordAuditFilters,
        { page: timeRecordAuditFilters.page, pageSize: timeRecordAuditFilters.pageSize },
        { recordId: selectedTimeRecordAuditId },
      );
      const payrollAuditQuery = buildAuditQueryString(
        payrollAuditFilters,
        { page: payrollAuditFilters.page, pageSize: payrollAuditFilters.pageSize },
        { payrollId: selectedPayrollAuditId },
      );

      const [
        employeesResponse,
        adminEmployeesResponse,
        employeeAuditResult,
        timeRecordAuditResult,
        payrollAuditResult,
        configResponse,
        recordsResult,
        summaryResult,
        payrollsResult,
        payrollConfigResult,
      ] = await Promise.all([
        fetch(`${API_BASE_URL}/employees`),
        adminFetch(`${API_BASE_URL}/admin/employees`),
        adminFetch(`${API_BASE_URL}/admin/employees/audit${employeeAuditQuery}`),
        adminFetch(`${API_BASE_URL}/admin/time-records/audit${timeRecordAuditQuery}`),
        adminFetch(`${API_BASE_URL}/admin/payrolls/audit${payrollAuditQuery}`),
        adminFetch(`${API_BASE_URL}/admin/time-records/config`),
        adminFetch(`${API_BASE_URL}/admin/time-records${paginatedQuery}`),
        adminFetch(`${API_BASE_URL}/admin/time-summary${filterQuery}`),
        adminFetch(`${API_BASE_URL}/admin/payrolls`),
        adminFetch(`${API_BASE_URL}/admin/payrolls/config`),
      ]);

      const [
        employeesData,
        adminEmployeesData,
        employeeAuditData,
        timeRecordAuditData,
        payrollAuditData,
        configData,
        recordsData,
        summaryData,
        payrollsData,
        payrollConfigData,
      ] = await Promise.all([
        employeesResponse.json(),
        adminEmployeesResponse.json(),
        employeeAuditResult.json(),
        timeRecordAuditResult.json(),
        payrollAuditResult.json(),
        configResponse.json(),
        recordsResult.json(),
        summaryResult.json(),
        payrollsResult.json(),
        payrollConfigResult.json(),
      ]);

      if (!employeesResponse.ok) throw new Error(employeesData.error || "Failed to load employees.");
      if (!adminEmployeesResponse.ok) throw new Error(adminEmployeesData.error || "Failed to load employee settings.");
      if (!employeeAuditResult.ok) throw new Error(employeeAuditData.error || "Failed to load employee audit logs.");
      if (!timeRecordAuditResult.ok) throw new Error(timeRecordAuditData.error || "Failed to load time record audit logs.");
      if (!payrollAuditResult.ok) throw new Error(payrollAuditData.error || "Failed to load payroll audit logs.");
      if (!configResponse.ok) throw new Error(configData.error || "Failed to load configuration.");
      if (!recordsResult.ok) throw new Error(recordsData.error || "Failed to load history.");
      if (!summaryResult.ok) throw new Error(summaryData.error || "Failed to load summary.");
      if (!payrollsResult.ok) throw new Error(payrollsData.error || "Failed to load payrolls.");
      if (!payrollConfigResult.ok) throw new Error(payrollConfigData.error || "Failed to load payroll configuration.");

      setEmployees(employeesData);
      setAdminEmployees(adminEmployeesData);
      setEmployeeAuditResponse(employeeAuditData);
      setTimeRecordAuditResponse(timeRecordAuditData);
      setPayrollAuditResponse(payrollAuditData);
      setEmployeeSettingsDrafts(
        Object.fromEntries(
          adminEmployeesData.map((employee) => [
            employee.id,
            {
              defaultHourlyRate: employee.default_hourly_rate === null ? "" : String(employee.default_hourly_rate),
              defaultPayFrequency: employee.default_pay_frequency || "",
              startDate: employee.start_date || "",
              vacationPaySchedule: employee.vacation_pay_schedule || "monthly",
              accruedVacationBalance: Number(employee.accrued_vacation_balance || 0),
              name: employee.name,
              pin: "",
              active: Boolean(employee.active),
              pay_type: employee.pay_type || "hourly",
              annual_salary: employee.annual_salary != null ? String(employee.annual_salary) : "",
              vacation_pay_pct: employee.vacation_pay_pct != null ? employee.vacation_pay_pct : 4,
              phone: employee.phone ?? "",
              email: employee.email ?? "",
              sin: employee.sin ?? "",
              home_address: employee.home_address ?? "",
              hire_date: employee.hire_date ?? "",
              proserve_number: employee.proserve_number ?? "",
              proserve_expiry: employee.proserve_expiry ?? "",
              roe_last_day: employee.roe_last_day ?? "",
              roe_hours: employee.roe_hours ?? "",
              roe_wage: employee.roe_wage ?? "",
              benefits_note: employee.benefits_note ?? "",
            },
          ]),
        ),
      );
      setAdminConfig(configData);
      setRecordsResponse(recordsData);
      setSummary(summaryData);
      setPayrollPeriods(payrollsData);
      setPayrollConfig(payrollConfigData);
    } catch (loadError) {
      setError(loadError.message || "Failed to load admin data.");
    } finally {
      setIsLoading(false);
    }
  }, [
    adminFetch,
    adminToken,
    filters,
    page,
    pageSize,
    employeeAuditFilters,
    timeRecordAuditFilters,
    payrollAuditFilters,
    selectedEmployeeAuditId,
    selectedTimeRecordAuditId,
    selectedPayrollAuditId,
  ]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      loadAdminData();
    }
  }, [authStatus, loadAdminData]);

  // URL hash persistence
  useEffect(() => {
    const validSections = ["employees", "time-records", "payroll", "audit-logs", "payroll-review", "messages", "settings"];
    const hash = window.location.hash.replace("#", "");
    if (validSections.includes(hash)) setActiveSection(hash);
  }, []);

  useEffect(() => {
    window.location.hash = activeSection;
  }, [activeSection]);

  // Live clock
  useEffect(() => {
    const interval = setInterval(() => setLiveTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // Clock stats polling
  const loadClockStats = useCallback(async () => {
    try {
      const res = await adminFetch("/api/admin/clock-stats");
      if (res.ok) { const data = await res.json(); setClockStats(data); }
    } catch (_) {}
  }, [adminFetch]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    loadClockStats();
    const interval = setInterval(loadClockStats, 30000);
    return () => clearInterval(interval);
  }, [authStatus, loadClockStats]);

  const resetForm = () => {
    setFormMode("create");
    setEditingRecordId(null);
    setFormState(initialFormState);
  };

  const resetManualHoursForm = () => {
    setManualHoursMode("create");
    setEditingManualHoursId(null);
    setManualHoursForm(initialManualHoursFormState);
    setIsHolidayHoursOpen(false);
  };
  const handleLogin = async (event) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_BASE_URL}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginForm.email, password: loginForm.password }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to authenticate.");
      }

      setStoredAdminToken(data.token);
      setAdminToken(data.token);
      if (data.user) setAdminUser(data.user);
      setAuthStatus("authenticated");
      setFeedback("Signed in successfully.");
      setError("");
    } catch (loginError) {
      setError(loginError.message || "Failed to authenticate.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      if (adminToken) {
        await fetch(`${API_BASE_URL}/admin/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    } finally {
      clearStoredAdminToken();
      setAdminToken("");
      setAuthStatus("unauthenticated");
      setAdminConfig(null);
      setRecordsResponse(initialAuditResponse);
      setSummary(initialSummaryState);
    }
  };

  const handleBackToKiosk = () => {
    window.location.assign("/");
  };

  const handleEdit = (record) => {
    setFeedback("");
    setError("");

    if (record.entry_mode === "manual") {
      resetForm();
      setManualHoursMode("edit");
      setEditingManualHoursId(record.id);
      setIsHolidayHoursOpen(record.manual_category === "holiday");
      setManualHoursForm({
        employeeId: String(record.employee_id),
        workDate: toDateValue(record.recorded_at),
        regularHours:
          record.manual_category === "holiday" ? "" : String(record.worked_hours || ""),
        holidayLabel: record.holiday_label || "Family Day",
        holidayHours:
          record.manual_category === "holiday" ? String(record.worked_hours || "") : "",
        holidayMultiplier: String(record.holiday_multiplier || 1.5),
        note: record.note || "",
      });
    } else {
      resetManualHoursForm();
      setFormMode("edit");
      setEditingRecordId(record.id);
      setFormState({
        employeeId: String(record.employee_id),
        type: record.type,
        recordedAt: toDateTimeLocalValue(record.recorded_at),
        kioskId: record.kiosk_id || "",
      });
    }

    setActiveSection("time-records");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback("");
    setError("");

    try {
      const payload = {
        employee_id: Number(formState.employeeId),
        type: formState.type,
        recorded_at: toIsoString(formState.recordedAt),
        kiosk_id: formState.kioskId.trim() || null,
      };
      const endpoint = formMode === "edit"
        ? `${API_BASE_URL}/admin/time-records/${editingRecordId}`
        : `${API_BASE_URL}/admin/time-records`;
      const method = formMode === "edit" ? "PUT" : "POST";

      const response = await adminFetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Failed to save manual record.");

      setFeedback(formMode === "edit" ? "Record updated successfully." : "Record created successfully.");
      resetForm();
      await loadAdminData();
    } catch (submitError) {
      setError(submitError.message || "Failed to save manual record.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualHoursSubmit = async (event) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback("");
    setError("");

    try {
      const payload = {
        employee_id: Number(manualHoursForm.employeeId),
        work_date: manualHoursForm.workDate,
        regular_hours:
          manualHoursForm.regularHours === ""
            ? 0
            : Number(normalizeDecimalInput(manualHoursForm.regularHours)),
        holiday_label: manualHoursForm.holidayLabel.trim() || "Family Day",
        holiday_hours:
          manualHoursForm.holidayHours === ""
            ? 0
            : Number(normalizeDecimalInput(manualHoursForm.holidayHours)),
        holiday_multiplier:
          manualHoursForm.holidayMultiplier === ""
            ? 1.5
            : Number(normalizeDecimalInput(manualHoursForm.holidayMultiplier)),
        note: manualHoursForm.note.trim() || null,
      };
      const endpoint = manualHoursMode === "edit"
        ? `${API_BASE_URL}/admin/manual-hours/${editingManualHoursId}`
        : `${API_BASE_URL}/admin/manual-hours`;
      const method = manualHoursMode === "edit" ? "PUT" : "POST";

      if (manualHoursMode === "edit") {
        payload.worked_hours = payload.holiday_hours > 0
          ? payload.holiday_hours
          : payload.regular_hours;
        payload.manual_category = payload.holiday_hours > 0 ? "holiday" : "regular";
      }

      const response = await adminFetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || "Failed to save manual hours.");
      }

      setFeedback(
        manualHoursMode === "edit"
          ? "Manual hours updated successfully."
          : "Manual hours added successfully.",
      );
      resetManualHoursForm();
      await loadAdminData();
    } catch (submitError) {
      setError(submitError.message || "Failed to save manual hours.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (record) => {
    const deleteLabel = record.entry_mode === "manual"
      ? `Delete the manual entry for ${record.employee_name} on ${toDateValue(record.recorded_at)}?`
      : `Delete the record for ${record.employee_name} at ${formatDateTime(record.recorded_at)}?`;
    const confirmed = window.confirm(deleteLabel);
    if (!confirmed) return;

    setFeedback("");
    setError("");

    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/time-records/${record.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to delete record.");
      setFeedback("Record marked as deleted successfully.");
      await loadAdminData();
    } catch (deleteError) {
      setError(deleteError.message || "Failed to delete record.");
    }
  };

  const handleRestore = async (record) => {
    setFeedback("");
    setError("");

    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/time-records/${record.id}/restore`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to restore record.");
      setFeedback("Record restored successfully.");
      await loadAdminData();
    } catch (restoreError) {
      setError(restoreError.message || "Failed to restore record.");
    }
  };

  const handleExport = async () => {
    setError("");
    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/time-records/export${buildQueryString(openOnly ? { ...filters, open_only: true } : filters)}`);
      if (!response.ok) throw new Error("Failed to export CSV.");
      const csvBlob = await response.blob();
      const objectUrl = window.URL.createObjectURL(csvBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "time-records.csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (exportError) {
      setError(exportError.message || "Failed to export CSV.");
    }
  };

  const handleGeneratePayroll = async (event) => {
    event.preventDefault();
    setError("");
    setFeedback("");
    setIsGeneratingPayroll(true);

    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: payrollForm.startDate,
          end_date: payrollForm.endDate,
          pay_date: payrollForm.payDate || payrollForm.endDate,
          wage_rate_label: payrollForm.wageRateLabel,
          cheque_number_prefix: payrollForm.chequeNumberPrefix,
          pay_frequency: payrollForm.payFrequency,
          hourly_rate:
            payrollForm.hourlyRate === "" ? null : Number(payrollForm.hourlyRate),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to generate payroll.");
      setFeedback("Payroll generated successfully.");
      setSelectedPayroll(data);
      setExpandedPayrollItemId(null);
      setPayrollHolidayInputs(buildHolidayInputState(data.items || []));
      await loadAdminData();
    } catch (generateError) {
      setError(generateError.message || "Failed to generate payroll.");
    } finally {
      setIsGeneratingPayroll(false);
    }
  };

  const handleSelectPayroll = async (payrollId) => {
    if (selectedPayroll?.id === payrollId) { setSelectedPayroll(null); return; }
    setError("");
    setSelectedPayslip(null);
    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load payroll.");
      setSelectedPayroll(data);
      setExpandedPayrollItemId(null);
      setPayrollHolidayInputs(buildHolidayInputState(data.items || []));
    } catch (loadError) {
      setError(loadError.message || "Failed to load payroll.");
    }
  };

  const handleApprovePayroll = async (payrollId) => {
    setError("");
    setFeedback("");
    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}/approve`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to approve payroll.");
      setFeedback("Payroll approved successfully.");
      setSelectedPayroll(data);
      setExpandedPayrollItemId(null);
      setPayrollHolidayInputs(buildHolidayInputState(data.items || []));
      await loadAdminData();
    } catch (approveError) {
      setError(approveError.message || "Failed to approve payroll.");
    }
  };

  const handleRecalculatePayroll = async (payroll) => {
    const isApproved = payroll.status === "approved";
    const confirmationMessage = isApproved
      ? "This payroll is approved. Recalculate it anyway and replace the stored values using the new overtime rule?"
      : "Recalculate this draft payroll using the new overtime rule?";
    const confirmed = window.confirm(confirmationMessage);

    if (!confirmed) {
      return;
    }

    setError("");
    setFeedback("");

    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payroll.id}/recalculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allow_approved: isApproved,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to recalculate payroll.");
      }
      setFeedback(
        isApproved
          ? "Approved payroll recalculated successfully."
          : "Draft payroll recalculated successfully.",
      );
      setSelectedPayroll(data);
      setPayrollHolidayInputs(buildHolidayInputState(data.items || []));
      await loadAdminData();
    } catch (recalculateError) {
      setError(recalculateError.message || "Failed to recalculate payroll.");
    }
  };

  const handleHolidayPaySave = async (payrollId, itemId) => {
    setError("");
    setFeedback("");
    try {
      const holidayDraft = payrollHolidayInputs[itemId] || {
        amount: "0",
        label: "Holiday Pay",
      };
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}/items/${itemId}/holiday`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holiday_pay: Number(holidayDraft.amount || 0),
          holiday_label: holidayDraft.label || "Holiday Pay",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to update holiday pay.");
      setFeedback("Holiday pay updated successfully.");
      setSelectedPayroll(data);
      setPayrollHolidayInputs(buildHolidayInputState(data.items || []));
      await loadAdminData();
    } catch (holidayError) {
      setError(holidayError.message || "Failed to update holiday pay.");
    }
  };

  const handleSalariedBonusSave = async (payrollId, itemId) => {
    setError("");
    setFeedback("");
    try {
      const bonus = Number(salariedBonusInputs[itemId] ?? 0);
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}/items/${itemId}/salary-bonus`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bonus }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to update bonus.");
      setFeedback("Bonus updated successfully.");
      setSelectedPayroll(data);
      await loadAdminData();
    } catch (bonusError) {
      setError(bonusError.message || "Failed to update bonus.");
    }
  };

  const handleExportPayroll = async (payrollId) => {
    setError("");
    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}/export`);
      if (!response.ok) throw new Error("Failed to export payroll.");
      const workbookBlob = await response.blob();
      const objectUrl = window.URL.createObjectURL(workbookBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `payroll-${payrollId}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (exportError) {
      setError(exportError.message || "Failed to export payroll.");
    }
  };
  const handleExportAudit = async (entityType) => {
    setError("");
    try {
      let url = "";
      if (entityType === "employee") {
        url = `${API_BASE_URL}/admin/employees/audit/export${buildAuditQueryString(employeeAuditFilters, {}, { employeeId: selectedEmployeeAuditId })}`;
      } else if (entityType === "time_record") {
        url = `${API_BASE_URL}/admin/time-records/audit/export${buildAuditQueryString(timeRecordAuditFilters, {}, { recordId: selectedTimeRecordAuditId })}`;
      } else {
        url = `${API_BASE_URL}/admin/payrolls/audit/export${buildAuditQueryString(payrollAuditFilters, {}, { payrollId: selectedPayrollAuditId })}`;
      }

      const response = await adminFetch(url);
      if (!response.ok) throw new Error("Failed to export audit logs.");
      const csvBlob = await response.blob();
      const objectUrl = window.URL.createObjectURL(csvBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${entityType}-audit.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (exportError) {
      setError(exportError.message || "Failed to export audit logs.");
    }
  };

  const handleViewPayslip = async (payrollId, itemId) => {
    setError("");
    setIsPayslipLoading(true);

    try {
      const response = await adminFetch(
        `${API_BASE_URL}/admin/payrolls/${payrollId}/items/${itemId}/payslip`,
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to load payslip.");
      }

      setSelectedPayslip(data);
    } catch (payslipError) {
      setError(payslipError.message || "Failed to load payslip.");
    } finally {
      setIsPayslipLoading(false);
    }
  };

  const handlePrintPayslip = () => {
    if (!selectedPayslip) {
      return;
    }

    const printWindow = window.open("", "_blank", "width=980,height=780");

    if (!printWindow) {
      setError("Unable to open the print window.");
      return;
    }

    printWindow.document.open();
    printWindow.document.write(buildPayslipPrintHtml(selectedPayslip));
    printWindow.document.close();
  };

  const handlePrintTeamPayroll = () => {
    if (!selectedPayroll) {
      return;
    }

    const printWindow = window.open("", "_blank", "width=1200,height=900");

    if (!printWindow) {
      setError("Unable to open the print window.");
      return;
    }

    printWindow.document.open();
    printWindow.document.write(buildTeamPayrollPrintHtml(selectedPayroll));
    printWindow.document.close();
  };

  const handleSaveEmployeeSettings = async (employeeId) => {
    setError("");
    setFeedback("");
    try {
      const draft = employeeSettingsDrafts[employeeId] || {};
      const isSalariedDraft = draft.pay_type === "salaried";

      if (!isSalariedDraft && (draft.defaultHourlyRate === "" || Number(draft.defaultHourlyRate) <= 0)) {
        throw new Error("Hourly rate is required and must be greater than zero.");
      }

      if (!isSalariedDraft && !draft.defaultPayFrequency) {
        throw new Error("Pay frequency is required.");
      }

      const response = await adminFetch(`${API_BASE_URL}/admin/employees/${employeeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          ...(draft.pin?.trim() ? { pin: draft.pin.trim() } : {}),
          active: draft.active,
          default_hourly_rate: isSalariedDraft ? null : draft.defaultHourlyRate,
          default_pay_frequency: isSalariedDraft ? null : draft.defaultPayFrequency,
          start_date: draft.startDate,
          vacation_pay_schedule: draft.vacationPaySchedule,
          pay_type: draft.pay_type || "hourly",
          annual_salary: isSalariedDraft ? (draft.annual_salary ? Number(draft.annual_salary) : null) : null,
          vacation_pay_pct: isSalariedDraft ? getVacationPayPercentForStartDate(draft.startDate) : undefined,
          phone: draft.phone || null,
          email: draft.email || null,
          sin: draft.sin || null,
          home_address: draft.home_address || null,
          hire_date: draft.hire_date || null,
          proserve_number: draft.proserve_number || null,
          proserve_expiry: draft.proserve_expiry || null,
          roe_last_day: draft.roe_last_day || null,
          roe_hours: draft.roe_hours ? Number(draft.roe_hours) : null,
          roe_wage: draft.roe_wage ? Number(draft.roe_wage) : null,
          benefits_note: draft.benefits_note || null,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save employee settings.");
      setFeedback("Employee settings updated successfully.");
      await loadAdminData();
    } catch (saveError) {
      setError(saveError.message || "Failed to save employee settings.");
    }
  };

  const handleCreateEmployee = async (event) => {
    event.preventDefault();
    setError("");
    setFeedback("");
    try {
      const isSalariedCreate = employeeCreateForm.pay_type === "salaried";

      if (!isSalariedCreate && (employeeCreateForm.defaultHourlyRate === "" || Number(employeeCreateForm.defaultHourlyRate) <= 0)) {
        throw new Error("Hourly rate is required and must be greater than zero.");
      }

      if (!isSalariedCreate && !employeeCreateForm.defaultPayFrequency) {
        throw new Error("Pay frequency is required.");
      }

      const response = await adminFetch(`${API_BASE_URL}/admin/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: employeeCreateForm.name,
          pin: employeeCreateForm.pin,
          active: employeeCreateForm.active,
          default_hourly_rate: isSalariedCreate ? null : employeeCreateForm.defaultHourlyRate,
          default_pay_frequency: isSalariedCreate ? null : employeeCreateForm.defaultPayFrequency,
          start_date: employeeCreateForm.startDate,
          vacation_pay_schedule: employeeCreateForm.vacationPaySchedule,
          pay_type: employeeCreateForm.pay_type || "hourly",
          annual_salary: isSalariedCreate ? (employeeCreateForm.annual_salary ? Number(employeeCreateForm.annual_salary) : null) : null,
          vacation_pay_pct: getVacationPayPercentForStartDate(employeeCreateForm.startDate),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to create employee.");
      setEmployeeCreateForm(initialEmployeeFormState);
      setIsEmployeeCreateOpen(false);
      setFeedback("Employee created successfully.");
      await loadAdminData();
    } catch (createError) {
      setError(createError.message || "Failed to create employee.");
    }
  };

  const handleDeleteEmployee = async (employee) => {
    const dependencyMessage = employee.can_delete
      ? "This permanently deletes the employee profile. This cannot be undone."
      : "This employee already has time records or payroll history, so permanent deletion is blocked. Hide the employee instead.";

    const confirmed = window.confirm(
      `Delete ${employee.name} permanently?\n\n${dependencyMessage}`,
    );

    if (!confirmed) {
      return;
    }

    setError("");
    setFeedback("");

    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/employees/${employee.id}`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        if (data.dependencies) {
          throw new Error(
            `${data.error} Time records: ${data.dependencies.time_records_count}, payroll items: ${data.dependencies.payroll_items_count}, audit logs kept: ${data.dependencies.audit_logs_count}.`,
          );
        }

        throw new Error(data.error || "Failed to delete employee.");
      }

      setFeedback(`${employee.name} was deleted permanently.`);
      await loadAdminData();
    } catch (deleteError) {
      setError(deleteError.message || "Failed to delete employee.");
    }
  };

  const hasPreviousPage = page > 1;
  const hasNextPage = recordsResponse.totalPages > 0 && page < recordsResponse.totalPages;
  const selectedEmployeeSummary = filters.employeeId && summary.employees.length === 1 ? summary.employees[0] : null;
  const payrollHint = useMemo(() => `Payroll-ready base: ${summary.totals.payroll_ready_hours.toFixed(2)} closed hours in the current period.`, [summary.totals.payroll_ready_hours]);
  const employeeNamesById = useMemo(() => Object.fromEntries(adminEmployees.map((employee) => [employee.id, employee.name])), [adminEmployees]);
  const filteredAdminEmployees = useMemo(() => {
    const normalizedQuery = employeeSearch.trim().toLowerCase();

    if (!normalizedQuery) {
      return adminEmployees;
    }

    return adminEmployees.filter((employee) =>
      employee.name.toLowerCase().includes(normalizedQuery),
    );
  }, [adminEmployees, employeeSearch]);
  useEffect(() => {
    if (!filteredAdminEmployees.length) {
      setSelectedEmployeeId(null);
      return;
    }

    if (selectedEmployeeId !== null && !filteredAdminEmployees.some((employee) => employee.id === selectedEmployeeId)) {
      setSelectedEmployeeId(null);
    }
  }, [filteredAdminEmployees, selectedEmployeeId]);
  const sectionTabs = [
    { id: "employees", label: "Team", kicker: "People" },
    { id: "time-records", label: "Clock", kicker: "Time" },
    { id: "payroll", label: "Payroll", kicker: "Finance" },
    { id: "payroll-review", label: "Review & Send", kicker: "Payroll" },
    { id: "messages", label: "Messages", kicker: "Staff" },
    { id: "audit-logs", label: "Audit Log", kicker: "History" },
    { id: "settings", label: "Settings", kicker: "Config" },
  ];
  const auditTabs = [
    { id: "employee", label: "Employees", kicker: "Audit" },
    { id: "time_record", label: "Time Records", kicker: "Audit" },
    { id: "payroll", label: "Payroll", kicker: "Audit" },
  ];

  if (authStatus !== "authenticated") {
    return (
      <LoginView
        email={loginForm.email}
        password={loginForm.password}
        onEmailChange={(value) => setLoginForm((current) => ({ ...current, email: value }))}
        onPasswordChange={(value) => setLoginForm((current) => ({ ...current, password: value }))}
        onSubmit={handleLogin}
        error={error}
        isSubmitting={isSubmitting}
      />
    );
  }

  const tabIcons = {
    "employees":      <UsersRound size={20} strokeWidth={1.8} />,
    "time-records":   <Clock size={20} strokeWidth={1.8} />,
    "payroll":        <StickyNote size={20} strokeWidth={1.8} />,
    "payroll-review": <SendHorizontal size={20} strokeWidth={1.8} />,
    "messages":       <Mail size={20} strokeWidth={1.8} />,
    "audit-logs":     <History size={20} strokeWidth={1.8} />,
    "settings":       <Settings2 size={20} strokeWidth={1.8} />,
  };

  return (
    <div className="ds-shell">
      <div className="admin-blobs" aria-hidden="true">
        <div className="admin-blob admin-blob-1" />
        <div className="admin-blob admin-blob-2" />
        <div className="admin-blob admin-blob-3" />
        <div className="admin-blob admin-blob-4" />
        <div className="admin-blob admin-blob-5" />
      </div>
      <aside className="ds-sidebar">
        <button
          className="ds-sidebar__brand"
          onClick={handleBackToKiosk}
        >
          <img src="/logo.png" alt="" className="ds-sidebar__logo" />
          <div className="ds-sidebar__brand-name">Sushi House Banff</div>
        </button>
        <nav className="ds-sidebar__nav">
          {sectionTabs.map((tab) => (
            <button
              key={tab.id}
              className={`ds-nav-btn ${activeSection === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveSection(tab.id)}
            >
              <span className="ds-nav-btn__icon">{tabIcons[tab.id]}</span>
              <span className="ds-nav-btn__label">{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="ds-sidebar__footer">
          <a href="/" className="ds-sidebar__kiosk-link">
            <ArrowLeft size={14} strokeWidth={1.8} />
            <span>Kiosk</span>
          </a>
          <button onClick={handleLogout} className="ds-sidebar__logout">
            <LogOut size={14} strokeWidth={1.8} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main className="ds-main">
        {/* Welcome bar */}
        {(() => {
          const todayStr = liveTime.toLocaleDateString("en-CA", { timeZone: TZ });
          const currentPeriod = payrollPeriods.find(
            (p) => p.start_date <= todayStr && p.end_date >= todayStr
          ) || payrollPeriods[payrollPeriods.length - 1];
          const payPeriodLabel = currentPeriod
            ? new Date(currentPeriod.start_date + "T12:00:00").toLocaleDateString("en-CA", { month: "long", year: "numeric" }) + " pay period"
            : liveTime.toLocaleDateString("en-CA", { timeZone: TZ, month: "long", year: "numeric" }) + " pay period";
          return (
            <div className="ds-welcome-bar">
              <span className="ds-welcome-bar__greeting">
                Welcome, {adminUser?.name?.split(" ")[0] || "Admin"}
              </span>
              <span className="ds-welcome-bar__sep" />
              <span className="ds-welcome-bar__date">
                {liveTime.toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" })}
              </span>
              <span className="ds-welcome-bar__sep" />
              <span className="ds-welcome-bar__period">{payPeriodLabel}</span>
              <span className="ds-live-badge">
                <span className="ds-metric-live-dot" />
                Live
              </span>
              <span className="ds-welcome-bar__time">
                {liveTime.toLocaleTimeString("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })}
              </span>
            </div>
          );
        })()}

        {/* Metric strip - per section */}
        {(() => {
          if (activeSection === "payroll-review" || activeSection === "messages") {
            return null;
          }

          const activeCount = adminEmployees.filter(e => e.active).length;
          const totalHours = summary.totals.payroll_ready_hours || 0;
          const clockTotalHours = summary.totals.total_hours || 0;
          const totalRecords = summary.totals.total_records || 0;
          const proserveAlerts = adminEmployees.filter(e => {
            const s = proserveStatus(e.proserve_expiry);
            return s === "expired" || s === "expiring";
          }).length;

          if (activeSection === "time-records") {
            return (
              <div className="ds-metric-strip">
                <div
                  className="ds-metric-card ds-metric-card--primary ds-metric-card--clickable"
                  onClick={() => {
                    setActiveSection("time-records");
                    setOpenOnly(false);
                  }}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon"><span className="ds-metric-live-dot" /></div>
                    <span className="ds-metric-card__tag">live</span>
                  </div>
                  <div className="ds-metric-card__number">{clockStats.currentlyWorking}</div>
                  <div className="ds-metric-card__label">Currently working</div>
                  <UsersRound className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(255,255,255,0.07)" }} />
                </div>

                <div
                  className="ds-metric-card ds-metric-card--warm ds-metric-card--clickable"
                  onClick={() => {
                    setActiveSection("time-records");
                    setPage(1);
                    setOpenOnly(true);
                  }}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon">
                      {clockStats.allOpen > 0 ? <TriangleAlert size={16} strokeWidth={1.5} /> : <CheckCircle size={16} strokeWidth={1.5} />}
                    </div>
                    <span className="ds-metric-card__tag">{clockStats.allOpen > 0 ? "needs review" : "all matched"}</span>
                  </div>
                  <div className="ds-metric-card__number">{clockStats.allOpen}</div>
                  <div className="ds-metric-card__label">Missing clock out</div>
                  <TriangleAlert className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(122,88,0,0.20)" }} />
                </div>

                <div
                  className="ds-metric-card ds-metric-card--jade ds-metric-card--clickable"
                  onClick={() => {
                    setActiveSection("time-records");
                    setOpenOnly(false);
                  }}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon"><Timer size={16} strokeWidth={1.8} /></div>
                    <span className="ds-metric-card__tag">period</span>
                  </div>
                  <div className="ds-metric-card__number">{clockTotalHours.toFixed(1)}</div>
                  <div className="ds-metric-card__label">Total hours</div>
                  <Timer className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(74,64,64,0.20)" }} />
                </div>

                {(() => {
                  const now = new Date();
                  const day = Number(now.toLocaleDateString("en-CA", { timeZone: TZ, day: "numeric" }));
                  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
                  const monthLabel = now.toLocaleDateString("en-CA", { timeZone: TZ, month: "long", year: "numeric" });
                  const pct = Math.round((day / daysInMonth) * 100);
                  return (
                    <div className="ds-metric-card ds-metric-card--clickable" onClick={() => setActiveSection("payroll")}>
                      <div className="ds-metric-card__top">
                        <div className="ds-metric-card__icon"><Calendar size={16} strokeWidth={1.5} /></div>
                        <span className="ds-metric-card__tag">Day {day}/{daysInMonth}</span>
                      </div>
                      <div className="ds-metric-card__number ds-metric-card__value--sm">{monthLabel}</div>
                      <div className="ds-metric-progress-wrap">
                        <div className="ds-metric-progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="ds-metric-card__label">Pay period</div>
                      <Calendar className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(74,64,64,0.20)" }} />
                    </div>
                  );
                })()}
              </div>
            );
          }

          if (activeSection === "employees") {
            return (
              <div className="ds-metric-strip">
                <div
                  className="ds-metric-card ds-metric-card--primary ds-metric-card--clickable"
                  onClick={() => {
                    setActiveSection("time-records");
                    setOpenOnly(false);
                  }}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon"><span className="ds-metric-live-dot" /></div>
                    <span className="ds-metric-card__tag">live</span>
                  </div>
                  <div className="ds-metric-card__number">{clockStats.currentlyWorking}</div>
                  <div className="ds-metric-card__label">Currently working</div>
                  <UsersRound className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(255,255,255,0.07)" }} />
                </div>

                <div
                  className="ds-metric-card ds-metric-card--warm ds-metric-card--clickable"
                  onClick={() => {
                    setActiveSection("time-records");
                    setPage(1);
                    setOpenOnly(true);
                  }}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon">
                      {clockStats.allOpen > 0 ? <TriangleAlert size={16} strokeWidth={1.5} /> : <CheckCircle size={16} strokeWidth={1.5} />}
                    </div>
                    <span className="ds-metric-card__tag">{clockStats.allOpen > 0 ? "needs review" : "all matched"}</span>
                  </div>
                  <div className="ds-metric-card__number">{clockStats.allOpen}</div>
                  <div className="ds-metric-card__label">Open check-ins</div>
                  <TriangleAlert className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(122,88,0,0.20)" }} />
                </div>

                <div
                  className={`ds-metric-card ds-metric-card--clickable ${proserveAlerts > 0 ? "ds-metric-card--warn" : ""}`}
                  onClick={() => setActiveSection("employees")}
                >
                  <div className="ds-metric-card__top">
                    <div className="ds-metric-card__icon"><IdCard size={16} strokeWidth={1.5} /></div>
                    <span className="ds-metric-card__tag">{proserveAlerts > 0 ? "alert" : "ok"}</span>
                  </div>
                  <div className="ds-metric-card__number">{proserveAlerts}</div>
                  <div className="ds-metric-card__label">ProServe alerts</div>
                  <IdCard className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(74,64,64,0.20)" }} />
                </div>
                {(() => {
                  const now = new Date();
                  const day = Number(now.toLocaleDateString("en-CA", { timeZone: TZ, day: "numeric" }));
                  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
                  const monthLabel = now.toLocaleDateString("en-CA", { timeZone: TZ, month: "long", year: "numeric" });
                  const pct = Math.round((day / daysInMonth) * 100);
                  return (
                    <div className="ds-metric-card ds-metric-card--clickable" onClick={() => setActiveSection("payroll")}>
                      <div className="ds-metric-card__top">
                        <div className="ds-metric-card__icon"><Calendar size={16} strokeWidth={1.5} /></div>
                        <span className="ds-metric-card__tag">Day {day}/{daysInMonth}</span>
                      </div>
                      <div className="ds-metric-card__number ds-metric-card__value--sm">{monthLabel}</div>
                      <div className="ds-metric-progress-wrap">
                        <div className="ds-metric-progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="ds-metric-card__label">Current pay period</div>
                      <Calendar className="ds-metric-card__deco" size={80} strokeWidth={1.5} style={{ color: "rgba(74,64,64,0.20)" }} />
                    </div>
                  );
                })()}
              </div>
            );
          }

          return (
            <div className="ds-metric-strip">
              <div
                className="ds-metric-card ds-metric-card--primary ds-metric-card--clickable"
                onClick={() => setActiveSection("employees")}
              >
                <div className="ds-metric-card__top">
                  <div className="ds-metric-card__icon"><UsersRound size={16} strokeWidth={1.8} /></div>
                  <span className="ds-metric-card__tag">active</span>
                </div>
                <div className="ds-metric-card__number">{activeCount}</div>
                <div className="ds-metric-card__label">Team members</div>
              </div>
              <div
                className="ds-metric-card ds-metric-card--jade ds-metric-card--clickable"
                onClick={() => {
                  setActiveSection("time-records");
                  setOpenOnly(false);
                }}
              >
                <div className="ds-metric-card__top">
                  <div className="ds-metric-card__icon"><Timer size={16} strokeWidth={1.8} /></div>
                  <span className="ds-metric-card__tag">period</span>
                </div>
                <div className="ds-metric-card__number">{totalHours.toFixed(1)}</div>
                <div className="ds-metric-card__label">Hours logged</div>
              </div>
              <div
                className={`ds-metric-card ds-metric-card--clickable ${proserveAlerts > 0 ? "ds-metric-card--warn" : ""}`}
                onClick={() => setActiveSection("employees")}
              >
                <div className="ds-metric-card__top">
                  <div className="ds-metric-card__icon"><IdCard size={16} strokeWidth={1.5} /></div>
                  <span className="ds-metric-card__tag">{proserveAlerts > 0 ? "alert" : "ok"}</span>
                </div>
                <div className="ds-metric-card__number">{proserveAlerts}</div>
                <div className="ds-metric-card__label">ProServe alerts</div>
              </div>
              <div
                className="ds-metric-card ds-metric-card--clickable"
                onClick={() => {
                  setActiveSection("time-records");
                  setOpenOnly(false);
                }}
              >
                <div className="ds-metric-card__top">
                  <div className="ds-metric-card__icon"><ClipboardList size={16} strokeWidth={1.5} /></div>
                  <span className="ds-metric-card__tag">total</span>
                </div>
                <div className="ds-metric-card__number">{totalRecords}</div>
                <div className="ds-metric-card__label">Clock records</div>
              </div>
            </div>
          );
        })()}

        {feedback && (
          <div className="admin-alert admin-alert--success" style={{ marginBottom: "1rem" }}>{feedback}</div>
        )}
        {error && (
          <div className="admin-alert admin-alert--error" style={{ marginBottom: "1rem" }}>{error}</div>
        )}

        <div className="ds-page-body">

        {activeSection === "employees" ? (
          <div className="admin-panel">
            {isEmployeeCreateOpen ? (
              <div style={{ marginBottom: "1.5rem" }}>
              <form onSubmit={handleCreateEmployee} className="admin-form-stack admin-employee-create-drawer">
                <label className="admin-field">
                  <span className="admin-field__label">Employee name</span>
                  <input
                    type="text"
                    value={employeeCreateForm.name}
                    onChange={(event) =>
                      setEmployeeCreateForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    className="admin-input"
                    required
                  />
                </label>

                <label className="admin-field">
                  <span className="admin-field__label">Initial PIN</span>
                  <input
                    type="text"
                    value={employeeCreateForm.pin}
                    onChange={(event) =>
                      setEmployeeCreateForm((current) => ({
                        ...current,
                        pin: event.target.value,
                      }))
                    }
                    className="admin-input"
                    required
                  />
                </label>

                <div className="admin-field">
                  <span className="admin-field__label">Pay type</span>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => setEmployeeCreateForm((c) => ({ ...c, pay_type: "hourly" }))}
                      className={`ef-pay-toggle ${(employeeCreateForm.pay_type || "hourly") === "hourly" ? "ef-pay-toggle--active" : ""}`}
                    >Hourly</button>
                    <button
                      type="button"
                      onClick={() => setEmployeeCreateForm((c) => ({ ...c, pay_type: "salaried" }))}
                      className={`ef-pay-toggle ${employeeCreateForm.pay_type === "salaried" ? "ef-pay-toggle--active" : ""}`}
                    >Salaried</button>
                  </div>
                </div>

                {(employeeCreateForm.pay_type || "hourly") === "hourly" && (
                  <>
                    <label className="admin-field">
                      <span className="admin-field__label">Hourly rate</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={employeeCreateForm.defaultHourlyRate}
                        onChange={(event) =>
                          setEmployeeCreateForm((current) => ({
                            ...current,
                            defaultHourlyRate: event.target.value,
                          }))
                        }
                        className="admin-input"
                        required
                      />
                    </label>

                    <label className="admin-field">
                      <span className="admin-field__label">Pay frequency</span>
                      <select
                        value={employeeCreateForm.defaultPayFrequency}
                        onChange={(event) =>
                          setEmployeeCreateForm((current) => ({
                            ...current,
                            defaultPayFrequency: event.target.value,
                          }))
                        }
                        className="admin-select"
                        required
                      >
                        <option value="">Select pay frequency</option>
                        {(payrollConfig?.pay_frequency_options || []).map((option) => (
                          <option key={option.code} value={option.code}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}

                {employeeCreateForm.pay_type === "salaried" && (
                  <>
                    <label className="admin-field">
                      <span className="admin-field__label">Annual salary ($)</span>
                      <input type="number" min="0" step="1000" className="admin-input"
                        value={employeeCreateForm.annual_salary || ""}
                        onChange={(e) => setEmployeeCreateForm((c) => ({ ...c, annual_salary: e.target.value }))} />
                    </label>
                    <label className="admin-field">
                      <span className="admin-field__label">Monthly salary (auto)</span>
                      <input type="text" readOnly className="admin-input ef-input--readonly"
                        value={employeeCreateForm.annual_salary ? `$${(Number(employeeCreateForm.annual_salary) / 12).toFixed(2)}` : "Ã¢â‚¬â€"} />
                    </label>
                    <label className="admin-field">
                      <span className="admin-field__label">Vacation pay rule</span>
                      <input type="text" readOnly className="admin-input ef-input--readonly"
                        value={`${getVacationPayPercentForStartDate(employeeCreateForm.startDate)}% by service date`} />
                    </label>
                  </>
                )}

                <label className="admin-field">
                  <span className="admin-field__label">Start date</span>
                  <input
                    type="date"
                    value={employeeCreateForm.startDate}
                    onChange={(event) =>
                      setEmployeeCreateForm((current) => ({
                        ...current,
                        startDate: event.target.value,
                      }))
                    }
                    className="admin-input"
                    required
                  />
                </label>

                <label className="admin-field">
                  <span className="admin-field__label">Vacation pay schedule</span>
                  <select
                    value={employeeCreateForm.vacationPaySchedule}
                    onChange={(event) =>
                      setEmployeeCreateForm((current) => ({
                        ...current,
                        vacationPaySchedule: event.target.value,
                      }))
                    }
                    className="admin-select"
                  >
                    <option value="monthly">Monthly payout</option>
                    <option value="accrued">Accrued balance</option>
                  </select>
                </label>

                <label className="admin-checkbox-card">
                  <input
                    type="checkbox"
                    checked={employeeCreateForm.active}
                    onChange={(event) =>
                      setEmployeeCreateForm((current) => ({
                        ...current,
                        active: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    <strong>Active employee</strong>
                    <small>Shows this employee in the kiosk list.</small>
                  </span>
                </label>

                <button type="submit" className="admin-button admin-button--primary">
                  Create employee
                </button>
              </form>
              </div>
            ) : null}

            <div className="admin-team-toolbar">
              <div className="admin-team-toolbar__left">
                <h2 className="admin-panel__title">Team</h2>
                <span className="admin-team-header__count">
                  {filteredAdminEmployees.length} employee{filteredAdminEmployees.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="admin-team-toolbar__right">
                <input
                  type="text"
                  className="admin-team-search"
                  placeholder="Search by nameÃ¢â‚¬Â¦"
                  value={employeeSearch}
                  onChange={(e) => setEmployeeSearch(e.target.value)}
                />
                <button
                  className="admin-button admin-button--secondary admin-button--compact admin-button--subtle"
                  onClick={() => {
                    setIsEmployeeCreateOpen((current) => !current);
                    setSelectedEmployeeId(null);
                  }}
                >
                  {isEmployeeCreateOpen ? "Ã¢Å“â€¢ Cancel" : "+ New employee"}
                </button>
              </div>
            </div>

            <div className="emp-table-wrap">
              <table className="emp-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Status</th>
                    <th>Rate</th>
                    <th>Pay frequency</th>
                    <th>Contact</th>
                    <th>Hire/start</th>
                    <th>ProServe</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAdminEmployees.map((employee) => {
                    const draft = employeeSettingsDrafts[employee.id] || {};
                    const isSelected = selectedEmployeeId === employee.id;
                    const ps = proserveStatus(employee.proserve_expiry);
                    const initial = (employee.name || "?")[0].toUpperCase();
                    const isSalaried = (draft.pay_type || employee.pay_type) === "salaried";
                    const payFrequency = isSalaried
                      ? "Monthly salary"
                      : getPayFrequencyLabel(draft.defaultPayFrequency || employee.default_pay_frequency, payrollConfig);
                    const primaryDate = employee.hire_date || employee.start_date;
                    const phone = employee.phone || "";
                    const email = employee.email || "";
                    const proserveLabel = getProServeBadgeLabel(ps);
                    return [
                      <tr
                        key={`emp-${employee.id}`}
                        className={`emp-table__row ${isSelected ? "is-selected" : ""}`}
                      >
                        <td>
                          <div className="emp-table__name-cell">
                            <div className="emp-table__avatar">{initial}</div>
                            <div className="emp-table__name-stack">
                              <span className="emp-table__name">{employee.name}</span>
                              <span className="emp-table__email">{isSalaried ? "Salaried employee" : "Hourly employee"}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`emp-status-badge ${(draft.active !== undefined ? draft.active : employee.active) ? "emp-status-badge--active" : "emp-status-badge--inactive"}`}>
                            {(draft.active !== undefined ? draft.active : employee.active) ? "Active" : "Hidden"}
                          </span>
                        </td>
                        <td className="emp-table__data">
                          {isSalaried
                            ? `$${Number((draft.annual_salary || employee.annual_salary || 0)).toLocaleString()}/yr`
                            : `$${Number(draft.defaultHourlyRate || employee.default_hourly_rate || 0).toFixed(2)}/hr`}
                        </td>
                        <td className="emp-table__data">
                          {payFrequency || "Use payroll period"}
                        </td>
                        <td className="emp-table__data">
                          <div className="emp-contact-stack">
                            {phone ? <span>{phone}</span> : null}
                            <span className={email ? "" : "emp-muted-placeholder"}>{email || "No email"}</span>
                          </div>
                        </td>
                        <td className="emp-table__data">
                          {primaryDate ? new Date(primaryDate + "T12:00:00Z").toLocaleDateString("en-CA", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" }) : "Ã¢â‚¬â€"}
                        </td>
                        <td>
                          <span className={`ps-badge ps-badge--${ps || "none"}`}>{proserveLabel}</span>
                        </td>
                        <td className="emp-table__actions-cell">
                          <button
                            className={`admin-employee-card-btn ${isSelected ? "admin-employee-card-btn--close" : ""}`}
                            onClick={(e) => { e.stopPropagation(); setSelectedEmployeeId(isSelected ? null : employee.id); }}
                          >
                            {isSelected ? "Close" : "Edit"}
                          </button>
                        </td>
                      </tr>,
                      isSelected ? (
                        <tr key={`detail-${employee.id}`} className="emp-detail-row">
                          <td colSpan={8} className="emp-detail-cell">
                            <div className="admin-employee-inline-detail">
                            <div className="admin-employee-detail__header">
                              <div>
                                <h3 className="admin-employee-detail__title">{draft.name || employee.name}</h3>
                                <p className="admin-panel__subtitle">
                                  Update payroll settings, kiosk access, and account details for this employee.
                                </p>
                              </div>
                              <div className="admin-employee-card__counts">
                                <span>Time records: {employee.time_records_count}</span>
                                <span>Payroll items: {employee.payroll_items_count}</span>
                                <span>Audit logs: {employee.audit_logs_count}</span>
                              </div>
                            </div>

                            <div className="admin-employee-fields">

                              {/* Ã¢â€â‚¬Ã¢â€â‚¬ Payroll Settings Ã¢â€â‚¬Ã¢â€â‚¬ */}
                              <div className="ef-section">
                                <div className="ef-section__label">Payroll Settings</div>
                                <div className="ef-section__fields">
                                  <label className="admin-field">
                                    <span className="admin-field__label">Employee name</span>
                                    <input
                                      type="text"
                                      value={draft.name ?? ""}
                                      onChange={(event) =>
                                        setEmployeeSettingsDrafts((current) => ({
                                          ...current,
                                          [employee.id]: { ...current[employee.id], name: event.target.value },
                                        }))
                                      }
                                      className="admin-input"
                                    />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">New PIN</span>
                                    <input
                                      type="text"
                                      value={draft.pin ?? ""}
                                      onChange={(event) =>
                                        setEmployeeSettingsDrafts((current) => ({
                                          ...current,
                                          [employee.id]: { ...current[employee.id], pin: event.target.value },
                                        }))
                                      }
                                      className="admin-input"
                                      placeholder="Leave blank to keep current PIN"
                                    />
                                  </label>

                                  <div className="admin-field">
                                    <span className="admin-field__label">Pay type</span>
                                    <div style={{ display: "flex", gap: "0.5rem" }}>
                                      <button
                                        type="button"
                                        onClick={() => setEmployeeSettingsDrafts((c) => ({ ...c, [employee.id]: { ...c[employee.id], pay_type: "hourly" } }))}
                                        className={`ef-pay-toggle ${(draft.pay_type || "hourly") === "hourly" ? "ef-pay-toggle--active" : ""}`}
                                      >Hourly</button>
                                      <button
                                        type="button"
                                        onClick={() => setEmployeeSettingsDrafts((c) => ({ ...c, [employee.id]: { ...c[employee.id], pay_type: "salaried" } }))}
                                        className={`ef-pay-toggle ${draft.pay_type === "salaried" ? "ef-pay-toggle--active" : ""}`}
                                      >Salaried</button>
                                    </div>
                                  </div>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Start date</span>
                                    <input
                                      type="date"
                                      value={draft.startDate ?? ""}
                                      onChange={(event) =>
                                        setEmployeeSettingsDrafts((current) => ({
                                          ...current,
                                          [employee.id]: { ...current[employee.id], startDate: event.target.value },
                                        }))
                                      }
                                      className="admin-input"
                                    />
                                  </label>

                                  {(draft.pay_type || "hourly") === "hourly" && (
                                    <>
                                      <label className="admin-field">
                                        <span className="admin-field__label">Hourly rate</span>
                                        <input
                                          type="number"
                                          min="0.01"
                                          step="0.01"
                                          value={draft.defaultHourlyRate ?? ""}
                                          onChange={(event) =>
                                            setEmployeeSettingsDrafts((current) => ({
                                              ...current,
                                              [employee.id]: { ...current[employee.id], defaultHourlyRate: event.target.value },
                                            }))
                                          }
                                          className="admin-input"
                                        />
                                      </label>

                                      <label className="admin-field">
                                        <span className="admin-field__label">Pay frequency</span>
                                        <select
                                          value={draft.defaultPayFrequency ?? ""}
                                          onChange={(event) =>
                                            setEmployeeSettingsDrafts((current) => ({
                                              ...current,
                                              [employee.id]: { ...current[employee.id], defaultPayFrequency: event.target.value },
                                            }))
                                          }
                                          className="admin-select"
                                        >
                                          <option value="">Select pay frequency</option>
                                          {(payrollConfig?.pay_frequency_options || []).map((option) => (
                                            <option key={option.code} value={option.code}>
                                              {option.label}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    </>
                                  )}

                                  {draft.pay_type === "salaried" && (
                                    <>
                                      <label className="admin-field">
                                        <span className="admin-field__label">Annual salary ($)</span>
                                        <input type="number" min="0" step="1000" className="admin-input"
                                          value={draft.annual_salary ?? ""}
                                          onChange={(e) => setEmployeeSettingsDrafts((c) => ({ ...c, [employee.id]: { ...c[employee.id], annual_salary: e.target.value } }))} />
                                      </label>
                                      <label className="admin-field">
                                        <span className="admin-field__label">Monthly salary (auto)</span>
                                        <input type="text" readOnly className="admin-input ef-input--readonly"
                                          value={draft.annual_salary ? `$${(Number(draft.annual_salary) / 12).toFixed(2)}` : "Ã¢â‚¬â€"} />
                                      </label>
                                      <label className="admin-field">
                                        <span className="admin-field__label">Vacation pay rule</span>
                                        <input type="text" readOnly className="admin-input ef-input--readonly"
                                          value={`${getVacationPayPercentForStartDate(draft.startDate)}% by service date`} />
                                      </label>
                                    </>
                                  )}

                                  <label className="admin-field">
                                    <span className="admin-field__label">Vacation pay schedule</span>
                                    <select
                                      value={draft.vacationPaySchedule ?? "monthly"}
                                      onChange={(event) =>
                                        setEmployeeSettingsDrafts((current) => ({
                                          ...current,
                                          [employee.id]: { ...current[employee.id], vacationPaySchedule: event.target.value },
                                        }))
                                      }
                                      className="admin-select"
                                    >
                                      <option value="monthly">Monthly payout</option>
                                      <option value="accrued">Accrued balance</option>
                                    </select>
                                  </label>
                                </div>
                              </div>

                              {/* Ã¢â€â‚¬Ã¢â€â‚¬ Personal Information Ã¢â€â‚¬Ã¢â€â‚¬ */}
                              <div className="ef-section">
                                <div className="ef-section__label">Personal Information</div>
                                <div className="ef-section__fields">
                                  <label className="admin-field">
                                    <span className="admin-field__label">Phone</span>
                                    <input type="tel" className="admin-input" placeholder="+1 (403) 000-0000"
                                      value={draft.phone ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], phone: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Email</span>
                                    <input type="email" className="admin-input" placeholder="employee@example.com"
                                      value={draft.email ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], email: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">SIN</span>
                                    <input type="text" className="admin-input" placeholder="000 000 000"
                                      value={draft.sin ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], sin: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field ef-full">
                                    <span className="admin-field__label">Home Address</span>
                                    <input type="text" className="admin-input" placeholder="123 Main St, Banff, AB T1L 1A1"
                                      value={draft.home_address ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], home_address: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Hire Date</span>
                                    <input type="date" className="admin-input"
                                      value={draft.hire_date ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], hire_date: e.target.value } }))} />
                                  </label>
                                </div>
                              </div>

                              {/* Ã¢â€â‚¬Ã¢â€â‚¬ ProServe Certification Ã¢â€â‚¬Ã¢â€â‚¬ */}
                              <div className="ef-section">
                                <div className="ef-section__label">ProServe Certification</div>
                                <div className="ef-section__fields ef-section__fields--2col">
                                  <label className="admin-field">
                                    <span className="admin-field__label">ProServe Number</span>
                                    <input type="text" className="admin-input" placeholder="PS-000000"
                                      value={draft.proserve_number ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], proserve_number: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Expiry Date</span>
                                    <input type="date" className="admin-input"
                                      value={draft.proserve_expiry ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], proserve_expiry: e.target.value } }))} />
                                  </label>

                                  {draft.proserve_expiry && (() => {
                                    const status = proserveStatus(draft.proserve_expiry);
                                    const styles = {
                                      expired: { color: "#8A1010", bg: "rgba(180,30,30,0.12)" },
                                      expiring: { color: "#7A5800", bg: "rgba(255,200,60,0.20)" },
                                      ok: { color: "#1A6B40", bg: "rgba(30,150,90,0.12)" },
                                    };
                                    const s = styles[status] || styles.ok;
                                    const label = status === "expired" ? "Expired" : status === "expiring" ? "Expiring soon" : "Valid";
                                    return <div style={{ fontSize: "0.8rem", fontWeight: 600, padding: "0.3rem 0.75rem", borderRadius: 50, background: s.bg, color: s.color, display: "inline-flex", alignItems: "center", alignSelf: "flex-end", gap: 4 }}>{label}</div>;
                                  })()}
                                </div>
                              </div>

                              {/* Ã¢â€â‚¬Ã¢â€â‚¬ Record of Employment Ã¢â€â‚¬Ã¢â€â‚¬ */}
                              <div className="ef-section">
                                <div className="ef-section__label">Record of Employment (ROE)</div>
                                <div className="ef-section__fields">
                                  <label className="admin-field">
                                    <span className="admin-field__label">Last Day Worked</span>
                                    <input type="date" className="admin-input"
                                      value={draft.roe_last_day ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], roe_last_day: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Insurable Hours</span>
                                    <input type="number" min="0" step="0.5" className="admin-input" placeholder="0"
                                      value={draft.roe_hours ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], roe_hours: e.target.value } }))} />
                                  </label>

                                  <label className="admin-field">
                                    <span className="admin-field__label">Insurable Earnings</span>
                                    <input type="number" min="0" step="0.01" className="admin-input" placeholder="0.00"
                                      value={draft.roe_wage ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], roe_wage: e.target.value } }))} />
                                  </label>
                                </div>
                              </div>

                              {/* Ã¢â€â‚¬Ã¢â€â‚¬ Benefits & Notes Ã¢â€â‚¬Ã¢â€â‚¬ */}
                              <div className="ef-section">
                                <div className="ef-section__label">Benefits &amp; Notes</div>
                                <div className="ef-section__fields" style={{ gridTemplateColumns: "1fr" }}>
                                  <label className="admin-field">
                                    <span className="admin-field__label">Benefits Note</span>
                                    <textarea className="admin-input admin-textarea" rows={3} placeholder="e.g. Extended health coverage, meal allowance..."
                                      value={draft.benefits_note ?? ""}
                                      onChange={e => setEmployeeSettingsDrafts(c => ({ ...c, [employee.id]: { ...c[employee.id], benefits_note: e.target.value } }))} />
                                  </label>
                                </div>
                              </div>

                            </div>

                            <div className="admin-employee-detail__actions">
                              <div className="admin-note admin-note--soft">
                                <strong>Hide / deactivate</strong>
                                <label className="admin-switch">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(draft.active)}
                                    onChange={(event) =>
                                      setEmployeeSettingsDrafts((current) => ({
                                        ...current,
                                        [employee.id]: {
                                          ...current[employee.id],
                                          active: event.target.checked,
                                        },
                                      }))
                                    }
                                  />
                                  <span>{draft.active ? "Employee is visible in the kiosk" : "Employee is hidden from the kiosk"}</span>
                                </label>
                              </div>

                              <div className="admin-note admin-note--danger">
                                <strong>Delete permanently</strong>
                                <span>
                                  {employee.can_delete
                                    ? "This employee can be deleted permanently because no time records or payroll items exist."
                                    : "Delete is blocked because payroll or time tracking history already exists. Hide the employee instead."}
                                </span>
                              </div>
                            </div>

                            <div className="admin-employee-detail__footer">
                              <button
                                onClick={() => handleSaveEmployeeSettings(employee.id)}
                                className="admin-button admin-button--primary"
                              >
                                Save changes
                              </button>
                              <button
                                onClick={() => setSelectedEmployeeId(null)}
                                className="admin-button admin-button--secondary"
                              >
                                Close
                              </button>
                              <button
                                onClick={() => handleDeleteEmployee(employee)}
                                className="admin-button admin-button--danger"
                                disabled={!employee.can_delete}
                                style={{ marginLeft: "auto" }}
                              >
                                Delete permanently
                              </button>
                            </div>
                          </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {activeSection === "time-records" ? (
          <>
            <div className="admin-layout-two-column clock-page-layout">
              <div className="admin-stack clock-page-layout__side">
                <div className="admin-panel admin-panel--sidebar clock-action-panel p-6">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">
                        {formMode === "edit" ? "Edit clock record" : "Add clock record"}
                      </h2>
                      <p className="admin-panel__subtitle mt-1 text-sm">
                        Add or correct a check-in or check-out event with full audit tracking.
                      </p>
                    </div>
                    {formMode === "edit" ? (
                      <button
                        onClick={resetForm}
                        className="admin-button admin-button--secondary admin-button--compact"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>

                  <form onSubmit={handleSubmit} className="admin-form-stack mt-6">
                    <label className="admin-field">
                      <span className="admin-field__label">Employee</span>
                      <select
                        value={formState.employeeId}
                        onChange={(event) =>
                          setFormState((current) => ({ ...current, employeeId: event.target.value }))
                        }
                        disabled={formMode === "edit"}
                        className="admin-select"
                        required
                      >
                        <option value="">Select employee</option>
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="admin-inline-fields clock-record-inline-fields">
                      <label className="admin-field">
                        <span className="admin-field__label">Event</span>
                        <select
                          value={formState.type}
                          onChange={(event) =>
                            setFormState((current) => ({ ...current, type: event.target.value }))
                          }
                          className="admin-select"
                          required
                        >
                          <option value="check-in">check-in</option>
                          <option value="check-out">check-out</option>
                        </select>
                      </label>

                      <label className="admin-field">
                        <span className="admin-field__label">Recorded at</span>
                        <input
                          type="datetime-local"
                          value={formState.recordedAt}
                          onChange={(event) =>
                            setFormState((current) => ({ ...current, recordedAt: event.target.value }))
                          }
                          className="admin-input"
                          required
                        />
                      </label>
                    </div>

                    <label className="admin-field">
                      <span className="admin-field__label">Kiosk ID</span>
                      <input
                        type="text"
                        value={formState.kioskId}
                        onChange={(event) =>
                          setFormState((current) => ({ ...current, kioskId: event.target.value }))
                        }
                        placeholder="Optional kiosk ID"
                        className="admin-input"
                      />
                    </label>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="admin-button admin-button--primary"
                    >
                      {isSubmitting
                        ? "Saving..."
                        : formMode === "edit"
                          ? "Save changes"
                          : "Create record"}
                    </button>
                  </form>
                </div>

                <div className="admin-panel admin-panel--sidebar clock-action-panel p-6">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">
                        {manualHoursMode === "edit" ? "Edit manual hours" : "Add manual hours"}
                      </h2>
                      <p className="admin-panel__subtitle mt-1 text-sm">
                        Add regular hours and optional Family Day or holiday hours for missed punches, corrections, or past periods.
                      </p>
                    </div>
                    {manualHoursMode === "edit" ? (
                      <button
                        onClick={resetManualHoursForm}
                        className="admin-button admin-button--secondary admin-button--compact"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>

                  <form onSubmit={handleManualHoursSubmit} className="admin-form-stack mt-6">
                    <label className="admin-field">
                      <span className="admin-field__label">Employee</span>
                      <select
                        value={manualHoursForm.employeeId}
                        onChange={(event) =>
                          setManualHoursForm((current) => ({
                            ...current,
                            employeeId: event.target.value,
                          }))
                        }
                        disabled={manualHoursMode === "edit"}
                        className="admin-select"
                        required
                      >
                        <option value="">Select employee</option>
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="admin-field">
                      <span className="admin-field__label">Date</span>
                      <input
                        type="date"
                        value={manualHoursForm.workDate}
                        onChange={(event) =>
                          setManualHoursForm((current) => ({
                            ...current,
                            workDate: event.target.value,
                          }))
                        }
                        className="admin-input"
                        required
                      />
                    </label>

                    <label className="admin-field">
                      <span className="admin-field__label">Regular hours</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={manualHoursForm.regularHours}
                        onChange={(event) =>
                          setManualHoursForm((current) => ({
                            ...current,
                            regularHours: event.target.value,
                          }))
                        }
                        placeholder="For example: 8, 8.5, 7.75, 102.5"
                        className="admin-input"
                      />
                    </label>

                    <div className="admin-collapsible">
                      <button
                        type="button"
                        className={`admin-collapsible__toggle ${isHolidayHoursOpen ? "is-open" : ""}`}
                        onClick={() => setIsHolidayHoursOpen((current) => !current)}
                      >
                        <span>Add holiday / family day hours</span>
                        <span>{isHolidayHoursOpen ? "Hide section" : "Optional"}</span>
                      </button>

                      {isHolidayHoursOpen ? (
                        <div className="admin-collapsible__content">
                          <label className="admin-field">
                            <span className="admin-field__label">Holiday label</span>
                            <input
                              type="text"
                              value={manualHoursForm.holidayLabel}
                              onChange={(event) =>
                                setManualHoursForm((current) => ({
                                  ...current,
                                  holidayLabel: event.target.value,
                                }))
                              }
                              placeholder="For example: Family Day"
                              className="admin-input"
                            />
                          </label>

                          <div className="admin-inline-fields">
                            <label className="admin-field">
                              <span className="admin-field__label">Holiday hours</span>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={manualHoursForm.holidayHours}
                                onChange={(event) =>
                                  setManualHoursForm((current) => ({
                                    ...current,
                                    holidayHours: event.target.value,
                                  }))
                                }
                                placeholder="Optional"
                                className="admin-input"
                              />
                            </label>

                            <label className="admin-field">
                              <span className="admin-field__label">Holiday multiplier</span>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={manualHoursForm.holidayMultiplier}
                                onChange={(event) =>
                                  setManualHoursForm((current) => ({
                                    ...current,
                                    holidayMultiplier: event.target.value,
                                  }))
                                }
                                placeholder="Default: 1.5"
                                className="admin-input"
                              />
                            </label>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <label className="admin-field">
                      <span className="admin-field__label">Note</span>
                      <textarea
                        value={manualHoursForm.note}
                        onChange={(event) =>
                          setManualHoursForm((current) => ({
                            ...current,
                            note: event.target.value,
                          }))
                        }
                        placeholder="Optional note (for example: missed check-in)"
                        className="admin-input admin-textarea"
                        rows="3"
                      />
                    </label>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="admin-button admin-button--primary"
                    >
                      {isSubmitting
                        ? "Saving..."
                        : manualHoursMode === "edit"
                          ? "Save manual hours"
                          : "Add manual hours"}
                    </button>
                  </form>
                </div>
              </div>

              <div className="admin-stack clock-page-layout__main">
            <div className="admin-panel clock-records-panel p-6">
              <div className="admin-panel__header admin-panel__header--split">
                <div>
                  <h2 className="admin-panel__title text-2xl font-bold">Time Records</h2>
                  {!isLoading ? (
                    <p className="admin-panel__subtitle mt-1 text-sm">{recordsResponse.total} total records</p>
                  ) : null}
                </div>
                <div className="admin-actions-row">
                  <label className="admin-subtle-text">Per page</label>
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPage(1);
                      setPageSize(Number(event.target.value));
                    }}
                    className="admin-select admin-select--compact"
                  >
                    {[10, 20, 50].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => hasPreviousPage && setPage((current) => current - 1)}
                    disabled={!hasPreviousPage}
                    className="admin-button admin-button--secondary admin-button--compact"
                  >
                    Previous
                  </button>
                  <div className="admin-subtle-text">
                    Page {recordsResponse.totalPages === 0 ? 0 : recordsResponse.page} of{" "}
                    {recordsResponse.totalPages}
                  </div>
                  <button
                    onClick={() => hasNextPage && setPage((current) => current + 1)}
                    disabled={!hasNextPage}
                    className="admin-button admin-button--primary admin-button--compact"
                  >
                    Next
                  </button>
                </div>
              </div>

              <div className="admin-filters-grid clock-filter-grid" style={{ marginBottom: "1rem" }}>
                <select
                  value={filters.employeeId}
                  onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, employeeId: event.target.value })); }}
                  className="admin-select"
                >
                  <option value="">All employees</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.name}</option>
                  ))}
                </select>
                <input type="date" value={filters.start} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, start: event.target.value })); }} className="admin-input" />
                <input type="date" value={filters.end} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, end: event.target.value })); }} className="admin-input" />
                <select value={filters.recordStatus} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, recordStatus: event.target.value })); }} className="admin-select">
                  <option value="active">Active</option>
                  <option value="deleted">Deleted</option>
                  <option value="all">All</option>
                </select>
                <div className="admin-actions-row">
                  <button className={`admin-button admin-button--compact ${openOnly ? "admin-button--primary" : "admin-button--secondary"}`} onClick={() => setOpenOnly(o => !o)} title="Show only open check-ins">Open only</button>
                  <button onClick={() => { setPage(1); setPageSize(DEFAULT_PAGE_SIZE); setFilters({ employeeId: "", start: "", end: "", recordStatus: "active" }); setOpenOnly(false); }} className="admin-button admin-button--secondary">Clear</button>
                  <button onClick={handleExport} className="admin-button admin-button--success">Export CSV</button>
                </div>
              </div>

              <div className="cr-emp-chips">
                {summary.employees.map((item) => (
                  <button
                    key={item.employee_id}
                    className={`cr-emp-chip ${filters.employeeId === String(item.employee_id) ? "cr-emp-chip--active" : ""}`}
                    onClick={() => { setPage(1); setFilters((c) => ({ ...c, employeeId: String(item.employee_id) })); }}
                  >
                    <span className="cr-emp-chip__avatar">{(item.employee_name || "?")[0].toUpperCase()}</span>
                    <span className="cr-emp-chip__name">{item.employee_name}</span>
                    <span className="cr-emp-chip__hours">{Number(item.payroll_ready_hours || 0).toFixed(1)}h</span>
                  </button>
                ))}
              </div>

              <table className="cr-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th></th>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Note / Kiosk ID</th>
                    <th></th>
                  </tr>
                </thead>
                {(() => {
                  const grouped = (recordsResponse.items || []).reduce((acc, record) => {
                    const day = record.recorded_at
                      ? new Date(record.recorded_at).toLocaleDateString("en-CA", { timeZone: TZ })
                      : "unknown";
                    if (!acc[day]) acc[day] = [];
                    acc[day].push(record);
                    return acc;
                  }, {});
                  const dayKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
                  if (dayKeys.length === 0 && !isLoading) {
                    return (
                      <tbody>
                        <tr>
                          <td colSpan={7} style={{ padding: "1rem", opacity: 0.5 }}>No records found for the selected filters.</td>
                        </tr>
                      </tbody>
                    );
                  }
                  return dayKeys.map((day) => {
                    const dayRecords = grouped[day];
                    const dayLabel = day === "unknown" ? "Unknown date" : new Date(day + "T12:00:00Z").toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" }).toUpperCase();
                    return (
                      <tbody key={day}>
                        <tr className="cr-day-header-row">
                          <td colSpan={7}>
                            <div className="cr-day-header-inner">
                              <span className="cr-day-group__label">{dayLabel}</span>
                              <span className="cr-day-group__count">{dayRecords.length} event{dayRecords.length !== 1 ? "s" : ""}</span>
                            </div>
                          </td>
                        </tr>
                        {dayRecords.map((record) => {
                          const initial = (record.employee_name || "?")[0].toUpperCase();
                          const timeStr = record.recorded_at
                            ? new Date(record.recorded_at).toLocaleTimeString("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
                            : "Ã¢â‚¬â€";
                          const badgeClass = record.entry_type === "check-in" ? "cr-type-badge--in"
                            : record.entry_type === "check-out" ? "cr-type-badge--out"
                            : "cr-type-badge--manual";
                          return (
                            <tr key={record.id} className={`cr-record-row ${record.deleted_at ? "cr-record-row--deleted" : ""}`}>
                              <td className="cr-td__time">{timeStr}</td>
                              <td className="cr-td__avatar">
                                <span className="cr-row__avatar">{initial}</span>
                              </td>
                              <td className="cr-td__name">{record.employee_name}</td>
                              <td>
                                <span className={`cr-type-badge ${badgeClass}`}>
                                  {record.entry_type === "check-in" ? "In" : record.entry_type === "check-out" ? "Out" : record.entry_mode === "manual" ? "Manual" : record.entry_type}
                                </span>
                              </td>
                              <td className="cr-td__muted">{record.entry_mode || "Ã¢â‚¬â€"}</td>
                              <td className="cr-td__note">
                                {record.note || ""}
                                {record.kiosk_id ? <span style={{ opacity: 0.6 }}> #{record.kiosk_id}</span> : null}
                                {record.deleted_at ? <span style={{ color: "var(--c-accent)", marginLeft: 4, fontSize: "0.7rem" }}>deleted</span> : null}
                              </td>
                              <td className="cr-td__actions">
                                {!record.deleted_at && (
                                  <button className="cr-action-btn" onClick={() => handleEdit(record)}>Edit</button>
                                )}
                                {!record.deleted_at ? (
                                  <button className="cr-action-btn cr-action-btn--danger" onClick={() => handleDelete(record)}>Delete</button>
                                ) : (
                                  <button className="cr-action-btn" onClick={() => handleRestore(record)}>Restore</button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    );
                  });
                })()}
              </table>
            </div>
              </div>
            </div>
          </>
        ) : null}
        {activeSection === "payroll" ? (
          <>
            <div className="admin-banner admin-banner--info rounded-2xl border border-blue-200 bg-blue-50 px-6 py-4 text-blue-800">
              {payrollHint}
            </div>

            <div className="admin-layout-two-column">
              <div className="admin-panel admin-panel--sidebar p-6">
                <h2 className="admin-panel__title text-2xl font-bold">Generate payroll</h2>
                <p className="admin-panel__subtitle mt-1 text-sm">
                  Create a payroll period with regular earnings, vacation pay, holiday pay, deductions, and net pay.
                </p>

                {payrollConfig ? (
                  <div style={{ marginTop: "1.25rem" }}>
                    <button
                      type="button"
                      onClick={() => setShowPayrollRules(v => !v)}
                      className="admin-panel__subtitle"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: "0.4rem", textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: "rgba(138,128,120,0.4)" }}
                    >
                      {showPayrollRules ? "Hide payroll rules" : "View payroll rules"}
                    </button>
                    {showPayrollRules && (
                      <div className="admin-note" style={{ marginTop: "0.75rem" }}>
                        <div>
                          Overtime: {payrollConfig.overtime_rule.type} above{" "}
                          {payrollConfig.overtime_rule.regularHoursPerDay}h per day at{" "}
                          {payrollConfig.overtime_rule.overtimeMultiplier}x
                        </div>
                        {payrollConfig.holiday_pay_enabled ? (
                          <div>Holiday pay: {payrollConfig.holiday_pay_rule.description}</div>
                        ) : null}
                        {payrollConfig.vacation_pay_enabled ? (
                          <div>Vacation pay: {payrollConfig.vacation_pay_rule.description}</div>
                        ) : null}
                        {payrollConfig.payroll_jurisdiction ? (
                          <div>
                            Jurisdiction: {payrollConfig.payroll_jurisdiction.country}/
                            {payrollConfig.payroll_jurisdiction.province}{" "}
                            {payrollConfig.payroll_jurisdiction.tax_year},{" "}
                            {payrollConfig.payroll_jurisdiction.pay_frequency} (
                            {payrollConfig.payroll_jurisdiction.pay_periods_per_year} periods/year)
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}

                <form onSubmit={handleGeneratePayroll} className="admin-form-stack mt-6">
                  <label className="admin-field">
                    <span className="admin-field__label">Start date</span>
                    <input
                      type="date"
                      value={payrollForm.startDate}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, startDate: event.target.value }))
                      }
                      className="admin-input"
                      required
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">End date</span>
                    <input
                      type="date"
                      value={payrollForm.endDate}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, endDate: event.target.value }))
                      }
                      className="admin-input"
                      required
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">Pay date</span>
                    <input
                      type="date"
                      value={payrollForm.payDate}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, payDate: event.target.value }))
                      }
                      className="admin-input"
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">Wage rate label</span>
                    <input
                      type="text"
                      value={payrollForm.wageRateLabel}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, wageRateLabel: event.target.value }))
                      }
                      className="admin-input"
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">Payment reference (optional)</span>
                    <input
                      type="text"
                      value={payrollForm.chequeNumberPrefix}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, chequeNumberPrefix: event.target.value }))
                      }
                      className="admin-input"
                      placeholder="Optional, for example CHQ-2026-03"
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">Override hourly rate</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={payrollForm.hourlyRate}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, hourlyRate: event.target.value }))
                      }
                      className="admin-input"
                      placeholder="Leave blank to use each employee's hourly rate"
                    />
                  </label>
                  <label className="admin-field">
                    <span className="admin-field__label">Pay frequency</span>
                    <select
                      value={payrollForm.payFrequency}
                      onChange={(event) =>
                        setPayrollForm((current) => ({ ...current, payFrequency: event.target.value }))
                      }
                      className="admin-select"
                    >
                      <option value="">Use employee defaults when possible</option>
                      {(payrollConfig?.pay_frequency_options || []).map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.label} ({option.pay_periods_per_year}/year)
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="admin-note">
                    Payroll uses employee hourly rate and employee pay frequency by default.
                    A payroll override is only applied when you explicitly enter one here.
                  </div>

                  <button
                    type="submit"
                    disabled={isGeneratingPayroll}
                    className="admin-button admin-button--primary"
                  >
                    {isGeneratingPayroll ? "Generating..." : "Generate payroll"}
                  </button>
                </form>
              </div>

              <div className="admin-stack">
                <div className="admin-panel p-6">
                  <h2 className="admin-panel__title text-2xl font-bold">Generated periods</h2>
                  <p className="admin-panel__subtitle mt-1 text-sm">
                    Choose a payroll period to review the team payout package.
                  </p>
                  <div className="admin-payroll-period-list mt-6">
                    {payrollPeriods.length === 0 ? (
                      <div className="admin-empty-state">
                        No payroll has been generated yet.
                      </div>
                    ) : null}
                    {payrollPeriods.map((payroll) => (
                      <button
                        key={payroll.id}
                        type="button"
                        onClick={() => handleSelectPayroll(payroll.id)}
                        className={`admin-payroll-period-card ${
                          selectedPayroll?.id === payroll.id ? "is-selected" : ""
                        }`}
                      >
                        <div className="admin-payroll-period-card__top">
                          <div>
                            <div className="admin-payroll-period-card__period">
                              {new Date(payroll.start_date + "T12:00:00").toLocaleDateString("en-CA", { month: "long", year: "numeric" })}
                            </div>
                            <div className="admin-payroll-period-card__meta">
                              {payroll.start_date} to {payroll.end_date} &middot; {getPayFrequencyLabel(payroll.pay_frequency, payrollConfig)}
                            </div>
                          </div>
                          <span className={`admin-badge ${payroll.status === "approved" ? "admin-badge--success" : "admin-badge--neutral"}`}>
                            {payroll.status}
                          </span>
                        </div>
                        <div className="admin-payroll-period-card__stats">
                          <div><span>Hours</span><strong>{Number(payroll.total_hours || 0).toFixed(2)} h</strong></div>
                          <div><span>Gross</span><strong>${Number(payroll.total_gross_pay || 0).toFixed(2)}</strong></div>
                          <div><span>Total earnings</span><strong>${Number(payroll.total_earnings || 0).toFixed(2)}</strong></div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedPayroll && <div className="admin-panel p-6">
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1rem" }}>
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">Payroll details</h2>
                      <p className="admin-panel__subtitle mt-1 text-sm">
                        Review payroll totals and employee-level payout details before approval.
                      </p>
                    </div>
                    <div className="admin-actions-row">
                      {selectedPayroll ? (
                        <button
                          onClick={() => handleExportPayroll(selectedPayroll.id)}
                          className="admin-button admin-button--secondary admin-button--compact"
                        >
                          Export Excel
                        </button>
                      ) : null}
                      {selectedPayroll ? (
                        <button
                          onClick={handlePrintTeamPayroll}
                          className="admin-button admin-button--secondary admin-button--compact"
                        >
                          Print team package
                        </button>
                      ) : null}
                      {selectedPayroll ? (
                        <button
                          onClick={() => handleRecalculatePayroll(selectedPayroll)}
                          className="admin-button admin-button--secondary admin-button--compact"
                        >
                          {selectedPayroll.status === "approved"
                            ? "Recalculate approved payroll"
                            : "Recalculate payroll"}
                        </button>
                      ) : null}
                      {selectedPayroll && selectedPayroll.status !== "approved" ? (
                        <button
                          onClick={() => handleApprovePayroll(selectedPayroll.id)}
                          className="admin-button admin-button--success admin-button--compact"
                        >
                          Approve payroll
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {selectedPayroll ? (
                    <>
                      <div className="admin-metric-grid mb-6">
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Period</div>
                          <div className="font-semibold">
                            {selectedPayroll.start_date} to {selectedPayroll.end_date}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Status</div>
                          <div className="font-semibold">{selectedPayroll.status}</div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Frequency</div>
                          <div className="font-semibold">
                            {getPayFrequencyLabel(selectedPayroll.pay_frequency, payrollConfig)} ({selectedPayroll.pay_periods_per_year}/year)
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Pay date</div>
                          <div className="font-semibold">
                            {selectedPayroll.pay_date || selectedPayroll.end_date}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Gross</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_gross_pay.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Total earnings</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_earnings.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Vacation paid now</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_vacation_payout.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">Vacation accrued</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_vacation_accrued.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">CPP employer</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_cpp_employer.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm admin-subtle-text">EI employer</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_ei_employer.toFixed(2)}
                          </div>
                        </div>
                      </div>

                      <div className="admin-payroll-card-list">
                        {selectedPayroll.items.map((item) => {
                          const isExpanded = expandedPayrollItemId === item.id;
                          return (
                            <div key={item.id} className={`admin-payroll-item-card ${isExpanded ? "is-expanded" : ""}`}>
                              <div className="admin-payroll-item-card__top">
                                <div>
                                  <h3 className="admin-payroll-item-card__name">{item.employee_name}</h3>
                                  <div className="admin-payroll-item-card__meta">
                                    {item.pay_type === "salaried" ? (
                                      <span className="cr-type-badge cr-type-badge--salary">Monthly Salary</span>
                                    ) : (
                                      getVacationScheduleLabel(item.vacation_pay_schedule)
                                    )}
                                  </div>
                                </div>
                                <div className="admin-payroll-item-card__actions">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedPayrollItemId((current) =>
                                        current === item.id ? null : item.id,
                                      )
                                    }
                                    className="admin-button admin-button--secondary admin-button--compact"
                                  >
                                    {isExpanded ? "Hide details" : "View payroll details"}
                                  </button>
                                  <button
                                    onClick={() => handleViewPayslip(selectedPayroll.id, item.id)}
                                    className="admin-button admin-button--secondary admin-button--compact"
                                  >
                                    View payslip
                                  </button>
                                  {selectedPayslip?.payroll_item_id === item.id ? (
                                    <button
                                      onClick={handlePrintPayslip}
                                      className="admin-button admin-button--secondary admin-button--compact"
                                    >
                                      Print
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="admin-payroll-item-card__summary">
                                <div><span>Gross</span><strong>${item.gross_pay.toFixed(2)}</strong></div>
                                <div><span>Total earnings</span><strong>${item.total_earnings.toFixed(2)}</strong></div>
                                <div><span>Tax total</span><strong>${item.tax_total.toFixed(2)}</strong></div>
                                <div><span>CPP</span><strong>${item.cpp_total.toFixed(2)}</strong></div>
                                <div><span>EI</span><strong>${item.ei_deduction.toFixed(2)}</strong></div>
                                <div><span>Net</span><strong>${item.net_pay.toFixed(2)}</strong></div>
                              </div>

                              {isExpanded ? (
                                <div className="admin-payroll-item-card__detail">
                                  <div className="admin-payroll-detail-grid">
                                    <div className="admin-payroll-detail-card">
                                      <h3 className="admin-payroll-detail-card__title">Earnings</h3>
                                      <div className="admin-payroll-detail-list">
                                        <div><span>Gross</span><strong>${item.gross_pay.toFixed(2)}</strong></div>
                                        <div><span>Vacation paid now</span><strong>${item.vacation_payout.toFixed(2)}</strong></div>
                                        <div><span>Vacation accrued</span><strong>${item.vacation_accrued.toFixed(2)}</strong></div>
                                        <div><span>{item.holiday_label || "Holiday Pay"}</span><strong>${item.holiday_pay.toFixed(2)}</strong></div>
                                        <div><span>Total earnings</span><strong>${item.total_earnings.toFixed(2)}</strong></div>
                                      </div>
                                    </div>

                                    <div className="admin-payroll-detail-card">
                                      <h3 className="admin-payroll-detail-card__title">Deductions</h3>
                                      <div className="admin-payroll-detail-list">
                                        <div><span>Federal</span><strong>${item.federal_tax.toFixed(2)}</strong></div>
                                        <div><span>Provincial</span><strong>${item.provincial_tax.toFixed(2)}</strong></div>
                                        <div><span>CPP</span><strong>${item.cpp_total.toFixed(2)}</strong></div>
                                        <div><span>CPP employer</span><strong>${item.cpp_employer.toFixed(2)}</strong></div>
                                        <div><span>EI</span><strong>${item.ei_deduction.toFixed(2)}</strong></div>
                                        <div><span>EI employer</span><strong>${item.ei_employer.toFixed(2)}</strong></div>
                                        <div><span>Total deduction</span><strong>${item.total_deductions.toFixed(2)}</strong></div>
                                      </div>
                                    </div>

                                    <div className="admin-payroll-detail-card">
                                      <h3 className="admin-payroll-detail-card__title">Notes and actions</h3>
                                      {item.pay_type === "salaried" ? (
                                        <>
                                          <div className="admin-payroll-detail-list">
                                            <div><span>Monthly salary</span><strong>${Number(item.salary_base || 0).toFixed(2)}</strong></div>
                                            <div><span>Vacation pay ({item.vacation_pay_pct ?? 4}%)</span><strong>${Number(item.salary_vacation_pay || 0).toFixed(2)}</strong></div>
                                            <div><span>Bonus</span><strong>${Number(item.salary_bonus || 0).toFixed(2)}</strong></div>
                                            <div><span>Net pay</span><strong>${item.net_pay.toFixed(2)}</strong></div>
                                          </div>
                                          <div className="admin-payroll-detail-actions">
                                            {selectedPayroll.status === "draft" ? (
                                              <div className="admin-payroll-holiday-editor">
                                                <input
                                                  type="number"
                                                  min="0"
                                                  step="0.01"
                                                  value={salariedBonusInputs[item.id] ?? String(item.salary_bonus || 0)}
                                                  onChange={(event) =>
                                                    setSalariedBonusInputs((current) => ({
                                                      ...current,
                                                      [item.id]: event.target.value,
                                                    }))
                                                  }
                                                  className="admin-input admin-input--compact"
                                                  placeholder="Bonus amount"
                                                />
                                                <button
                                                  onClick={() => handleSalariedBonusSave(selectedPayroll.id, item.id)}
                                                  className="admin-button admin-button--primary admin-button--compact"
                                                >
                                                  Save bonus
                                                </button>
                                              </div>
                                            ) : (
                                              <div className="admin-note">
                                                {item.salary_bonus > 0
                                                  ? `Bonus: $${Number(item.salary_bonus).toFixed(2)}`
                                                  : "No bonus in this payroll item."}
                                              </div>
                                            )}
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="admin-payroll-detail-list">
                                            <div><span>Vacation schedule</span><strong>{getVacationScheduleLabel(item.vacation_pay_schedule)}</strong></div>
                                            <div><span>Holiday hours</span><strong>{Number(item.holiday_hours || 0).toFixed(2)} h</strong></div>
                                            <div><span>Wage rate</span><strong>${Number(item.hourly_rate || 0).toFixed(2)}</strong></div>
                                            <div><span>Net pay</span><strong>${item.net_pay.toFixed(2)}</strong></div>
                                          </div>
                                          <div className="admin-payroll-detail-actions">
                                            {selectedPayroll.status === "draft" ? (
                                              <div className="admin-payroll-holiday-editor">
                                                <input
                                                  type="text"
                                                  value={payrollHolidayInputs[item.id]?.label ?? (item.holiday_label || "Holiday Pay")}
                                                  onChange={(event) =>
                                                    setPayrollHolidayInputs((current) => ({
                                                      ...current,
                                                      [item.id]: {
                                                        amount: current[item.id]?.amount ?? String(item.holiday_pay || 0),
                                                        label: event.target.value,
                                                      },
                                                    }))
                                                  }
                                                  className="admin-input admin-input--compact"
                                                  placeholder="Family Day"
                                                />
                                                <input
                                                  type="number"
                                                  min="0"
                                                  step="0.01"
                                                  value={payrollHolidayInputs[item.id]?.amount ?? String(item.holiday_pay || 0)}
                                                  onChange={(event) =>
                                                    setPayrollHolidayInputs((current) => ({
                                                      ...current,
                                                      [item.id]: {
                                                        amount: event.target.value,
                                                        label: current[item.id]?.label ?? item.holiday_label ?? "Holiday Pay",
                                                      },
                                                    }))
                                                  }
                                                  className="admin-input admin-input--compact"
                                                  placeholder="Amount"
                                                />
                                                <button
                                                  onClick={() => handleHolidayPaySave(selectedPayroll.id, item.id)}
                                                  className="admin-button admin-button--primary admin-button--compact"
                                                >
                                                  Save holiday pay
                                                </button>
                                              </div>
                                            ) : (
                                              <div className="admin-note">
                                                {item.holiday_pay > 0
                                                  ? `${item.holiday_label || "Holiday Pay"}: $${item.holiday_pay.toFixed(2)}`
                                                  : "No holiday pay in this payroll item."}
                                              </div>
                                            )}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      {isPayslipLoading ? (
                        <div className="admin-note mt-6">Loading payslip...</div>
                      ) : null}

                      {selectedPayslip ? (
                        <div className="mt-6">
                          <PayslipPreview
                            payslip={selectedPayslip}
                            onPrint={handlePrintPayslip}
                            onClose={() => setSelectedPayslip(null)}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="admin-empty-state">
                      Select a payroll period to view the details.
                    </div>
                  )}
                </div>}
              </div>
            </div>
          </>
        ) : null}
        {activeSection === "audit-logs" ? (
          <>
          <div className="admin-panel p-6">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1.25rem" }}>
              <div>
                <h2 className="admin-panel__title">Audit logs</h2>
                <p className="admin-panel__subtitle" style={{ marginTop: "0.2rem" }}>
                  Review administrative activity by entity with filters, pagination, and CSV export.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                {auditTabs.map(tab => (
                  <button key={tab.id} onClick={() => setActiveAuditSection(tab.id)}
                    style={{ background: activeAuditSection === tab.id ? "var(--c-red)" : "rgba(74,64,64,0.07)",
                      color: activeAuditSection === tab.id ? "#fff" : "var(--c-text-muted)",
                      border: "none", borderRadius: 8, padding: "0.3rem 0.85rem",
                      fontSize: "0.78rem", fontWeight: 600, cursor: "pointer" }}>
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {activeAuditSection === "employee" ? (
              <div>

                <div className="admin-filters-grid admin-filters-grid--four mb-5">
                  <select
                    value={selectedEmployeeAuditId}
                    onChange={(event) => {
                      setSelectedEmployeeAuditId(event.target.value);
                      setEmployeeAuditFilters((current) => ({ ...current, page: 1 }));
                    }}
                    className="admin-select"
                  >
                    <option value="">All employees</option>
                    {adminEmployees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Action"
                    value={employeeAuditFilters.action}
                    onChange={(event) =>
                      setEmployeeAuditFilters((current) => ({
                        ...current,
                        action: event.target.value,
                        page: 1,
                      }))
                      }
                      className="admin-input"
                    />
                  <input
                    type="date"
                    value={employeeAuditFilters.start}
                    onChange={(event) =>
                      setEmployeeAuditFilters((current) => ({
                        ...current,
                        start: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                  <input
                    type="date"
                    value={employeeAuditFilters.end}
                    onChange={(event) =>
                      setEmployeeAuditFilters((current) => ({
                        ...current,
                        end: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                </div>

                <div className="admin-table-wrap overflow-x-auto">
                  <table className="admin-data-table w-full border-collapse text-left">
                    <thead>
                      <tr className="admin-data-table__header-row">
                        <th className="py-3 pr-4">When</th>
                        <th className="py-3 pr-4">Employee</th>
                        <th className="py-3 pr-4">Action</th>
                        <th className="py-3 pr-4">Admin</th>
                        <th className="py-3 pr-4">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employeeAuditResponse.items.length === 0 ? (
                        <tr>
                          <td className="py-4 admin-subtle-text" colSpan="5">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {employeeAuditResponse.items.map((log) => (
                        <tr key={log.id} className="align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4 font-medium">
                            {employeeNamesById[log.entity_id] || `#${log.entity_id}`}
                          </td>
                          <td className="py-4 pr-4"><AuditActionBadge action={log.action} /></td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs admin-subtle-text">
                            <AuditDiff changedFields={log.changed_fields} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <PaginationControls
                  response={employeeAuditResponse}
                  onPageChange={(nextPage) =>
                    setEmployeeAuditFilters((current) => ({ ...current, page: nextPage }))
                  }
                  onPageSizeChange={(nextPageSize) =>
                    setEmployeeAuditFilters((current) => ({
                      ...current,
                      page: 1,
                      pageSize: nextPageSize,
                    }))
                  }
                />
              </div>
            ) : null}

            {activeAuditSection === "time_record" ? (
              <div>

                <div className="admin-filters-grid mb-5">
                  <select
                    value={selectedTimeRecordAuditId}
                    onChange={(event) => {
                      setSelectedTimeRecordAuditId(event.target.value);
                      setTimeRecordAuditFilters((current) => ({ ...current, page: 1 }));
                    }}
                    className="admin-select"
                  >
                    <option value="">All records</option>
                    {recordsResponse.items.map((record) => (
                      <option key={record.id} value={record.id}>
                        #{record.id} {record.employee_name} {formatDateTime(record.recorded_at)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={timeRecordAuditFilters.employeeId}
                    onChange={(event) =>
                      setTimeRecordAuditFilters((current) => ({
                        ...current,
                        employeeId: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-select"
                  >
                    <option value="">All employees</option>
                    {adminEmployees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Action"
                    value={timeRecordAuditFilters.action}
                    onChange={(event) =>
                      setTimeRecordAuditFilters((current) => ({
                        ...current,
                        action: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                  <input
                    type="date"
                    value={timeRecordAuditFilters.start}
                    onChange={(event) =>
                      setTimeRecordAuditFilters((current) => ({
                        ...current,
                        start: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                  <input
                    type="date"
                    value={timeRecordAuditFilters.end}
                    onChange={(event) =>
                      setTimeRecordAuditFilters((current) => ({
                        ...current,
                        end: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                </div>

                <div className="admin-table-wrap overflow-x-auto">
                  <table className="admin-data-table w-full border-collapse text-left">
                    <thead>
                      <tr className="admin-data-table__header-row">
                        <th className="py-3 pr-4">When</th>
                        <th className="py-3 pr-4">Rec.</th>
                        <th className="py-3 pr-4">Employee</th>
                        <th className="py-3 pr-4">Action</th>
                        <th className="py-3 pr-4">Admin</th>
                        <th className="py-3 pr-4">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeRecordAuditResponse.items.length === 0 ? (
                        <tr>
                          <td className="py-4 admin-subtle-text" colSpan="6">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {timeRecordAuditResponse.items.map((log) => (
                        <tr key={log.id} className="align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4">#{log.entity_id}</td>
                          <td className="py-4 pr-4">
                            {log.employee_id
                              ? employeeNamesById[log.employee_id] || `#${log.employee_id}`
                              : "-"}
                          </td>
                          <td className="py-4 pr-4"><AuditActionBadge action={log.action} /></td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs admin-subtle-text">
                            <AuditDiff changedFields={log.changed_fields} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <PaginationControls
                  response={timeRecordAuditResponse}
                  onPageChange={(nextPage) =>
                    setTimeRecordAuditFilters((current) => ({ ...current, page: nextPage }))
                  }
                  onPageSizeChange={(nextPageSize) =>
                    setTimeRecordAuditFilters((current) => ({
                      ...current,
                      page: 1,
                      pageSize: nextPageSize,
                    }))
                  }
                />
              </div>
            ) : null}

            {activeAuditSection === "payroll" ? (
              <div>

                <div className="admin-filters-grid mb-5">
                  <select
                    value={selectedPayrollAuditId}
                    onChange={(event) => {
                      setSelectedPayrollAuditId(event.target.value);
                      setPayrollAuditFilters((current) => ({ ...current, page: 1 }));
                    }}
                    className="admin-select"
                  >
                    <option value="">All payrolls</option>
                    {payrollPeriods.map((payroll) => (
                      <option key={payroll.id} value={payroll.id}>
                        #{payroll.id} {payroll.start_date} to {payroll.end_date}
                      </option>
                    ))}
                  </select>
                  <select
                    value={payrollAuditFilters.employeeId}
                    onChange={(event) =>
                      setPayrollAuditFilters((current) => ({
                        ...current,
                        employeeId: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-select"
                  >
                    <option value="">All employees</option>
                    {adminEmployees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Action"
                    value={payrollAuditFilters.action}
                    onChange={(event) =>
                      setPayrollAuditFilters((current) => ({
                        ...current,
                        action: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                  <input
                    type="date"
                    value={payrollAuditFilters.start}
                    onChange={(event) =>
                      setPayrollAuditFilters((current) => ({
                        ...current,
                        start: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                  <input
                    type="date"
                    value={payrollAuditFilters.end}
                    onChange={(event) =>
                      setPayrollAuditFilters((current) => ({
                        ...current,
                        end: event.target.value,
                        page: 1,
                      }))
                    }
                    className="admin-input"
                  />
                </div>

                <div className="admin-table-wrap overflow-x-auto">
                  <table className="admin-data-table w-full border-collapse text-left">
                    <thead>
                      <tr className="admin-data-table__header-row">
                        <th className="py-3 pr-4">When</th>
                        <th className="py-3 pr-4">Payroll</th>
                        <th className="py-3 pr-4">Employee</th>
                        <th className="py-3 pr-4">Action</th>
                        <th className="py-3 pr-4">Admin</th>
                        <th className="py-3 pr-4">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollAuditResponse.items.length === 0 ? (
                        <tr>
                          <td className="py-4 admin-subtle-text" colSpan="6">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {payrollAuditResponse.items.map((log) => (
                        <tr key={log.id} className="align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4">#{log.entity_id}</td>
                          <td className="py-4 pr-4">
                            {log.employee_id
                              ? employeeNamesById[log.employee_id] || `#${log.employee_id}`
                              : "-"}
                          </td>
                          <td className="py-4 pr-4"><AuditActionBadge action={log.action} /></td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs admin-subtle-text">
                            <AuditDiff changedFields={log.changed_fields} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <PaginationControls
                  response={payrollAuditResponse}
                  onPageChange={(nextPage) =>
                    setPayrollAuditFilters((current) => ({ ...current, page: nextPage }))
                  }
                  onPageSizeChange={(nextPageSize) =>
                    setPayrollAuditFilters((current) => ({
                      ...current,
                      page: 1,
                      pageSize: nextPageSize,
                    }))
                  }
                />
              </div>
            ) : null}
          </div>
          </>
        ) : null}
        {activeSection === "payroll-review" ? (
          <PayrollReviewView adminFetch={adminFetch} payrolls={payrollPeriods || []} adminUser={adminUser} />
        ) : null}
        {activeSection === "messages" ? (
          <MessagesView
            adminFetch={adminFetch}
            employees={adminEmployees || []}
          />
        ) : null}

        {activeSection === "settings" ? (
          <SettingsView
            adminUser={adminUser}
            adminFetch={adminFetch}
            onUserUpdated={(updated) => setAdminUser(updated)}
          />
        ) : null}
        </div>
      </main>
    </div>
  );
}

export default AdminView;
