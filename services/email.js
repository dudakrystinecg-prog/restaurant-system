// Stub email module — wraps emailService.js if available, otherwise no-ops
let emailService;
try {
  emailService = require("./emailService");
} catch (_) {
  emailService = null;
}

async function sendPayrollEmail(employee, payslip, adminEmail) {
  if (emailService && typeof emailService.sendPayrollEmail === "function") {
    return emailService.sendPayrollEmail(employee, payslip, adminEmail);
  }
  console.log(`[email stub] Would send payroll email to ${employee.email}`);
}

async function sendTestEmail(toEmail) {
  if (emailService && typeof emailService.sendTestEmail === "function") {
    return emailService.sendTestEmail(toEmail);
  }
  console.log(`[email stub] Would send test email to ${toEmail}`);
}

module.exports = { sendPayrollEmail, sendTestEmail };
