const Database = require("better-sqlite3");
const path = require("path");
const config = require("../config");

const databasePath = path.resolve(config.databasePath);
const db = new Database(databasePath);

const transaction = db.transaction(() => {
  db.prepare("DELETE FROM payroll_items").run();
  db.prepare("DELETE FROM payroll_periods").run();
  db.prepare("DELETE FROM time_records").run();
  db.prepare("DELETE FROM employee_audit_logs").run();
  db.prepare("DELETE FROM audit_logs WHERE entity_type IN ('employee', 'time_record', 'payroll')").run();
  db.prepare("DELETE FROM employees").run();
});

transaction();

console.log(`Cleared employees and related payroll/time data from ${databasePath}`);
