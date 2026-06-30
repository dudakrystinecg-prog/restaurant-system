const { Resend } = require("resend");
const puppeteer  = require("puppeteer");
const fs         = require("fs");
const path       = require("path");

const FROM_ADDRESS   = "Sushi House Banff <payroll@mail.sushihousebanff.ca>";
const REPLY_TO_ADDRESS = process.env.REPLY_TO_EMAIL || "sushihousebanff@gmail.com";

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
    reply_to: REPLY_TO_ADDRESS,
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

// ─── PDF payslip HTML — letterhead format matching printed payslip ────────────
function buildPayslipHtml(payslip) {
  const logoPath = path.join(__dirname, "../kiosk/public/logo.png");
  let logoSrc = "";
  try {
    const logoData = fs.readFileSync(logoPath);
    logoSrc = `data:image/png;base64,${logoData.toString("base64")}`;
  } catch (_) {}

  const earningsRows = getEarningsRows(payslip)
    .map((row) => {
      if (row.isTotal) {
        return `<tr class="total-row">
          <td>${row.label}</td>
          <td class="col-earn"></td>
          <td class="col-total">${formatMoney(row.value)}</td>
        </tr>`;
      }
      return `<tr>
        <td>${row.label}</td>
        <td class="col-earn">${formatMoney(row.value)}</td>
        <td class="col-total"></td>
      </tr>`;
    })
    .join("");

  const deductionRows = getDeductionRows(payslip)
    .map((row) => {
      if (row.isTotal) {
        return `<tr class="total-row">
          <td>${row.label}</td>
          <td class="col-earn"></td>
          <td class="col-total">(${formatMoney(row.value)})</td>
        </tr>`;
      }
      return `<tr>
        <td>${row.label}</td>
        <td class="col-earn">(${formatMoney(row.value)})</td>
        <td class="col-total"></td>
      </tr>`;
    })
    .join("");

  const chequeRow = payslip.header.payment_reference
    ? `<tr><td>Cheque No.</td><td>:</td><td>No. ${payslip.header.payment_reference}</td></tr>`
    : "";

  const vacationNote = payslip.notes?.accrued_vacation_balance_note || "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Payslip - ${payslip.header.employee}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #111; background: #fff; padding: 40px 48px; }
      .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
      .letterhead { line-height: 1.75; }
      .letterhead .pay-date { margin-bottom: 14px; }
      .letterhead .company-name { font-weight: bold; }
      .logo { height: 88px; width: auto; }
      .section-label { font-size: 13px; margin-bottom: 12px; }
      .meta-table { border-collapse: collapse; margin-bottom: 22px; }
      .meta-table td { padding: 3px 0; vertical-align: top; }
      .meta-table .lbl { width: 110px; }
      .meta-table .sep { width: 24px; color: #555; }
      .main-table { border-collapse: collapse; width: 100%; }
      .main-table th, .main-table td { border: 1px solid #aaa; padding: 7px 10px; }
      .main-table thead th { background: #d4d4d4; font-weight: bold; text-align: left; }
      .main-table .col-earn { width: 210px; text-align: right; }
      .main-table .col-total { width: 130px; text-align: right; }
      .section-row td { background: #d4d4d4; font-weight: bold; }
      .total-row td { font-weight: bold; }
      .net-row td { font-weight: bold; }
      .vacation-note { margin-top: 16px; font-size: 11px; color: #444; border: 1px solid #bbb; padding: 8px 10px; background: #fafafa; }
    </style>
  </head>
  <body>
    <div class="page-header">
      <div class="letterhead">
        <div class="pay-date">${payslip.header.pay_date}</div>
        <div class="company-name">709027 AB Ltd</div>
        <div>Sushi House Banff</div>
        <div>304 Caribou Street</div>
        <div>P.O.Box 1985</div>
        <div>Banff, AB</div>
        <div>T1L 1B7</div>
        <div>Canada</div>
        <div>Phone : 403-762-4353</div>
      </div>
      ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="Sushi House Banff" />` : ""}
    </div>

    <div class="section-label">Earnings Statement</div>

    <table class="meta-table">
      <tr><td class="lbl">Employee</td><td class="sep">:</td><td>${payslip.header.employee}</td></tr>
      <tr><td class="lbl">Pay Period</td><td class="sep">:</td><td>${payslip.header.pay_period}</td></tr>
      <tr><td class="lbl">Wage Rate</td><td class="sep">:</td><td>${payslip.header.wage_rate}</td></tr>
      <tr><td class="lbl">Pay Date</td><td class="sep">:</td><td>${payslip.header.pay_date}</td></tr>
      ${chequeRow}
    </table>

    <table class="main-table">
      <thead>
        <tr>
          <th>Income</th>
          <th class="col-earn">Earnings</th>
          <th class="col-total">Total</th>
        </tr>
      </thead>
      <tbody>
        ${earningsRows}
        <tr class="section-row"><td colspan="3">Deductions</td></tr>
        ${deductionRows}
        <tr class="net-row">
          <td>Net Pay</td>
          <td class="col-earn"></td>
          <td class="col-total">${formatMoney(payslip.totals.net_pay)}</td>
        </tr>
      </tbody>
    </table>

    ${vacationNote ? `<div class="vacation-note">${vacationNote}</div>` : ""}
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

  console.log(`[email] Generating payslip PDF for ${employee.name}`);
  const html      = buildPayslipHtml(payslip);
  const pdfBuffer = await htmlToPdf(html);
  console.log(`[email] PDF generated (${pdfBuffer.length} bytes), sending via Resend`);

  const safeName = employee.name.replace(/\s+/g, "_");
  const filename = `payslip_${safeName}_${periodStart}_${periodEnd}.pdf`;

  const emailText = `Hi ${employee.name},\n\nPlease find your pay statement for the period ${periodLabel} attached to this email.\n\nSushi House Banff`;

  const payload = {
    from: FROM_ADDRESS,
    reply_to: REPLY_TO_ADDRESS,
    to: employee.email,
    subject: `Pay Statement — ${employee.name} (${periodLabel})`,
    text: emailText,
    attachments: [{ filename, content: Buffer.from(pdfBuffer).toString("base64") }],
  };
  if (adminEmail) payload.bcc = [adminEmail];

  const { data, error } = await client.emails.send(payload);

  if (error) throw new Error(error.message || "Failed to send payroll email.");
  console.log(`[email] Resend accepted email, id: ${data.id}`);
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
      reply_to: REPLY_TO_ADDRESS,
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
