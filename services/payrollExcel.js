/**
 * payrollExcel.js
 * Generates an .xlsx file matching the Sushi House Banff payroll template exactly.
 * Uses existing calculated values from the system — no recalculations.
 */
const ExcelJS = require("exceljs");

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

function getMonthName(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return MONTHS[d.getUTCMonth()];
}

function n(v) { return Number(v || 0); }
function fmt2(v) { return Math.round(n(v) * 100) / 100; }

/**
 * Build the hours detail string for column B.
 * e.g. "147.5 hrs x 26"
 */
function hoursDetail(item) {
  if (!item.total_hours || item.total_hours === 0) return "";
  const hrs = n(item.total_hours);
  const rate = n(item.hourly_rate);
  if (rate === 0) return `${hrs} hrs`;
  return `${hrs} hrs x ${rate}`;
}

/**
 * Build the holiday sub-row detail string for column B.
 * e.g. "Family Day  5.25 hrs x 17 x 1.5  133.88"
 * We put this in col A with the label, col B with the detail, col C with the amount.
 */
function holidayDetail(item) {
  const hrs  = n(item.holiday_hours);
  const rate = n(item.hourly_rate);
  const pay  = n(item.holiday_pay);
  if (hrs > 0 && rate > 0) {
    return `${hrs} hrs x ${rate} x 1.5`;
  }
  // fallback — just show amount
  return pay > 0 ? `${pay}` : "";
}

/**
 * Apply header row style — bold text, no fill.
 */
function styleHeader(row) {
  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = { bold: true };
  });
}

/**
 * Apply total row style — bold text.
 */
function styleTotal(row) {
  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = { bold: true };
  });
}

/**
 * Format a cell as number with 2 decimal places.
 */
function numFmt(cell) {
  cell.numFmt = "0.00";
}

/**
 * Generate the payroll Excel workbook for one payroll period.
 *
 * @param {object} payroll  — full payroll period object from getPayrollDetails()
 * @returns {Buffer}        — xlsx buffer ready to send as download
 */
async function generatePayrollExcel(payroll) {
  const wb   = new ExcelJS.Workbook();
  wb.creator = "Sushi House Banff";
  const ws   = wb.addWorksheet("Sheet1");

  // ── Column widths (match original file roughly) ─────────────────────────
  ws.columns = [
    { width: 28 },  // A: Employee name / month / holiday label
    { width: 22 },  // B: Hours detail
    { width: 12 },  // C: Gross
    { width: 13 },  // D: Vacation pay
    { width: 11 },  // E: Federal
    { width: 12 },  // F: Provincial
    { width: 11 },  // G: Tax Total
    { width: 11 },  // H: CPP
    { width: 14 },  // I: CPP - employer
    { width: 9  },  // J: EI
    { width: 13 },  // K: EI - employer
    { width: 12 },  // L: Net
    { width: 12 },  // M: Deduction
    { width: 13 },  // N: Cheque
    { width: 3  },  // O: gap
    { width: 3  },  // P: gap
    { width: 3  },  // Q: gap
    // Right panel starts at col R (index 18)
    { width: 18 },  // R: Remittance period / employee name
    { width: 3  },  // S: gap
    { width: 3  },  // T: gap
    { width: 12 },  // U: Gross (employee history)
    { width: 13 },  // V: Vacation pay
    { width: 11 },  // W: Federal
    { width: 12 },  // X: Provincial
    { width: 11 },  // Y: Tax Total
    { width: 11 },  // Z: CPP
    { width: 14 },  // AA: CPP-employer
    { width: 9  },  // AB: EI
    { width: 13 },  // AC: EI-employer
    { width: 12 },  // AD: Net
    { width: 12 },  // AD: Deduction
  ];

  const items   = payroll.items || [];
  const month   = getMonthName(payroll.start_date);
  const totals  = payroll.totals || {};

  // ── Row 1: Title ─────────────────────────────────────────────────────────
  const r1 = ws.addRow(["2026 Payroll"]);
  r1.getCell(1).font = { bold: true, size: 13 };
  ws.addRow([]); // row 2 blank

  // ── Row 3: Right-panel header (Remittance summary) ───────────────────────
  ws.addRow([]); // row 3 blank
  ws.addRow([]); // row 4 blank

  const rHdr = ws.addRow([]); // row 5
  rHdr.getCell(18).value = "Remittance period";
  rHdr.getCell(19).value = "Remittance date";
  rHdr.getCell(20).value = "Remittance amount";
  rHdr.getCell(21).value = "Total";
  styleHeader(rHdr);

  ws.addRow([]); // row 6 blank

  // ── Row 7: Month section header ───────────────────────────────────────────
  const monthRow = ws.getRow(7);
  monthRow.values = [
    month, "", "Gross", "Vacation pay", "Federal", "Provincial",
    "Tax Total", "CPP", "CPP - employer", "EI", "EI - employer",
    "Net", "Deduction",
  ];
  styleHeader(monthRow);

  // Right panel: remittance row for this month
  monthRow.getCell(18).value = month;
  // Pay date if available
  if (payroll.pay_date) {
    monthRow.getCell(19).value = new Date(payroll.pay_date);
    monthRow.getCell(19).numFmt = "MMM D, YYYY";
  }
  // Remittance = Tax Total + CPP employee + CPP employer + EI employee + EI employer
  const remittance = fmt2(
    n(totals.total_tax) +
    n(totals.total_cpp_deduction) + n(totals.total_cpp_employer) +
    n(totals.total_ei_deduction)  + n(totals.total_ei_employer)
  );
  monthRow.getCell(20).value = remittance;
  numFmt(monthRow.getCell(20));
  monthRow.getCell(21).value = remittance; // first month — running total = remittance
  numFmt(monthRow.getCell(21));

  ws.addRow([]); // row 8 blank

  // ── Employee rows ─────────────────────────────────────────────────────────
  let currentRow = 9;
  const empStartRow = currentRow;

  for (const item of items) {
    const gross      = fmt2(item.gross_pay);
    const vacPay     = fmt2(item.vacation_payout);
    const federal    = fmt2(item.federal_tax);
    const provincial = fmt2(item.provincial_tax);
    const taxTotal   = fmt2(item.tax_total);
    const cpp        = fmt2(item.cpp_deduction + (item.cpp2_deduction || 0));
    const cppEmp     = fmt2(item.cpp_employer);
    const ei         = fmt2(item.ei_deduction);
    const eiEmp      = fmt2(item.ei_employer) || "";
    const net        = fmt2(item.net_pay);
    const deduction  = fmt2(gross + vacPay - net);
    const cheque     = item.cheque_number ? `cheq#${item.cheque_number}` : "";

    const empRow = ws.getRow(currentRow);
    empRow.values = [
      item.employee_name,
      hoursDetail(item),
      gross, vacPay, federal, provincial, taxTotal,
      cpp, cppEmp, ei, eiEmp || "",
      net, deduction, cheque,
    ];
    // Number format for numeric cells
    [3,4,5,6,7,8,9,10,12,13].forEach(c => { if (empRow.getCell(c).value !== "") numFmt(empRow.getCell(c)); });
    currentRow++;

    // Holiday sub-row (if applicable)
    if (n(item.holiday_pay) > 0) {
      const label = item.holiday_label || "Holiday";
      const hRow = ws.getRow(currentRow);
      hRow.values = [
        label,
        holidayDetail(item),
        fmt2(item.holiday_pay),
      ];
      hRow.getCell(1).font = { italic: true };
      numFmt(hRow.getCell(3));
      currentRow++;
    }
  }

  // ── Total row ─────────────────────────────────────────────────────────────
  ws.addRow([]); // blank before total
  currentRow++;

  const totalGross   = fmt2(totals.total_gross_pay);
  const totalVac     = fmt2(totals.total_vacation_payout);
  const totalFed     = fmt2(totals.total_federal_tax);
  const totalProv    = fmt2(totals.total_provincial_tax);
  const totalTax     = fmt2(totals.total_tax);
  const totalCpp     = fmt2(totals.total_cpp_deduction + (totals.total_cpp2_deduction || 0));
  const totalCppEmp  = fmt2(totals.total_cpp_employer);
  const totalEi      = fmt2(totals.total_ei_deduction);
  const totalEiEmp   = fmt2(totals.total_ei_employer);
  const totalNet     = fmt2(totals.total_net_pay);
  const totalDed     = fmt2(totalGross + totalVac - totalNet);

  const totalRow = ws.getRow(currentRow);
  totalRow.values = [
    "Total", "",
    totalGross, totalVac, totalFed, totalProv, totalTax,
    totalCpp, totalCppEmp, totalEi, totalEiEmp,
    totalNet, totalDed,
  ];
  styleTotal(totalRow);
  [3,4,5,6,7,8,9,10,11,12,13].forEach(c => numFmt(totalRow.getCell(c)));
  currentRow++;

  // ── Remittance calculation rows ───────────────────────────────────────────
  const grossPlusVac = fmt2(totalGross + totalVac);
  const remRow1 = ws.getRow(currentRow);
  remRow1.getCell(4).value = grossPlusVac;
  numFmt(remRow1.getCell(4));
  remRow1.getCell(12).value = grossPlusVac;
  numFmt(remRow1.getCell(12));
  currentRow++;

  const totalCppBoth = fmt2(totalCpp + totalCppEmp);
  const totalEiBoth  = fmt2(totalEi + totalEiEmp);
  const remRow2 = ws.getRow(currentRow);
  remRow2.getCell(5).value  = "Remittance";
  remRow2.getCell(6).value  = totalTax;
  remRow2.getCell(7).value  = "+";
  remRow2.getCell(8).value  = totalCppBoth;
  remRow2.getCell(9).value  = "+";
  remRow2.getCell(10).value = totalEiBoth;
  remRow2.getCell(11).value = "=";
  remRow2.getCell(12).value = remittance;
  [6,8,10,12].forEach(c => numFmt(remRow2.getCell(c)));
  remRow2.getCell(5).font = { bold: true };
  currentRow += 2; // blank after remittance

  // ── Individual employee history tables (right panel) ─────────────────────
  // One mini-table per employee starting at the month section row (row 7)
  // and going downward, placed in columns R (18) onwards
  // Layout: employee name header at empStartRow - 2, data rows aligned with employee rows

  // We'll place them starting at row (empStartRow - 1) on the right
  // Header row for first employee at row 7 (same as month header)
  const EMP_COL = 18; // column R

  let rightRow = 7; // align with month header row
  // blank row before first employee block
  rightRow++; // row 8

  for (const item of items) {
    // Employee name header
    const eHdrRow = ws.getRow(rightRow - 1 === 7 ? 7 : rightRow);
    if (rightRow - 1 === 7) {
      // First employee: place header two rows above their data
      // Employee name in col R, headers in col U onwards
      const nameHdr = ws.getRow(empStartRow - 2);
      nameHdr.getCell(EMP_COL).value = item.employee_name;
      nameHdr.getCell(EMP_COL).font = { bold: true };
      const colHdr = ws.getRow(empStartRow - 1 < 7 ? 7 : empStartRow);
    }
  }

  // Simpler approach: place all employee history tables stacked vertically
  // starting at a fixed offset to the right
  let eRightRow = 7;
  for (const item of items) {
    // Header: employee name
    const nameRow = ws.getRow(eRightRow);
    nameRow.getCell(EMP_COL).value = item.employee_name;
    nameRow.getCell(EMP_COL).font  = { bold: true };
    eRightRow++;

    // Column headers
    const colHdrRow = ws.getRow(eRightRow);
    ["", "", "", "Gross","Vacation pay","Federal","Provincial","Tax Total","CPP","CPP - employer","EI","EI - employer","Net","Deduction"].forEach((v, i) => {
      if (v) {
        colHdrRow.getCell(EMP_COL + i).value = v;
        colHdrRow.getCell(EMP_COL + i).font  = { bold: true };
      }
    });
    eRightRow++;

    // Data row for this month
    const dataRow = ws.getRow(eRightRow);
    dataRow.getCell(EMP_COL).value     = month;
    dataRow.getCell(EMP_COL + 3).value = fmt2(item.gross_pay);
    dataRow.getCell(EMP_COL + 4).value = fmt2(item.vacation_payout);
    dataRow.getCell(EMP_COL + 5).value = fmt2(item.federal_tax);
    dataRow.getCell(EMP_COL + 6).value = fmt2(item.provincial_tax);
    dataRow.getCell(EMP_COL + 7).value = fmt2(item.tax_total);
    dataRow.getCell(EMP_COL + 8).value = fmt2(item.cpp_deduction + (item.cpp2_deduction || 0));
    dataRow.getCell(EMP_COL + 9).value = fmt2(item.cpp_employer);
    dataRow.getCell(EMP_COL + 10).value = fmt2(item.ei_deduction);
    dataRow.getCell(EMP_COL + 11).value = n(item.ei_employer) || "";
    dataRow.getCell(EMP_COL + 12).value = fmt2(item.net_pay);
    dataRow.getCell(EMP_COL + 13).value = fmt2(n(item.gross_pay) + n(item.vacation_payout) - n(item.net_pay));
    [3,4,5,6,7,8,9,10,12,13].forEach(i => numFmt(dataRow.getCell(EMP_COL + i)));
    eRightRow += 2; // blank row between employees
  }

  // ── Return buffer ─────────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { generatePayrollExcel };
