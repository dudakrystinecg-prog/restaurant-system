import { useCallback, useEffect, useMemo, useState } from "react";
import "./AdminView.css";
import "./PayrollPayslip.css";

const API_BASE_URL = "/api";
const DEFAULT_PAGE_SIZE = 10;
const ADMIN_TOKEN_KEY = "restaurant-admin-token";

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

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function toDateTimeLocalValue(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60 * 1000);
  return localDate.toISOString().slice(0, 16);
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
  const earningsRows = getPayslipEarningsRows(payslip)
    .map(
      (row) => `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td>${formatMoney(row.value)}</td></tr>`,
    )
    .join("");
  const deductionRows = getPayslipDeductionRows(payslip)
    .map(
      (row) => `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td>${formatMoney(row.value)}</td></tr>`,
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
        .header { padding: 18px 22px 10px; }
        .title { font-size: 24px; font-weight: 700; margin: 0; }
        .subtitle { color: #4b5563; font-size: 13px; margin: 4px 0 0; }
        .meta-table, .statement-table { width: calc(100% - 44px); margin: 0 22px 18px; border-collapse: collapse; }
        .meta-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 13px; vertical-align: top; }
        .meta-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #4b5563; margin-bottom: 4px; }
        .meta-value { font-size: 14px; font-weight: 600; color: #111111; }
        .statement-table th, .statement-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 14px; }
        .statement-table th { background: #e5e7eb; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; text-align: left; }
        .statement-table td:last-child, .statement-table th:last-child { text-align: right; width: 180px; }
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
          <h1 class="title">Earnings Statement</h1>
          <p class="subtitle">Restaurant payroll statement</p>
        </div>
        <table class="meta-table">
          <tr>
            <td><span class="meta-label">Employee</span><span class="meta-value">${payslip.header.employee}</span></td>
            <td><span class="meta-label">Pay Period</span><span class="meta-value">${payslip.header.pay_period}</span></td>
            <td><span class="meta-label">Wage Rate</span><span class="meta-value">${payslip.header.wage_rate}</span></td>
            <td><span class="meta-label">Pay Date</span><span class="meta-value">${payslip.header.pay_date}</span></td>
            <td><span class="meta-label">Payment Reference</span><span class="meta-value">${payslip.header.payment_reference || "-"}</span></td>
          </tr>
        </table>
        <table class="statement-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr class="section-row"><td colspan="2">Income / Earnings</td></tr>
            ${earningsRows}
            <tr class="section-row"><td colspan="2">Deductions</td></tr>
            ${deductionRows}
            <tr class="net-row"><td>Net Pay</td><td>${formatMoney(payslip.totals.net_pay)}</td></tr>
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
          <p class="subtitle">${payroll.start_date} to ${payroll.end_date} · ${payroll.pay_frequency} · ${payroll.status}</p>
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
  username,
  password,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
  error,
  isSubmitting,
}) {
  return (
    <div className="admin-login-shell">
      <div className="admin-login-card">
        <h1 className="admin-login-card__title">Admin Login</h1>
        <p className="admin-login-card__subtitle">Sign in to access the administration area.</p>

        <form onSubmit={onSubmit} className="admin-login-form">
          <label className="admin-field">
            <span className="admin-field__label">Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              className="admin-input"
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

  return (
    <div className="payslip-sheet">
      <div className="payslip-sheet__header">
        <div>
          <h3 className="payslip-sheet__title">Employee Earnings Statement</h3>
          <p className="payslip-sheet__subtitle">Printable employee-facing payroll summary.</p>
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
              ["Wage Rate", payslip.header.wage_rate],
              ["Pay Date", payslip.header.pay_date],
              ["Payment Reference", payslip.header.payment_reference || "-"],
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
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="payslip-section-row">
            <td colSpan="2">Income / Earnings</td>
          </tr>
          {earningsRows.map((row) => (
            <tr key={row.label} className={row.isTotal ? "is-total" : ""}>
              <td>{row.label}</td>
              <td>{formatMoney(row.value)}</td>
            </tr>
          ))}
          <tr className="payslip-section-row">
            <td colSpan="2">Deductions</td>
          </tr>
          {deductionRows.map((row) => (
            <tr key={row.label} className={row.isTotal ? "is-total" : ""}>
              <td>{row.label}</td>
              <td>{formatMoney(row.value)}</td>
            </tr>
          ))}
          <tr className="payslip-net-row">
            <td>Net Pay</td>
            <td>{formatMoney(payslip.totals.net_pay)}</td>
          </tr>
        </tbody>
      </table>

      {payslip.notes.accrued_vacation_balance_note ? (
        <div className="payslip-note">{payslip.notes.accrued_vacation_balance_note}</div>
      ) : null}
    </div>
  );
}

function AdminView() {
  const [adminToken, setAdminToken] = useState(getStoredAdminToken());
  const [authStatus, setAuthStatus] = useState("checking");
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "admin123" });
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
  const [payrollConfig, setPayrollConfig] = useState(null);
  const [payrollHolidayInputs, setPayrollHolidayInputs] = useState({});
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
  const [selectedPayslip, setSelectedPayslip] = useState(null);
  const [isPayslipLoading, setIsPayslipLoading] = useState(false);
  const [expandedPayrollItemId, setExpandedPayrollItemId] = useState(null);

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
      const filterQuery = buildQueryString(filters);
      const paginatedQuery = buildQueryString(filters, { page, pageSize });
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
        body: JSON.stringify(loginForm),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to authenticate.");
      }

      setStoredAdminToken(data.token);
      setAdminToken(data.token);
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
      const response = await adminFetch(`${API_BASE_URL}/admin/time-records/export${buildQueryString(filters)}`);
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

  const handleExportPayroll = async (payrollId) => {
    setError("");
    try {
      const response = await adminFetch(`${API_BASE_URL}/admin/payrolls/${payrollId}/export`);
      if (!response.ok) throw new Error("Failed to export payroll.");
      const csvBlob = await response.blob();
      const objectUrl = window.URL.createObjectURL(csvBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `payroll-${payrollId}.csv`;
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

      if (draft.defaultHourlyRate === "" || Number(draft.defaultHourlyRate) <= 0) {
        throw new Error("Hourly rate is required and must be greater than zero.");
      }

      if (!draft.defaultPayFrequency) {
        throw new Error("Pay frequency is required.");
      }

      const response = await adminFetch(`${API_BASE_URL}/admin/employees/${employeeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          ...(draft.pin?.trim() ? { pin: draft.pin.trim() } : {}),
          active: draft.active,
          default_hourly_rate: draft.defaultHourlyRate,
          default_pay_frequency: draft.defaultPayFrequency,
          start_date: draft.startDate,
          vacation_pay_schedule: draft.vacationPaySchedule,
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
      if (employeeCreateForm.defaultHourlyRate === "" || Number(employeeCreateForm.defaultHourlyRate) <= 0) {
        throw new Error("Hourly rate is required and must be greater than zero.");
      }

      if (!employeeCreateForm.defaultPayFrequency) {
        throw new Error("Pay frequency is required.");
      }

      const response = await adminFetch(`${API_BASE_URL}/admin/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: employeeCreateForm.name,
          pin: employeeCreateForm.pin,
          active: employeeCreateForm.active,
          default_hourly_rate: employeeCreateForm.defaultHourlyRate,
          default_pay_frequency: employeeCreateForm.defaultPayFrequency,
          start_date: employeeCreateForm.startDate,
          vacation_pay_schedule: employeeCreateForm.vacationPaySchedule,
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

    if (!filteredAdminEmployees.some((employee) => employee.id === selectedEmployeeId)) {
      setSelectedEmployeeId(filteredAdminEmployees[0].id);
    }
  }, [filteredAdminEmployees, selectedEmployeeId]);
  const sectionTabs = [
    { id: "employees", label: "Employees", kicker: "People" },
    { id: "time-records", label: "Time Records", kicker: "Operations" },
    { id: "payroll", label: "Payroll", kicker: "Finance" },
    { id: "audit-logs", label: "Audit Logs", kicker: "Traceability" },
  ];
  const auditTabs = [
    { id: "employee", label: "Employees", kicker: "Audit" },
    { id: "time_record", label: "Time Records", kicker: "Audit" },
    { id: "payroll", label: "Payroll", kicker: "Audit" },
  ];

  if (authStatus !== "authenticated") {
    return (
      <LoginView
        username={loginForm.username}
        password={loginForm.password}
        onUsernameChange={(value) => setLoginForm((current) => ({ ...current, username: value }))}
        onPasswordChange={(value) => setLoginForm((current) => ({ ...current, password: value }))}
        onSubmit={handleLogin}
        error={error}
        isSubmitting={isSubmitting}
      />
    );
  }

  return (
    <div className="admin-shell">
      <div className="admin-container">
        <div className="admin-hero rounded-[32px] border border-stone-200 bg-white p-8 shadow-sm">
          <div className="admin-hero__row flex items-start justify-between gap-6">
            <div className="admin-brand">
              <img src="/logo.png" alt="Sushi House Banff logo" className="admin-brand__logo" />
              <div className="admin-hero__content max-w-3xl">
                <div className="admin-eyebrow text-xs font-semibold uppercase tracking-[0.3em] text-stone-400">Administration</div>
                <h1 className="admin-hero__title mt-3 text-4xl font-bold tracking-tight">Sushi House Banff</h1>
                <p className="admin-hero__subtitle mt-3 text-base leading-7 text-stone-600">
                  Time tracking, payroll, and audit management for the restaurant team.
                </p>
              </div>
            </div>
            <div className="admin-hero__actions flex items-center gap-3">
              <button
                type="button"
                onClick={handleBackToKiosk}
                className="admin-button admin-button--secondary"
              >
                Back to kiosk
              </button>
              <button onClick={handleLogout} className="admin-button admin-button--primary">Sign out</button>
            </div>
          </div>
          <div className="admin-hero__secondary">
            <p className="admin-hero__subtitle admin-hero__subtitle--secondary">
              Manage employees, time records, payroll, and audit activity from one clean workspace.
            </p>
          </div>
          <div className="admin-hero__tabs mt-8">
            <SectionTabs tabs={sectionTabs} activeTab={activeSection} onChange={setActiveSection} />
          </div>
        </div>

        {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
        {feedback ? <div className="admin-alert admin-alert--success">{feedback}</div> : null}

        {activeSection === "employees" ? (
          <div className="admin-stack">
            <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div className="admin-panel__header admin-panel__header--split">
                <div>
                  <h2 className="admin-panel__title text-2xl font-bold">Employees</h2>
                  <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                    Keep the employee list compact and open creation only when needed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsEmployeeCreateOpen((current) => !current)}
                  className="admin-button admin-button--primary"
                >
                  {isEmployeeCreateOpen ? "Close" : "+ Add employee"}
                </button>
              </div>

              {isEmployeeCreateOpen ? (
              <form onSubmit={handleCreateEmployee} className="admin-form-stack admin-employee-create-drawer mt-6">
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
              ) : null}
            </div>
            <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div className="admin-panel__header admin-panel__header--split">
                <div>
                  <h2 className="admin-panel__title text-2xl font-bold">Employee list</h2>
                  <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                    Compact rows keep the team visible. Open one employee only when you need to edit it.
                  </p>
                </div>
                <div className="admin-note">
                  Leave the PIN field blank to keep the current secure PIN hash.
                </div>
              </div>

              <div className="admin-employees-toolbar mt-6">
                <input
                  type="text"
                  value={employeeSearch}
                  onChange={(event) => setEmployeeSearch(event.target.value)}
                  className="admin-input"
                  placeholder="Search employees"
                />
                <div className="admin-inline-notes">
                  <div className="admin-note admin-note--soft">
                    <strong>Hide / deactivate</strong>
                    <span>Removes the employee from the kiosk but keeps all history and payroll data.</span>
                  </div>
                  <div className="admin-note admin-note--danger">
                    <strong>Delete permanently</strong>
                    <span>Only available when there are no time records or payroll items for that employee.</span>
                  </div>
                </div>
              </div>

              {filteredAdminEmployees.length === 0 ? (
                <div className="admin-empty-state mt-6">
                  No employees match the current search.
                </div>
              ) : (
                <div className="admin-employee-compact-list mt-6">
                  {filteredAdminEmployees.map((employee) => {
                    const draft = employeeSettingsDrafts[employee.id] || {};
                    const isSelected = selectedEmployeeId === employee.id;

                    return (
                      <div
                        key={employee.id}
                        className={`admin-employee-compact-card ${isSelected ? "is-selected" : ""}`}
                      >
                        <div className="admin-employee-compact-card__row">
                          <div className="admin-employee-compact-card__main">
                            <div className="admin-employee-row__title">{draft.name || employee.name}</div>
                            <div className="admin-employee-row__meta">
                              <span className={`admin-status-badge ${draft.active ? "is-active" : "is-inactive"}`}>
                                {draft.active ? "Visible" : "Hidden"}
                              </span>
                              <span className="admin-employee-row__balance admin-badge admin-badge--neutral">
                                Vacation ${Number(draft.accruedVacationBalance ?? 0).toFixed(2)}
                              </span>
                            </div>
                          </div>
                          <div className="admin-employee-compact-card__actions">
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedEmployeeId((current) =>
                                  current === employee.id ? null : employee.id,
                                )
                              }
                              className="admin-button admin-button--secondary admin-button--compact"
                            >
                              {isSelected ? "Close" : "Edit"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteEmployee(employee)}
                              className="admin-button admin-button--danger admin-button--compact"
                              disabled={!employee.can_delete}
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        {isSelected ? (
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
                              <label className="admin-field">
                                <span className="admin-field__label">Employee name</span>
                                <input
                                  type="text"
                                  value={draft.name ?? ""}
                                  onChange={(event) =>
                                    setEmployeeSettingsDrafts((current) => ({
                                      ...current,
                                      [employee.id]: {
                                        ...current[employee.id],
                                        name: event.target.value,
                                      },
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
                                      [employee.id]: {
                                        ...current[employee.id],
                                        pin: event.target.value,
                                      },
                                    }))
                                  }
                                  className="admin-input"
                                  placeholder="Leave blank to keep current PIN"
                                />
                              </label>

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
                                      [employee.id]: {
                                        ...current[employee.id],
                                        defaultHourlyRate: event.target.value,
                                      },
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
                                      [employee.id]: {
                                        ...current[employee.id],
                                        defaultPayFrequency: event.target.value,
                                      },
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

                              <label className="admin-field">
                                <span className="admin-field__label">Start date</span>
                                <input
                                  type="date"
                                  value={draft.startDate ?? ""}
                                  onChange={(event) =>
                                    setEmployeeSettingsDrafts((current) => ({
                                      ...current,
                                      [employee.id]: {
                                        ...current[employee.id],
                                        startDate: event.target.value,
                                      },
                                    }))
                                  }
                                  className="admin-input"
                                />
                              </label>

                              <label className="admin-field">
                                <span className="admin-field__label">Vacation pay schedule</span>
                                <select
                                  value={draft.vacationPaySchedule ?? "monthly"}
                                  onChange={(event) =>
                                    setEmployeeSettingsDrafts((current) => ({
                                      ...current,
                                      [employee.id]: {
                                        ...current[employee.id],
                                        vacationPaySchedule: event.target.value,
                                      },
                                    }))
                                  }
                                  className="admin-select"
                                >
                                  <option value="monthly">Monthly payout</option>
                                  <option value="accrued">Accrued balance</option>
                                </select>
                              </label>
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
                                onClick={() => handleDeleteEmployee(employee)}
                                className="admin-button admin-button--danger"
                                disabled={!employee.can_delete}
                              >
                                Delete permanently
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {activeSection === "time-records" ? (
          <>
            <SummaryCards summary={summary} />

            <div className="admin-layout-two-column">
              <div className="admin-stack">
                <div className="admin-panel admin-panel--sidebar rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">
                        {formMode === "edit" ? "Edit clock record" : "Add clock record"}
                      </h2>
                      <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
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

                    <input
                      type="datetime-local"
                      value={formState.recordedAt}
                      onChange={(event) =>
                        setFormState((current) => ({ ...current, recordedAt: event.target.value }))
                      }
                      className="admin-input"
                      required
                    />

                    <input
                      type="text"
                      value={formState.kioskId}
                      onChange={(event) =>
                        setFormState((current) => ({ ...current, kioskId: event.target.value }))
                      }
                      placeholder="Optional kiosk ID"
                      className="admin-input"
                    />

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

                <div className="admin-panel admin-panel--sidebar rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">
                        {manualHoursMode === "edit" ? "Edit manual hours" : "Add manual hours"}
                      </h2>
                      <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
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

              <div className="admin-stack">
                <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">Filters</h2>
                      <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                        Filter history by employee, period, and record status.
                      </p>
                    </div>
                    <span className="admin-badge admin-badge--success">
                      {adminConfig?.restoreEnabled ? "Restore enabled" : "Restore unavailable"}
                    </span>
                  </div>

                  <div className="admin-filters-grid mt-6">
                    <select
                      value={filters.employeeId}
                      onChange={(event) => {
                        setPage(1);
                        setFilters((current) => ({ ...current, employeeId: event.target.value }));
                      }}
                      className="admin-select"
                    >
                      <option value="">All employees</option>
                      {employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.name}
                        </option>
                      ))}
                    </select>

                    <input
                      type="date"
                      value={filters.start}
                      onChange={(event) => {
                        setPage(1);
                        setFilters((current) => ({ ...current, start: event.target.value }));
                      }}
                      className="admin-input"
                    />

                    <input
                      type="date"
                      value={filters.end}
                      onChange={(event) => {
                        setPage(1);
                        setFilters((current) => ({ ...current, end: event.target.value }));
                      }}
                      className="admin-input"
                    />

                    <select
                      value={filters.recordStatus}
                      onChange={(event) => {
                        setPage(1);
                        setFilters((current) => ({ ...current, recordStatus: event.target.value }));
                      }}
                      className="admin-select"
                    >
                      <option value="active">Active</option>
                      <option value="deleted">Deleted</option>
                      <option value="all">All</option>
                    </select>

                    <div className="admin-actions-row">
                      <button
                        onClick={() => {
                          setPage(1);
                          setPageSize(DEFAULT_PAGE_SIZE);
                          setFilters({
                            employeeId: "",
                            start: "",
                            end: "",
                            recordStatus: "active",
                          });
                        }}
                        className="admin-button admin-button--secondary"
                      >
                        Clear
                      </button>
                      <button
                        onClick={handleExport}
                        className="admin-button admin-button--success"
                      >
                        Export CSV
                      </button>
                    </div>
                  </div>
                </div>

                <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">Summary by employee</h2>
                      <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                        {selectedEmployeeSummary
                          ? `Selected employee: ${selectedEmployeeSummary.employee_name}`
                          : "Review totals and payroll-ready hours for the selected period."}
                      </p>
                    </div>
                    {isLoading ? <span className="admin-subtle-text">Loading...</span> : null}
                  </div>

                  <div className="admin-table-wrap mt-6 overflow-x-auto">
                    <table className="admin-data-table w-full border-collapse text-left">
                      <thead>
                        <tr className="border-b border-stone-200 text-stone-600">
                          <th className="py-3 pr-4">Employee</th>
                          <th className="py-3 pr-4">Check-ins</th>
                          <th className="py-3 pr-4">Check-outs</th>
                          <th className="py-3 pr-4">Records</th>
                          <th className="py-3 pr-4">Hours</th>
                          <th className="py-3 pr-4">Completed shifts</th>
                          <th className="py-3 pr-4">Open shifts</th>
                          <th className="py-3 pr-4">Payroll-ready</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.employees.length === 0 && !isLoading ? (
                          <tr>
                            <td className="py-4 text-stone-500" colSpan="8">
                              No data found for the selected filters.
                            </td>
                          </tr>
                        ) : null}
                        {summary.employees.map((item) => (
                          <tr key={item.employee_id} className="border-b border-stone-100">
                            <td className="py-4 pr-4 font-medium">{item.employee_name}</td>
                            <td className="py-4 pr-4">{item.check_ins}</td>
                            <td className="py-4 pr-4">{item.check_outs}</td>
                            <td className="py-4 pr-4">{item.total_records}</td>
                            <td className="py-4 pr-4">{item.total_hours.toFixed(2)} h</td>
                            <td className="py-4 pr-4">{item.complete_shifts}</td>
                            <td className="py-4 pr-4">{item.open_shifts}</td>
                            <td className="py-4 pr-4">{item.payroll_ready_hours.toFixed(2)} h</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div className="admin-panel__header admin-panel__header--split">
                <div>
                  <h2 className="admin-panel__title text-2xl font-bold">Time Records</h2>
                  {!isLoading ? (
                    <p className="admin-panel__subtitle mt-1 text-sm text-stone-500">{recordsResponse.total} total records</p>
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

              <div className="admin-table-wrap overflow-x-auto">
                <table className="admin-data-table w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-600">
                      <th className="py-3 pr-4">Date and time</th>
                      <th className="py-3 pr-4">Employee</th>
                      <th className="py-3 pr-4">Type</th>
                      <th className="py-3 pr-4">Details</th>
                      <th className="py-3 pr-4">Origin</th>
                      <th className="py-3 pr-4">Updated at</th>
                      <th className="py-3 pr-4">Status</th>
                      <th className="py-3 pr-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsResponse.items.length === 0 && !isLoading ? (
                      <tr>
                        <td className="py-4 text-stone-500" colSpan="8">
                          No records found for the selected filters.
                        </td>
                      </tr>
                    ) : null}
                    {recordsResponse.items.map((record) => (
                      <tr key={record.id} className="border-b border-stone-100">
                        <td className="py-4 pr-4">{formatDateTime(record.recorded_at)}</td>
                        <td className="py-4 pr-4 font-medium">{record.employee_name}</td>
                        <td className="py-4 pr-4">{formatTimeRecordType(record)}</td>
                        <td className="py-4 pr-4">
                          {record.entry_mode === "manual"
                            ? record.note || "-"
                            : record.kiosk_id || "-"}
                        </td>
                        <td className="py-4 pr-4">
                          {record.entry_mode === "manual"
                            ? "manual hours"
                            : record.created_manually
                              ? "manual clock"
                              : "kiosk"}
                        </td>
                        <td className="py-4 pr-4">{formatDateTime(record.updated_at)}</td>
                        <td className="py-4 pr-4">{record.deleted_at ? "deleted" : "active"}</td>
                        <td className="py-4 pr-4">
                          <div className="flex gap-2">
                            {!record.deleted_at ? (
                              <>
                                <button
                                  onClick={() => handleEdit(record)}
                                  className="admin-button admin-button--secondary admin-button--compact"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleDelete(record)}
                                  className="admin-button admin-button--danger admin-button--compact"
                                >
                                  Delete
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleRestore(record)}
                                className="admin-button admin-button--success admin-button--compact"
                              >
                                Restore
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              <div className="admin-panel admin-panel--sidebar rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                <h2 className="admin-panel__title text-2xl font-bold">Generate payroll</h2>
                <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                  Create a payroll period with regular earnings, vacation pay, holiday pay, deductions, and net pay.
                </p>

                {payrollConfig ? (
                  <div className="admin-note mt-6">
                    <div>
                      Overtime: {payrollConfig.overtime_rule.type} above{" "}
                      {payrollConfig.overtime_rule.regularHoursPerDay}h per day at{" "}
                      {payrollConfig.overtime_rule.overtimeMultiplier}x
                    </div>
                    {payrollConfig.holiday_pay_enabled ? (
                      <div className="mt-1">
                        Holiday pay: {payrollConfig.holiday_pay_rule.description}
                      </div>
                    ) : null}
                    {payrollConfig.vacation_pay_enabled ? (
                      <div className="mt-1">
                        Vacation pay: {payrollConfig.vacation_pay_rule.description}
                      </div>
                    ) : null}
                    {payrollConfig.payroll_jurisdiction ? (
                      <div className="mt-1">
                        Jurisdiction: {payrollConfig.payroll_jurisdiction.country}/
                        {payrollConfig.payroll_jurisdiction.province}{" "}
                        {payrollConfig.payroll_jurisdiction.tax_year},{" "}
                        {payrollConfig.payroll_jurisdiction.pay_frequency} (
                        {payrollConfig.payroll_jurisdiction.pay_periods_per_year} periods/year)
                      </div>
                    ) : null}
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
                <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <h2 className="admin-panel__title text-2xl font-bold">Generated periods</h2>
                  <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
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
                              {payroll.start_date} to {payroll.end_date}
                            </div>
                            <div className="admin-payroll-period-card__meta">
                              {getPayFrequencyLabel(payroll.pay_frequency, payrollConfig)}
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

                <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div className="admin-panel__header admin-panel__header--split">
                    <div>
                      <h2 className="admin-panel__title text-2xl font-bold">Payroll details</h2>
                      <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                        Review payroll totals and employee-level payout details before approval.
                      </p>
                    </div>
                    <div className="admin-actions-row">
                      {selectedPayroll ? (
                        <button
                          onClick={() => handleExportPayroll(selectedPayroll.id)}
                          className="admin-button admin-button--secondary admin-button--compact"
                        >
                          Export team CSV
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
                          <div className="text-sm text-stone-500">Period</div>
                          <div className="font-semibold">
                            {selectedPayroll.start_date} to {selectedPayroll.end_date}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Status</div>
                          <div className="font-semibold">{selectedPayroll.status}</div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Frequency</div>
                          <div className="font-semibold">
                            {getPayFrequencyLabel(selectedPayroll.pay_frequency, payrollConfig)} ({selectedPayroll.pay_periods_per_year}/year)
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Pay date</div>
                          <div className="font-semibold">
                            {selectedPayroll.pay_date || selectedPayroll.end_date}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Gross</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_gross_pay.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Total earnings</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_earnings.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Vacation paid now</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_vacation_payout.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">Vacation accrued</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_vacation_accrued.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">CPP employer</div>
                          <div className="font-semibold">
                            ${selectedPayroll.totals.total_cpp_employer.toFixed(2)}
                          </div>
                        </div>
                        <div className="admin-metric-card">
                          <div className="text-sm text-stone-500">EI employer</div>
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
                                    {getVacationScheduleLabel(item.vacation_pay_schedule)}
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
                </div>
              </div>
            </div>
          </>
        ) : null}
        {activeSection === "audit-logs" ? (
          <>
            <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div className="admin-panel__header admin-panel__header--split">
                <div>
                  <h2 className="admin-panel__title text-2xl font-bold">Audit logs</h2>
                  <p className="admin-panel__subtitle mt-1 text-sm text-stone-600">
                    Review administrative activity by entity with filters, pagination, and CSV export.
                  </p>
                </div>
                <div className="admin-note">
                  Newest events first
                </div>
              </div>

              <div className="mt-6">
                <SectionTabs
                  tabs={auditTabs}
                  activeTab={activeAuditSection}
                  onChange={setActiveAuditSection}
                  columnsClassName="grid-cols-3"
                />
              </div>
            </div>

            {activeAuditSection === "employee" ? (
              <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                <div className="admin-panel__header admin-panel__header--split">
                  <div>
                    <h2 className="text-2xl font-bold">Employee audit</h2>
                    <p className="mt-1 text-sm text-stone-600">Creation, edits, activation, and deactivation events.</p>
                  </div>
                  <button
                    onClick={() => handleExportAudit("employee")}
                    className="admin-button admin-button--secondary"
                  >
                    Export CSV
                  </button>
                </div>

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
                      <tr className="border-b border-stone-200 text-stone-600">
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
                          <td className="py-4 text-stone-500" colSpan="5">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {employeeAuditResponse.items.map((log) => (
                        <tr key={log.id} className="border-b border-stone-100 align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4 font-medium">
                            {employeeNamesById[log.entity_id] || `#${log.entity_id}`}
                          </td>
                          <td className="py-4 pr-4">{log.action}</td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs text-stone-600">
                            <pre className="whitespace-pre-wrap">
                              {JSON.stringify(log.changed_fields, null, 2)}
                            </pre>
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
              <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                <div className="admin-panel__header admin-panel__header--split">
                  <div>
                    <h2 className="text-2xl font-bold">Time record audit</h2>
                    <p className="mt-1 text-sm text-stone-600">
                      Manual creation, editing, deletion, and restoration events.
                    </p>
                  </div>
                  <button
                    onClick={() => handleExportAudit("time_record")}
                    className="admin-button admin-button--secondary"
                  >
                    Export CSV
                  </button>
                </div>

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
                      <tr className="border-b border-stone-200 text-stone-600">
                        <th className="py-3 pr-4">When</th>
                        <th className="py-3 pr-4">Record</th>
                        <th className="py-3 pr-4">Employee</th>
                        <th className="py-3 pr-4">Action</th>
                        <th className="py-3 pr-4">Admin</th>
                        <th className="py-3 pr-4">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeRecordAuditResponse.items.length === 0 ? (
                        <tr>
                          <td className="py-4 text-stone-500" colSpan="6">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {timeRecordAuditResponse.items.map((log) => (
                        <tr key={log.id} className="border-b border-stone-100 align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4">#{log.entity_id}</td>
                          <td className="py-4 pr-4">
                            {log.employee_id
                              ? employeeNamesById[log.employee_id] || `#${log.employee_id}`
                              : "-"}
                          </td>
                          <td className="py-4 pr-4">{log.action}</td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs text-stone-600">
                            <pre className="whitespace-pre-wrap">
                              {JSON.stringify(log.changed_fields, null, 2)}
                            </pre>
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
              <div className="admin-panel rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
                <div className="admin-panel__header admin-panel__header--split">
                  <div>
                    <h2 className="text-2xl font-bold">Payroll audit</h2>
                    <p className="mt-1 text-sm text-stone-600">
                      Generation, approval, and payroll adjustments.
                    </p>
                  </div>
                  <button
                    onClick={() => handleExportAudit("payroll")}
                    className="admin-button admin-button--secondary"
                  >
                    Export CSV
                  </button>
                </div>

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
                      <tr className="border-b border-stone-200 text-stone-600">
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
                          <td className="py-4 text-stone-500" colSpan="6">
                            No audit events found.
                          </td>
                        </tr>
                      ) : null}
                      {payrollAuditResponse.items.map((log) => (
                        <tr key={log.id} className="border-b border-stone-100 align-top">
                          <td className="py-4 pr-4">{formatDateTime(log.changed_at)}</td>
                          <td className="py-4 pr-4">#{log.entity_id}</td>
                          <td className="py-4 pr-4">
                            {log.employee_id
                              ? employeeNamesById[log.employee_id] || `#${log.employee_id}`
                              : "-"}
                          </td>
                          <td className="py-4 pr-4">{log.action}</td>
                          <td className="py-4 pr-4">{log.admin_user || "-"}</td>
                          <td className="py-4 pr-4 text-xs text-stone-600">
                            <pre className="whitespace-pre-wrap">
                              {JSON.stringify(log.changed_fields, null, 2)}
                            </pre>
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
          </>
        ) : null}
      </div>
    </div>
  );
}

export default AdminView;
