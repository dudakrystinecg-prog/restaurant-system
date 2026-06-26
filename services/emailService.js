const { Resend } = require("resend");
const puppeteer  = require("puppeteer");
const fs         = require("fs");
const path       = require("path");

const FROM_ADDRESS = "Sushi House Banff <payroll@mail.sushihousebanff.ca>";

let resend;

function getClient() {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
    resend = new Resend(apiKey);
  }
  return resend;
}

async function testConnection(adminEmail) {
  const client = getClient();
  const { data, error } = await client.emails.send({
    from: FROM_ADDRESS,
    to: adminEmail,
    subject: "Sushi House Banff — Email connection test",
    text: "Hello,\n\nThis is a test email from Sushi House Banff admin panel.\n\nIf you received this, your email integration is working correctly.",
  });
  if (error) throw new Error(error.message || "Failed to send test email.");
  return { id: data.id };
}

// ─── Same helpers as frontend ─────────────────────────────────────────────────
function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function getEarningsRows(payslip) {
  if (payslip.pay_type === 'salaried') {
    const rows = [{ label: "Regular Salary", value: payslip.earnings.regular_earnings }];
    if (Number(payslip.earnings.vacation_pay || 0) > 0)
      rows.push({ label: `Vacation Pay (${payslip.raw?.vacation_pay_pct ?? 4}%)`, value: payslip.earnings.vacation_pay });
    if (Number(payslip.earnings.extra_pay || 0) > 0)
      rows.push({ label: "Bonus", value: payslip.earnings.extra_pay });
    rows.push({ label: "Total Earnings", value: payslip.earnings.total_earnings, isTotal: true });
    return rows;
  }
  // existing hourly logic unchanged:
  const rows = [{ label: "Regular Earnings", value: payslip.earnings.regular_earnings }];
  if (Number(payslip.earnings.vacation_pay || 0) > 0)
    rows.push({ label: "Vacation Pay", value: payslip.earnings.vacation_pay });
  if (Number(payslip.earnings.extra_pay || 0) > 0)
    rows.push({ label: payslip.earnings.extra_pay_label || "Holiday Pay", value: payslip.earnings.extra_pay });
  rows.push({ label: "Total Earnings", value: payslip.earnings.total_earnings, isTotal: true });
  return rows;
}

function getDeductionRows(payslip) {
  return [
    { label: "Federal Tax",      value: payslip.deductions.federal_tax },
    { label: "Provincial Tax",   value: payslip.deductions.provincial_tax },
    { label: "CPP",              value: payslip.deductions.cpp },
    { label: "EI",               value: payslip.deductions.ei },
    { label: "Total Deductions", value: payslip.deductions.total_deductions, isTotal: true },
  ];
}

// ─── Exact same HTML as buildPayslipPrintHtml in AdminView.js ─────────────────
function buildPayslipHtml(payslip) {
  // Embed logo as base64 so puppeteer doesn't need server access
  const logoPath = path.join(__dirname, "../kiosk/public/logo.png");
  let logoSrc = "";
  try {
    const logoData = fs.readFileSync(logoPath);
    logoSrc = `data:image/png;base64,${logoData.toString("base64")}`;
  } catch (_) {
    // logo not found — skip image
  }

  const benefitsNote = payslip.benefits_note || "";
  const earningsRows = getEarningsRows(payslip)
    .map((row, index) => {
      const benefitCell = index === 0 && benefitsNote ? benefitsNote : "";
      return `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td class="amount">${formatMoney(row.value)}</td><td class="benefits">${benefitCell}</td></tr>`;
    })
    .join("");

  const deductionRows = getDeductionRows(payslip)
    .map((row) => `<tr class="${row.isTotal ? "is-total" : ""}"><td>${row.label}</td><td class="amount">${formatMoney(row.value)}</td><td class="benefits"></td></tr>`)
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
      .header-text .title { font-size: 20px; font-weight: 700; margin: 0; }
      .header-text .address { color: #4b5563; font-size: 12px; margin: 2px 0 0; }
      .header-text .doc-label { font-size: 13px; font-weight: 600; margin: 2px 0 0; }
      .meta-table, .statement-table { width: calc(100% - 44px); margin: 0 22px 18px; border-collapse: collapse; }
      .meta-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 13px; vertical-align: top; }
      .meta-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #4b5563; margin-bottom: 4px; }
      .meta-value { font-size: 14px; font-weight: 600; color: #111111; }
      .statement-table th, .statement-table td { border: 1px solid #6b7280; padding: 10px 12px; font-size: 14px; }
      .statement-table th { background: #e5e7eb; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; text-align: left; }
      .statement-table .amount, .statement-table th.amount { text-align: right; width: 160px; }
      .statement-table .benefits, .statement-table th.benefits { width: 260px; white-space: pre-line; text-align: left; }
      .section-row td { background: #f3f4f6; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
      .is-total td { font-weight: 700; background: #fafafa; }
      .net-row td { font-weight: 700; font-size: 18px; background: #e5e7eb; }
      .note { margin: 0 22px 22px; padding: 10px 12px; border: 1px solid #9ca3af; font-size: 12px; color: #374151; background: #f9fafb; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div class="header">
        ${logoSrc ? `<img class="header-logo" src="${logoSrc}" alt="Sushi House Banff logo" />` : ""}
        <div class="header-text">
          <p class="title">Sushi House Banff</p>
          <p class="address">304 Caribou Street, P.O. Box 1985, Banff, Alberta, Canada T1L 1B7</p>
          <p class="doc-label">Employee Earnings Statement</p>
        </div>
      </div>
      <table class="meta-table">
        <tr>
          <td><span class="meta-label">Employee</span><span class="meta-value">${payslip.header.employee}</span></td>
          <td><span class="meta-label">Pay Period</span><span class="meta-value">${payslip.header.pay_period}</span></td>
          <td><span class="meta-label">Total Hours</span><span class="meta-value">${Number(payslip.header.total_hours || 0).toFixed(2)} hrs</span></td>
          <td><span class="meta-label">Wage Rate</span><span class="meta-value">${payslip.header.wage_rate}</span></td>
          <td><span class="meta-label">Pay Date</span><span class="meta-value">${payslip.header.pay_date}</span></td>
          <td><span class="meta-label">Cheque No.</span><span class="meta-value">${payslip.header.payment_reference ? `No. ${payslip.header.payment_reference}` : "-"}</span></td>
        </tr>
      </table>
      <table class="statement-table">
        <thead>
          <tr><th>Description</th><th class="amount">Amount</th><th class="benefits">Benefits</th></tr>
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
  </body>
</html>`;
}

// ─── Convert HTML to PDF with puppeteer ──────────────────────────────────────
async function htmlToPdf(html) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    return pdf;
  } finally {
    await browser.close();
  }
}

function formatDateLong(dateStr) {
  if (!dateStr) return dateStr;
  const [year, month, day] = dateStr.split("-");
  return new Date(Number(year), Number(month) - 1, Number(day))
    .toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}

// ─── Main export ─────────────────────────────────────────────────────────────
async function sendPayrollEmail(employee, payslip, adminEmail) {
  const client = getClient();

  const periodStart = payslip.pay_period?.start_date || "";
  const periodEnd   = payslip.pay_period?.end_date   || "";
  const periodLabel = `${formatDateLong(periodStart)} to ${formatDateLong(periodEnd)}`;

  const html      = buildPayslipHtml(payslip);
  const pdfBuffer = await htmlToPdf(html);

  const safeName = employee.name.replace(/\s+/g, "_");
  const filename = `payslip_${safeName}_${periodStart}_${periodEnd}.pdf`;

  const emailText = `Hi ${employee.name},\n\nPlease find your pay statement for the period ${periodLabel} attached to this email.\n\nSushi House Banff`;

  const payload = {
    from: FROM_ADDRESS,
    to: employee.email,
    subject: `Pay Statement — ${employee.name} (${periodLabel})`,
    text: emailText,
    attachments: [{ filename, content: Buffer.from(pdfBuffer).toString("base64") }],
  };
  if (adminEmail) payload.bcc = [adminEmail];

  const { data, error } = await client.emails.send(payload);

  if (error) throw new Error(error.message || "Failed to send payroll email.");
  return { id: data.id };
}

// ─── Staff message send ───────────────────────────────────────────────────────
async function sendStaffMessage({ recipients, subject, body, bccEmail, attachments }) {
  const client = getClient();
  const results = [];

  for (const recipient of recipients) {
    const text = `${body}\n\n—\nSushi House Banff`;
    const payload = {
      from: FROM_ADDRESS,
      to: recipient.email,
      subject,
      text,
    };
    if (bccEmail) payload.bcc = [bccEmail];
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
      }));
    }
    try {
      const { data, error } = await client.emails.send(payload);
      if (error) throw new Error(error.message || "Send failed");
      results.push({ email: recipient.email, name: recipient.name, success: true, id: data.id });
    } catch (err) {
      results.push({ email: recipient.email, name: recipient.name, success: false, error: err.message });
    }
  }
  return results;
}

module.exports = { testConnection, sendPayrollEmail, sendStaffMessage, FROM_ADDRESS };
