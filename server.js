const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { verifySecret } = require("./security");
const config = require("./config");
const {
  initializeDatabase,
  listEmployees,
  listAdminEmployees,
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
} = require("./db");

const app = express();
const PORT = config.port;
const ADMIN_USERNAME = config.admin.username;
const ADMIN_PASSWORD_HASH = config.admin.passwordHash;
const ADMIN_SESSION_TTL_MS = config.admin.sessionTtlMs;
const ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS =
  config.admin.loginRateLimitMaxAttempts;
const ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS = config.admin.loginRateLimitWindowMs;
const AUDIT_LOG_RETENTION_DAYS = config.audit.retentionDays;
const frontendBuildPath = config.frontendBuildPath;
const frontendIndexPath = path.join(frontendBuildPath, "index.html");
const sharedAssetsPath = path.join(__dirname, "assets");
const hasFrontendBuild = fs.existsSync(frontendIndexPath);

initializeDatabase();
app.set("trust proxy", true);

function normalizeRecordType(type) {
  if (type === "in") {
    return "check-in";
  }

  if (type === "out") {
    return "check-out";
  }

  return type;
}

function isValidRecordType(type) {
  return ["check-in", "check-out", "in", "out"].includes(type);
}

function isValidRecordedAt(value) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

function isValidPeriodDate(value) {
  return Boolean(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function isValidManualHoursDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
    && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function normalizeWorkedHours(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : Number.NaN;
}

function normalizeHolidayMultiplier(value) {
  if (value === undefined || value === null || value === "") {
    return 1.5;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : Number.NaN;
}

function normalizeRecordStatus(value) {
  return ["active", "deleted", "all"].includes(value) ? value : "active";
}

function normalizePayFrequency(value) {
  return PAY_FREQUENCIES[value] ? value : null;
}

function normalizeEmployeeActive(value) {
  return value ? 1 : 0;
}

function isValidStartDate(value) {
  return Boolean(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function normalizeVacationPaySchedule(value) {
  return VACATION_PAY_SCHEDULES[value]
    ? value
    : DEFAULT_VACATION_PAY_SCHEDULE;
}

function normalizeAuditAction(value) {
  return value ? String(value).trim() : null;
}

function normalizeIsoDateFilter(value, endOfDay = false) {
  if (!value) {
    return null;
  }

  const normalizedValue = String(value);

  if (normalizedValue.includes("T")) {
    return isValidRecordedAt(normalizedValue) ? normalizedValue : null;
  }

  const suffix = endOfDay ? "T23:59:59" : "T00:00:00";
  return isValidRecordedAt(`${normalizedValue}${suffix}`)
    ? `${normalizedValue}${suffix}`
    : null;
}

function normalizeAuditPagination(page, pageSize) {
  const normalizedPage = Number(page) > 0 ? Number(page) : 1;
  const normalizedPageSize = Math.min(
    Math.max(Number(pageSize) || DEFAULT_AUDIT_PAGE_SIZE, 1),
    MAX_AUDIT_PAGE_SIZE,
  );

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function getRemainingLoginLockMs(ipAddress) {
  const attempt = getAdminLoginAttempt(ipAddress);

  if (!attempt) {
    return 0;
  }

  const windowStartMs = new Date(attempt.window_start).getTime();

  if (Date.now() - windowStartMs > ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS) {
    clearAdminLoginAttempt(ipAddress);
    return 0;
  }

  if (Number(attempt.attempts_count) < ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
    return 0;
  }

  return ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS - (Date.now() - windowStartMs);
}

function registerFailedLoginAttempt(ipAddress) {
  const current = getAdminLoginAttempt(ipAddress);
  const now = new Date().toISOString();

  if (
    !current ||
    Date.now() - new Date(current.window_start).getTime() >
      ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS
  ) {
    upsertAdminLoginAttempt({
      ipAddress,
      attemptsCount: 1,
      windowStart: now,
      updatedAt: now,
    });
    return;
  }

  upsertAdminLoginAttempt({
    ipAddress,
    attemptsCount: Number(current.attempts_count) + 1,
    windowStart: current.window_start,
    updatedAt: now,
  });
}

function clearFailedLoginAttempts(ipAddress) {
  clearAdminLoginAttempt(ipAddress);
}

function getAdminToken(req) {
  const authorizationHeader = req.headers.authorization || "";
  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function requireAdminAuth(req, res, next) {
  const token = getAdminToken(req);

  cleanupExpiredAdminSessions();

  if (!token) {
    return res.status(401).json({
      error: "Nao autenticado como admin.",
    });
  }

  const session = getAdminSession(token);

  if (!session || Date.now() > new Date(session.expires_at).getTime()) {
    deleteAdminSession(token);
    return res.status(401).json({
      error: "Sua sessao admin expirou.",
    });
  }

  req.adminSession = {
    username: session.username,
    createdAt: session.created_at,
    expiresAt: new Date(session.expires_at).getTime(),
  };
  req.adminToken = token;
  next();
}

function buildAuditFilters(req, entityType) {
  const { page, pageSize } = normalizeAuditPagination(
    req.query.page,
    req.query.pageSize,
  );

  return {
    entityType,
    entityId:
      req.query.record_id || req.query.payroll_id
        ? Number(req.query.record_id || req.query.payroll_id)
        : null,
    employeeId: req.query.employee_id ? Number(req.query.employee_id) : null,
    action: normalizeAuditAction(req.query.action),
    startDate: normalizeIsoDateFilter(req.query.start),
    endDate: normalizeIsoDateFilter(req.query.end, true),
    page,
    pageSize,
  };
}

function sendAuditCsv(res, fileName, logs) {
  const escapeCsvValue = (value) => {
    if (value === null || value === undefined) {
      return "";
    }

    return `"${String(value).replace(/"/g, '""')}"`;
  };

  const header = [
    "id",
    "entity_type",
    "entity_id",
    "employee_id",
    "action",
    "changed_at",
    "admin_user",
    "changed_fields",
  ];
  const rows = logs.map((log) =>
    [
      log.id,
      log.entity_type,
      log.entity_id,
      log.employee_id ?? "",
      log.action,
      log.changed_at,
      log.admin_user || "",
      log.changed_fields ? JSON.stringify(log.changed_fields) : "",
    ]
      .map(escapeCsvValue)
      .join(","),
  );
  const csv = [header.join(","), ...rows].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`,
  );
  res.send(csv);
}

app.use(
  cors({
    origin: config.isProduction ? true : config.frontendOrigin,
  }),
);
app.use(express.json());

if (hasFrontendBuild) {
  app.use(express.static(frontendBuildPath));
}

if (fs.existsSync(sharedAssetsPath)) {
  app.use("/assets", express.static(sharedAssetsPath));
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    environment: config.isProduction ? "production" : "development",
    databasePath,
    frontendBuildAvailable: hasFrontendBuild,
  });
});

app.get("/api/employees", (_req, res) => {
  res.json(listEmployees());
});

app.get("/api/admin/employees", requireAdminAuth, (_req, res) => {
  res.json(listAdminEmployees());
});

app.get("/api/admin/employees/audit", requireAdminAuth, (req, res) => {
  res.json(
    listAuditLogsPaginated({
      ...buildAuditFilters(req, "employee"),
      entityId: req.query.employee_id ? Number(req.query.employee_id) : null,
      employeeId: req.query.employee_id ? Number(req.query.employee_id) : null,
    }),
  );
});

app.get("/api/admin/employees/audit/export", requireAdminAuth, (req, res) => {
  sendAuditCsv(
    res,
    "employee-audit.csv",
    listAuditLogsForExport({
      ...buildAuditFilters(req, "employee"),
      entityId: req.query.employee_id ? Number(req.query.employee_id) : null,
      employeeId: req.query.employee_id ? Number(req.query.employee_id) : null,
    }),
  );
});

app.get("/api/admin/time-records/audit", requireAdminAuth, (req, res) => {
  res.json(
    listAuditLogsPaginated(buildAuditFilters(req, "time_record")),
  );
});

app.get("/api/admin/time-records/audit/export", requireAdminAuth, (req, res) => {
  sendAuditCsv(
    res,
    "time-record-audit.csv",
    listAuditLogsForExport(buildAuditFilters(req, "time_record")),
  );
});

app.get("/api/admin/payrolls/audit", requireAdminAuth, (req, res) => {
  res.json(
    listAuditLogsPaginated(buildAuditFilters(req, "payroll")),
  );
});

app.get("/api/admin/payrolls/audit/export", requireAdminAuth, (req, res) => {
  sendAuditCsv(
    res,
    "payroll-audit.csv",
    listAuditLogsForExport(buildAuditFilters(req, "payroll")),
  );
});

app.get("/api/admin/audit/config", requireAdminAuth, (_req, res) => {
  res.json({
    retention_days: AUDIT_LOG_RETENTION_DAYS,
    page_size_default: DEFAULT_AUDIT_PAGE_SIZE,
    page_size_max: MAX_AUDIT_PAGE_SIZE,
    storage: "sqlite",
    supported_filters: [
      "entity_type",
      "action",
      "employee_id",
      "start",
      "end",
      "page",
      "pageSize",
    ],
  });
});

app.post("/api/admin/employees", requireAdminAuth, (req, res) => {
  const {
    name,
    pin,
    active,
    default_hourly_rate: defaultHourlyRate,
    default_pay_frequency: defaultPayFrequency,
    start_date: startDate,
    vacation_pay_schedule: vacationPaySchedule,
  } = req.body;

  if (!name || !String(name).trim() || !pin || !String(pin).trim()) {
    return res.status(400).json({
      error: "name and pin are required.",
    });
  }

  if (!isValidStartDate(startDate)) {
    return res.status(400).json({
      error: "start_date is required in YYYY-MM-DD format.",
    });
  }

  if (defaultHourlyRate === null || defaultHourlyRate === "" || Number(defaultHourlyRate) <= 0) {
    return res.status(400).json({
      error: "default_hourly_rate is required and must be greater than zero.",
    });
  }

  if (!defaultPayFrequency || !normalizePayFrequency(defaultPayFrequency)) {
    return res.status(400).json({
      error: "default_pay_frequency is required.",
    });
  }

  const employee = createEmployee({
    name: String(name).trim(),
    pin: String(pin).trim(),
    active: normalizeEmployeeActive(active !== false),
    defaultHourlyRate:
      Number(defaultHourlyRate),
    defaultPayFrequency:
      normalizePayFrequency(defaultPayFrequency),
    startDate: String(startDate),
    vacationPaySchedule: normalizeVacationPaySchedule(vacationPaySchedule),
    adminUser: req.adminSession.username,
  });

  res.status(201).json(employee);
});

app.put("/api/admin/employees/:id", requireAdminAuth, (req, res) => {
  const employeeId = Number(req.params.id);

  if (!employeeId) {
    return res.status(400).json({ error: "id invalido." });
  }

  const employee = findEmployeeById(employeeId);

  if (!employee) {
    return res.status(404).json({ error: "Funcionario nao encontrado." });
  }

  const {
    name,
    pin,
    active,
    default_hourly_rate: defaultHourlyRate,
    default_pay_frequency: defaultPayFrequency,
    start_date: startDate,
    vacation_pay_schedule: vacationPaySchedule,
  } = req.body;

  if (startDate !== undefined && startDate !== null && startDate !== "" && !isValidStartDate(startDate)) {
    return res.status(400).json({
      error: "start_date must use YYYY-MM-DD format.",
    });
  }

  if (
    defaultHourlyRate !== undefined &&
    (defaultHourlyRate === null || defaultHourlyRate === "" || Number(defaultHourlyRate) <= 0)
  ) {
    return res.status(400).json({
      error: "default_hourly_rate is required and must be greater than zero.",
    });
  }

  if (
    defaultPayFrequency !== undefined &&
    (!defaultPayFrequency || !normalizePayFrequency(defaultPayFrequency))
  ) {
    return res.status(400).json({
      error: "default_pay_frequency is required.",
    });
  }

  const updatedEmployee = updateEmployeePayrollSettings({
    employeeId,
    name: name === undefined ? null : String(name).trim(),
    pin:
      pin === undefined || pin === null || String(pin).trim() === ""
        ? null
        : String(pin).trim(),
    active: active === undefined ? null : normalizeEmployeeActive(active),
    defaultHourlyRate:
      defaultHourlyRate === undefined ? null : Number(defaultHourlyRate),
    defaultPayFrequency:
      defaultPayFrequency === undefined ? null : normalizePayFrequency(defaultPayFrequency),
    startDate:
      startDate === undefined || startDate === null || String(startDate).trim() === ""
        ? null
        : String(startDate),
    vacationPaySchedule:
      vacationPaySchedule === undefined || vacationPaySchedule === null || vacationPaySchedule === ""
        ? null
        : normalizeVacationPaySchedule(vacationPaySchedule),
    adminUser: req.adminSession.username,
  });

  res.json(updatedEmployee);
});

app.delete("/api/admin/employees/:id", requireAdminAuth, (req, res) => {
  const employeeId = Number(req.params.id);

  if (!employeeId) {
    return res.status(400).json({ error: "Invalid employee id." });
  }

  const employee = findEmployeeById(employeeId);

  if (!employee) {
    return res.status(404).json({ error: "Employee not found." });
  }

  try {
    const result = deleteEmployee(employeeId, req.adminSession.username);
    return res.json(result);
  } catch (error) {
    if (error.code === "EMPLOYEE_HAS_DEPENDENCIES") {
      return res.status(409).json({
        error: error.message,
        dependencies: error.details || getEmployeeDependencySummary(employeeId),
      });
    }

    return res.status(500).json({
      error: "Failed to delete employee.",
    });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ipAddress = getRequestIp(req);
  cleanupAdminLoginAttempts(
    new Date(Date.now() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS).toISOString(),
  );
  const remainingLockMs = getRemainingLoginLockMs(ipAddress);

  if (remainingLockMs > 0) {
    return res.status(429).json({
      error: "Muitas tentativas de login. Tente novamente em alguns minutos.",
      retry_after_seconds: Math.ceil(remainingLockMs / 1000),
    });
  }

  if (
    username !== ADMIN_USERNAME ||
    !verifySecret(password, ADMIN_PASSWORD_HASH)
  ) {
    registerFailedLoginAttempt(ipAddress);
    return res.status(401).json({
      error: "Credenciais invalidas.",
    });
  }

  clearFailedLoginAttempts(ipAddress);
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  const session = createAdminSession({
    token,
    username,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ADMIN_SESSION_TTL_MS).toISOString(),
  });

  return res.json({
    success: true,
    token,
    user: {
      username,
    },
    expires_at: session.expires_at,
  });
});

app.get("/api/admin/session", requireAdminAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: {
      username: req.adminSession.username,
    },
    expires_at: new Date(req.adminSession.expiresAt).toISOString(),
  });
});

app.post("/api/admin/logout", requireAdminAuth, (req, res) => {
  const token = getAdminToken(req);

  if (token) {
    deleteAdminSession(token);
  }

  res.json({ success: true });
});

app.get("/api/admin/time-records", requireAdminAuth, (req, res) => {
  const {
    employee_id: employeeId,
    start,
    end,
    page,
    pageSize,
    record_status: recordStatus,
  } = req.query;

  const result = listTimeRecordsPaginated({
    employeeId: employeeId ? Number(employeeId) : null,
    startDate: start || null,
    endDate: end || null,
    recordStatus: normalizeRecordStatus(recordStatus),
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 10,
  });

  res.json(result);
});

app.get("/api/admin/time-records/export", requireAdminAuth, (req, res) => {
  const {
    employee_id: employeeId,
    start,
    end,
    record_status: recordStatus,
  } = req.query;

  const records = listTimeRecords({
    employeeId: employeeId ? Number(employeeId) : null,
    startDate: start || null,
    endDate: end || null,
    recordStatus: normalizeRecordStatus(recordStatus),
  });

  const escapeCsvValue = (value) => {
    if (value === null || value === undefined) {
      return "";
    }

    const stringValue = String(value).replace(/"/g, '""');
    return `"${stringValue}"`;
  };

  const header = [
    "employee_id",
    "employee_name",
    "type",
    "recorded_at",
    "kiosk_id",
    "entry_mode",
    "manual_category",
    "worked_hours",
    "note",
    "holiday_label",
    "holiday_multiplier",
    "created_manually",
    "updated_at",
    "deleted_at",
  ];

  const rows = records.map((record) =>
    [
      record.employee_id,
      record.employee_name,
      record.entry_mode === "manual"
        ? record.manual_category === "holiday"
          ? `${record.holiday_label || "Holiday Pay"} - ${Number(record.worked_hours || 0).toFixed(2)} h @ ${Number(record.holiday_multiplier || 1.5).toFixed(2)}x`
          : `Manual hours (no overtime) - ${Number(record.worked_hours || 0).toFixed(2)} h`
        : record.type,
      record.recorded_at,
      record.kiosk_id || "",
      record.entry_mode,
      record.manual_category || "",
      record.worked_hours || "",
      record.note || "",
      record.holiday_label || "",
      record.holiday_multiplier || "",
      record.created_manually ? "manual" : "kiosk",
      record.updated_at || "",
      record.deleted_at || "",
    ]
      .map(escapeCsvValue)
      .join(","),
  );

  const csv = [header.join(","), ...rows].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="time-records.csv"',
  );
  res.send(csv);
});

app.get("/api/admin/time-summary", requireAdminAuth, (req, res) => {
  const {
    employee_id: employeeId,
    start,
    end,
    record_status: recordStatus,
  } = req.query;

  const summary = summarizeTimeRecords({
    employeeId: employeeId ? Number(employeeId) : null,
    startDate: start || null,
    endDate: end || null,
    recordStatus: normalizeRecordStatus(recordStatus),
  });

  res.json(summary);
});

app.get("/api/admin/time-records/config", requireAdminAuth, (_req, res) => {
  res.json({
    manualEditingEnabled: true,
    restoreEnabled: true,
    supportedActions: ["create", "update", "delete", "restore"],
  });
});

app.get("/api/admin/payrolls", requireAdminAuth, (_req, res) => {
  res.json(listPayrollPeriods());
});

app.get("/api/admin/payrolls/config", requireAdminAuth, (_req, res) => {
  const payFrequencyOptions = Object.values(PAY_FREQUENCIES).map((frequency) => ({
    code: frequency.code,
    label: frequency.label,
    pay_periods_per_year: frequency.payPeriodsPerYear,
  }));

  res.json({
    overtime_rule: PAYROLL_OVERTIME_RULE,
    holiday_pay_enabled: true,
    holiday_pay_rule: HOLIDAY_PAY_RULE,
    holiday_pay_fields: ["holiday_pay", "holiday_label"],
    vacation_pay_enabled: true,
    vacation_pay_rule: VACATION_PAY_RULE,
    vacation_pay_schedules: Object.values(VACATION_PAY_SCHEDULES),
    payslip_enabled: true,
    payslip_defaults: {
      pay_date_source: "payroll period end date",
      wage_rate_label: "Hourly rate",
      payment_reference_optional: true,
    },
    pay_frequency_options: payFrequencyOptions,
    payroll_jurisdiction: {
      country: "CA",
      province: "AB",
      tax_year: 2026,
      pay_frequency: DEFAULT_PAY_FREQUENCY,
      pay_periods_per_year:
        PAY_FREQUENCIES[DEFAULT_PAY_FREQUENCY].payPeriodsPerYear,
    },
  });
});

app.get("/api/admin/payrolls/:id", requireAdminAuth, (req, res) => {
  const payrollId = Number(req.params.id);

  if (!payrollId) {
    return res.status(400).json({
      error: "id invalido.",
    });
  }

  const payroll = getPayrollDetails(payrollId);

  if (!payroll) {
    return res.status(404).json({
      error: "Payroll nao encontrado.",
    });
  }

  return res.json(payroll);
});

app.get(
  "/api/admin/payrolls/:payrollId/items/:itemId/payslip",
  requireAdminAuth,
  (req, res) => {
    const payrollId = Number(req.params.payrollId);
    const itemId = Number(req.params.itemId);

    if (!payrollId || !itemId) {
      return res.status(400).json({
        error: "payrollId and itemId are required.",
      });
    }

    const payslip = getPayrollPayslip(payrollId, itemId);

    if (!payslip) {
      return res.status(404).json({
        error: "Payslip not found.",
      });
    }

    return res.json(payslip);
  },
);

app.get("/api/admin/payrolls/:id/export", requireAdminAuth, (req, res) => {
  const payrollId = Number(req.params.id);

  if (!payrollId) {
    return res.status(400).json({
      error: "id invalido.",
    });
  }

  const payroll = getPayrollDetails(payrollId);

  if (!payroll) {
    return res.status(404).json({
      error: "Payroll nao encontrado.",
    });
  }

  const escapeCsvValue = (value) => {
    if (value === null || value === undefined) {
      return "";
    }

    const stringValue = String(value).replace(/"/g, '""');
    return `"${stringValue}"`;
  };

  const header = [
    "Employee Name",
    "Gross",
    "Vacation Pay",
    "Holiday Pay",
    "Total Earnings",
    "Federal",
    "Provincial",
    "Tax Total",
    "CPP",
    "CPP - employer",
    "EI",
    "EI - employer",
    "Net",
    "Deduction",
  ];

  const rows = payroll.items.map((item) =>
    [
      item.employee_name,
      item.gross_pay,
      item.vacation_payout,
      item.holiday_pay,
      item.total_earnings,
      item.federal_tax,
      item.provincial_tax,
      item.tax_total,
      item.cpp_total,
      item.cpp_employer,
      item.ei_deduction,
      item.ei_employer,
      item.net_pay,
      item.total_deductions,
    ]
      .map(escapeCsvValue)
      .join(","),
  );

  const csv = [header.join(","), ...rows].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="payroll-${payrollId}.csv"`,
  );
  res.send(csv);
});

app.post("/api/admin/payrolls/generate", requireAdminAuth, (req, res) => {
  const {
    start_date: startDate,
    end_date: endDate,
    pay_date: payDate,
    wage_rate_label: wageRateLabel,
    cheque_number_prefix: chequeNumberPrefix,
    tax_year: taxYear,
    country,
    province,
    pay_frequency: payFrequency,
    hourly_rate: hourlyRate,
    hourly_rates: hourlyRates,
  } = req.body;

  if (!isValidPeriodDate(startDate) || !isValidPeriodDate(endDate)) {
    return res.status(400).json({
      error: "start_date e end_date sao obrigatorios no formato YYYY-MM-DD.",
    });
  }

  if (new Date(startDate) > new Date(endDate)) {
    return res.status(400).json({
      error: "start_date nao pode ser maior que end_date.",
    });
  }

  if (payDate && !isValidPeriodDate(payDate)) {
    return res.status(400).json({
      error: "pay_date must use YYYY-MM-DD format.",
    });
  }

  try {
    const payroll = generatePayroll({
      startDate,
      endDate,
      payDate: payDate || endDate,
      wageRateLabel:
        wageRateLabel === undefined || wageRateLabel === null || String(wageRateLabel).trim() === ""
          ? "Hourly rate"
          : String(wageRateLabel).trim(),
      chequeNumberPrefix:
        chequeNumberPrefix === undefined || chequeNumberPrefix === null || String(chequeNumberPrefix).trim() === ""
          ? null
          : String(chequeNumberPrefix).trim(),
      taxYear: Number(taxYear || 2026),
      country: country || "CA",
      province: province || "AB",
      payFrequency:
        payFrequency === undefined || payFrequency === null || payFrequency === ""
          ? null
          : normalizePayFrequency(payFrequency),
      defaultHourlyRate:
        hourlyRate === undefined || hourlyRate === null || hourlyRate === ""
          ? null
          : Number(hourlyRate),
      hourlyRatesByEmployee:
        hourlyRates && typeof hourlyRates === "object" ? hourlyRates : {},
      adminUser: req.adminSession.username,
    });

    return res.status(201).json(payroll);
  } catch (error) {
    if (
      error.code === "PAYROLL_APPROVED" ||
      error.code === "UNSUPPORTED_TAX_YEAR" ||
      error.code === "UNSUPPORTED_JURISDICTION" ||
      error.code === "MISSING_EMPLOYEE_HOURLY_RATE" ||
      error.code === "MISSING_EMPLOYEE_PAY_FREQUENCY" ||
      error.code === "MIXED_EMPLOYEE_PAY_FREQUENCIES"
    ) {
      return res.status(409).json({ error: error.message });
    }

    return res.status(500).json({
      error: "Erro ao gerar payroll.",
    });
  }
});

app.post("/api/admin/payrolls/:id/approve", requireAdminAuth, (req, res) => {
  const payrollId = Number(req.params.id);

  if (!payrollId) {
    return res.status(400).json({
      error: "id invalido.",
    });
  }

  const payroll = approvePayroll(payrollId, req.adminSession.username);

  if (!payroll) {
    return res.status(404).json({
      error: "Payroll nao encontrado.",
    });
  }

  return res.json(payroll);
});

app.post("/api/admin/payrolls/:id/recalculate", requireAdminAuth, (req, res) => {
  const payrollId = Number(req.params.id);
  const { allow_approved: allowApproved } = req.body || {};

  if (!payrollId) {
    return res.status(400).json({
      error: "id invalido.",
    });
  }

  const existingPayroll = getPayrollDetails(payrollId);

  if (!existingPayroll) {
    return res.status(404).json({
      error: "Payroll nao encontrado.",
    });
  }

  if (existingPayroll.status === "approved" && allowApproved !== true) {
    return res.status(409).json({
      error: "Approved payroll requires explicit confirmation before recalculation.",
    });
  }

  try {
    const payroll = recalculatePayroll(payrollId, {
      adminUser: req.adminSession.username,
      allowApprovedRebuild: allowApproved === true,
    });

    return res.json(payroll);
  } catch (error) {
    if (
      error.code === "PAYROLL_APPROVED" ||
      error.code === "MISSING_EMPLOYEE_HOURLY_RATE" ||
      error.code === "MISSING_EMPLOYEE_PAY_FREQUENCY" ||
      error.code === "MIXED_EMPLOYEE_PAY_FREQUENCIES"
    ) {
      return res.status(409).json({
        error:
          error.code === "PAYROLL_APPROVED"
            ? "Approved payroll requires explicit confirmation before recalculation."
            : error.message,
      });
    }

    return res.status(500).json({
      error: "Failed to recalculate payroll.",
    });
  }
});

app.put(
  "/api/admin/payrolls/:payrollId/items/:itemId/holiday",
  requireAdminAuth,
  (req, res) => {
    const payrollId = Number(req.params.payrollId);
    const itemId = Number(req.params.itemId);
    const {
      holiday_hours: holidayHours,
      holiday_pay: holidayPay,
      holiday_label: holidayLabel,
    } = req.body;

    if (!payrollId || !itemId) {
      return res.status(400).json({
        error: "payrollId e itemId invalidos.",
      });
    }

    try {
      const payroll = updatePayrollItemHoliday({
        payrollPeriodId: payrollId,
        payrollItemId: itemId,
        holidayPay,
        holidayHours,
        holidayLabel,
        adminUser: req.adminSession.username,
      });

      if (!payroll) {
        return res.status(404).json({
          error: "Payroll ou item nao encontrado.",
        });
      }

      return res.json(payroll);
    } catch (error) {
      if (
        error.code === "PAYROLL_APPROVED" ||
        error.code === "INVALID_HOLIDAY_HOURS" ||
        error.code === "INVALID_HOLIDAY_PAY" ||
        error.code === "MISSING_EMPLOYEE_PAY_FREQUENCY"
      ) {
        return res.status(409).json({ error: error.message });
      }

      return res.status(500).json({
        error: "Failed to update holiday pay.",
      });
    }
  },
);

app.post("/api/admin/time-records", requireAdminAuth, (req, res) => {
  const {
    employee_id: employeeId,
    type,
    recorded_at: recordedAt,
    kiosk_id: kioskId,
  } = req.body;

  if (!employeeId || !type || !recordedAt) {
    return res.status(400).json({
      error: "employee_id, type e recorded_at sao obrigatorios.",
    });
  }

  if (!isValidRecordType(type)) {
    return res.status(400).json({
      error: "type deve ser check-in ou check-out.",
    });
  }

  if (!isValidRecordedAt(recordedAt)) {
    return res.status(400).json({
      error: "recorded_at precisa ser uma data valida em formato ISO.",
    });
  }

  const normalizedEmployeeId = Number(employeeId);
  const employee = findEmployeeById(normalizedEmployeeId);

  if (!normalizedEmployeeId || !employee || employee.active !== 1) {
    return res.status(404).json({
      error: "Funcionario nao encontrado.",
    });
  }

  try {
    const record = createManualTimeRecord({
      employeeId: normalizedEmployeeId,
      type: normalizeRecordType(type),
      recordedAt,
      kioskId,
      adminUser: req.adminSession.username,
    });

    return res.status(201).json({
      success: true,
      record,
    });
  } catch (error) {
    if (error.code === "INVALID_SEQUENCE") {
      return res.status(409).json({ error: error.message });
    }

    return res.status(500).json({
      error: "Erro ao criar registro manual.",
    });
  }
});

app.post("/api/admin/manual-hours", requireAdminAuth, (req, res) => {
  const {
    employee_id: employeeId,
    work_date: workDate,
    worked_hours: legacyWorkedHours,
    regular_hours: regularHours,
    holiday_label: holidayLabel,
    holiday_hours: holidayHours,
    holiday_multiplier: holidayMultiplier,
    note,
  } = req.body;

  if (!employeeId || !workDate) {
    return res.status(400).json({
      error: "employee_id and work_date are required.",
    });
  }

  if (!isValidManualHoursDate(workDate)) {
    return res.status(400).json({
      error: "work_date must be a valid date in YYYY-MM-DD format.",
    });
  }

  const normalizedRegularHours = normalizeWorkedHours(
    regularHours !== undefined ? regularHours : legacyWorkedHours,
  );
  const normalizedHolidayHours = normalizeWorkedHours(holidayHours);
  const safeRegularHours = Number.isFinite(normalizedRegularHours) ? normalizedRegularHours : 0;
  const safeHolidayHours = Number.isFinite(normalizedHolidayHours) ? normalizedHolidayHours : 0;

  if (safeRegularHours <= 0 && safeHolidayHours <= 0) {
    return res.status(400).json({
      error: "Enter regular hours, holiday hours, or both.",
    });
  }

  if (safeRegularHours < 0 || safeHolidayHours < 0) {
    return res.status(400).json({
      error: "Hours must be zero or greater.",
    });
  }

  const normalizedHolidayMultiplier = normalizeHolidayMultiplier(holidayMultiplier);
  if (!Number.isFinite(normalizedHolidayMultiplier) || normalizedHolidayMultiplier <= 0) {
    return res.status(400).json({
      error: "holiday_multiplier must be greater than zero.",
    });
  }

  const normalizedEmployeeId = Number(employeeId);
  const employee = findEmployeeById(normalizedEmployeeId);

  if (!normalizedEmployeeId || !employee) {
    return res.status(404).json({
      error: "Employee not found.",
    });
  }

  try {
    const records = [];

    if (safeRegularHours > 0) {
      records.push(
        createManualHoursEntry({
          employeeId: normalizedEmployeeId,
          workDate,
          workedHours: safeRegularHours,
          note: note ? String(note).trim() : null,
          manualCategory: "regular",
          adminUser: req.adminSession.username,
        }),
      );
    }

    if (safeHolidayHours > 0) {
      records.push(
        createManualHoursEntry({
          employeeId: normalizedEmployeeId,
          workDate,
          workedHours: safeHolidayHours,
          note: note ? String(note).trim() : null,
          manualCategory: "holiday",
          holidayLabel: holidayLabel ? String(holidayLabel).trim() : "Holiday Pay",
          holidayMultiplier: normalizedHolidayMultiplier,
          adminUser: req.adminSession.username,
        }),
      );
    }

    return res.status(201).json({
      success: true,
      records,
    });
  } catch (_error) {
    return res.status(500).json({
      error: "Failed to create manual hours entry.",
    });
  }
});

app.put("/api/admin/time-records/:id", requireAdminAuth, (req, res) => {
  const recordId = Number(req.params.id);
  const { type, recorded_at: recordedAt, kiosk_id: kioskId } = req.body;

  if (!recordId || !type || !recordedAt) {
    return res.status(400).json({
      error: "id, type e recorded_at sao obrigatorios.",
    });
  }

  if (!isValidRecordType(type)) {
    return res.status(400).json({
      error: "type deve ser check-in ou check-out.",
    });
  }

  if (!isValidRecordedAt(recordedAt)) {
    return res.status(400).json({
      error: "recorded_at precisa ser uma data valida em formato ISO.",
    });
  }

  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || existingRecord.deleted_at) {
    return res.status(404).json({
      error: "Registro nao encontrado.",
    });
  }

  try {
    const record = updateManualTimeRecord(recordId, {
      type: normalizeRecordType(type),
      recordedAt,
      kioskId,
      adminUser: req.adminSession.username,
    });

    return res.json({
      success: true,
      record,
    });
  } catch (error) {
    if (error.code === "INVALID_SEQUENCE") {
      return res.status(409).json({ error: error.message });
    }

    return res.status(500).json({
      error: "Erro ao atualizar registro manual.",
    });
  }
});

app.put("/api/admin/manual-hours/:id", requireAdminAuth, (req, res) => {
  const recordId = Number(req.params.id);
  const {
    work_date: workDate,
    worked_hours: workedHours,
    regular_hours: regularHours,
    holiday_hours: holidayHours,
    note,
    manual_category: manualCategory,
    holiday_label: holidayLabel,
    holiday_multiplier: holidayMultiplier,
  } = req.body;

  const requestedCategory =
    manualCategory ||
    ((holidayHours !== undefined && normalizeWorkedHours(holidayHours) > 0)
      ? "holiday"
      : "regular");
  const resolvedWorkedHours =
    workedHours !== undefined
      ? workedHours
      : requestedCategory === "holiday"
        ? holidayHours
        : regularHours;

  if (!recordId || !workDate || resolvedWorkedHours === undefined) {
    return res.status(400).json({
      error: "id, work_date and hours are required.",
    });
  }

  if (!isValidManualHoursDate(workDate)) {
    return res.status(400).json({
      error: "work_date must be a valid date in YYYY-MM-DD format.",
    });
  }

  const normalizedWorkedHours = normalizeWorkedHours(resolvedWorkedHours);
  if (!Number.isFinite(normalizedWorkedHours) || normalizedWorkedHours <= 0) {
    return res.status(400).json({
      error: "hours must be a number greater than zero.",
    });
  }

  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || existingRecord.deleted_at || existingRecord.entry_mode !== "manual") {
    return res.status(404).json({
      error: "Manual hours entry not found.",
    });
  }

  const normalizedHolidayMultiplier = normalizeHolidayMultiplier(
    holidayMultiplier !== undefined
      ? holidayMultiplier
      : existingRecord.holiday_multiplier,
  );
  if (
    requestedCategory === "holiday" &&
    (!Number.isFinite(normalizedHolidayMultiplier) || normalizedHolidayMultiplier <= 0)
  ) {
    return res.status(400).json({
      error: "holiday_multiplier must be greater than zero.",
    });
  }

  try {
    const record = updateManualHoursEntry(recordId, {
      workDate,
      workedHours: normalizedWorkedHours,
      note: note ? String(note).trim() : null,
      manualCategory: requestedCategory === "holiday" ? "holiday" : "regular",
      holidayLabel:
        requestedCategory === "holiday"
          ? String(holidayLabel || existingRecord.holiday_label || "Holiday Pay").trim()
          : null,
      holidayMultiplier:
        requestedCategory === "holiday" ? normalizedHolidayMultiplier : 1.5,
      adminUser: req.adminSession.username,
    });

    return res.json({
      success: true,
      record,
    });
  } catch (_error) {
    return res.status(500).json({
      error: "Failed to update manual hours entry.",
    });
  }
});

app.delete("/api/admin/time-records/:id", requireAdminAuth, (req, res) => {
  const recordId = Number(req.params.id);

  if (!recordId) {
    return res.status(400).json({
      error: "id invalido.",
    });
  }

  const existingRecord = findTimeRecordById(recordId);

  if (!existingRecord || existingRecord.deleted_at) {
    return res.status(404).json({
      error: "Registro nao encontrado.",
    });
  }

  try {
    const result = deleteManualTimeRecord(recordId, req.adminSession.username);
    return res.json(result);
  } catch (error) {
    if (error.code === "INVALID_SEQUENCE") {
      return res.status(409).json({ error: error.message });
    }

    return res.status(500).json({
      error: "Erro ao excluir registro manual.",
    });
  }
});

app.post(
  "/api/admin/time-records/:id/restore",
  requireAdminAuth,
  (req, res) => {
    const recordId = Number(req.params.id);

    if (!recordId) {
      return res.status(400).json({
        error: "id invalido.",
      });
    }

    const existingRecord = findTimeRecordById(recordId);

    if (!existingRecord || !existingRecord.deleted_at) {
      return res.status(404).json({
        error: "Registro deletado nao encontrado.",
      });
    }

    try {
    const record = restoreManualTimeRecord(recordId, req.adminSession.username);
      return res.json({
        success: true,
        record,
      });
    } catch (error) {
      if (error.code === "INVALID_SEQUENCE") {
        return res.status(409).json({ error: error.message });
      }

      return res.status(500).json({
        error: "Erro ao restaurar registro.",
      });
    }
  },
);

app.post("/api/time", (req, res) => {
  const { employee_id: employeeId, pin, type, kiosk_id: kioskId } = req.body;

  if (!employeeId || !pin || !type) {
    return res.status(400).json({
      error: "employee_id, pin e type sao obrigatorios.",
    });
  }

  if (!isValidRecordType(type)) {
    return res.status(400).json({
      error: "type deve ser check-in ou check-out.",
    });
  }

  const normalizedType = normalizeRecordType(type);
  const normalizedEmployeeId = Number(employeeId);
  const employee = findEmployeeById(normalizedEmployeeId);

  if (!normalizedEmployeeId || !employee || employee.active !== 1) {
    return res.status(404).json({
      error: "Funcionario nao encontrado.",
    });
  }

  const pinIsValid = verifyEmployeePin(normalizedEmployeeId, pin);

  if (!pinIsValid) {
    return res.status(401).json({
      error: "PIN invalido.",
    });
  }

  const lastRecord = getLastTimeRecord(employeeId);

  if (normalizedType === "check-in" && lastRecord?.type === "check-in") {
    return res.status(409).json({
      error: "Nao e possivel fazer check-in duplicado.",
    });
  }

  if (normalizedType === "check-out" && lastRecord?.type !== "check-in") {
    return res.status(409).json({
      error: "Nao e possivel fazer check-out sem check-in anterior.",
    });
  }

  const record = createTimeRecord({
    employeeId: normalizedEmployeeId,
    type: normalizedType,
    kioskId,
    recordedAt: new Date().toISOString(),
  });

  return res.status(201).json({
    success: true,
    record,
  });
});

if (hasFrontendBuild) {
  app.get(["/", "/admin"], (_req, res) => {
    res.sendFile(frontendIndexPath);
  });
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(
    `Ambiente ${config.isProduction ? "production" : "development"} | admin ${ADMIN_USERNAME}`,
  );
});
