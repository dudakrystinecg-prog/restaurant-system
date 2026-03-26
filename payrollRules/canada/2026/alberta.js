const COUNTRY = "CA";
const PROVINCE = "AB";
const TAX_YEAR = 2026;
const PAY_FREQUENCIES = {
  weekly: {
    code: "weekly",
    label: "Weekly",
    payPeriodsPerYear: 52,
    cppBasicExemptionPerPeriod: 67.3,
  },
  biweekly: {
    code: "biweekly",
    label: "Biweekly",
    payPeriodsPerYear: 26,
    cppBasicExemptionPerPeriod: 134.61,
  },
  "semi-monthly": {
    code: "semi-monthly",
    label: "Semi-monthly",
    payPeriodsPerYear: 24,
    cppBasicExemptionPerPeriod: 145.83,
  },
  monthly: {
    code: "monthly",
    label: "Monthly",
    payPeriodsPerYear: 12,
    cppBasicExemptionPerPeriod: 291.66,
  },
};

const DEFAULT_PAY_FREQUENCY = "biweekly";

const FEDERAL = {
  rates: [
    { threshold: 0, rate: 0.14, constant: 0 },
    { threshold: 58523, rate: 0.205, constant: 3804 },
    { threshold: 117045, rate: 0.26, constant: 10241 },
    { threshold: 181440, rate: 0.29, constant: 15685 },
    { threshold: 258482, rate: 0.33, constant: 26024 },
  ],
  basicPersonalAmount: {
    max: 16452,
    min: 14829,
    reductionStart: 181440,
    reductionEnd: 258482,
  },
  employmentAmount: 1501,
  lowestRate: 0.14,
};

const ALBERTA = {
  rates: [
    { threshold: 0, rate: 0.08, constant: 0 },
    { threshold: 61200, rate: 0.1, constant: 1224 },
    { threshold: 154259, rate: 0.12, constant: 4309 },
    { threshold: 185111, rate: 0.13, constant: 6160 },
    { threshold: 246813, rate: 0.14, constant: 8628 },
    { threshold: 370220, rate: 0.15, constant: 12331 },
  ],
  basicPersonalAmount: 22769,
  lowestRate: 0.08,
  supplementalCreditThreshold: 4896,
  supplementalCreditReductionRate: 0.25,
};

const DEFAULT_FEDERAL_CLAIM_AMOUNT = FEDERAL.basicPersonalAmount.max;
const DEFAULT_PROVINCIAL_CLAIM_AMOUNT = ALBERTA.basicPersonalAmount;

const CPP = {
  basicExemption: 3500,
  contributionRate: 0.0595,
  baseCreditRate: 0.0495,
  firstAdditionalRate: 0.01,
  ympe: 74600,
  maxContribution: 4230.45,
  maxBaseCreditContribution: 3519.45,
};

const CPP2 = {
  contributionRate: 0.04,
  yamp: 85000,
  maxContribution: 416,
};

const EI = {
  contributionRate: 0.0163,
  maxInsurableEarnings: 68900,
  maxPremium: 1123.07,
};

function roundToCents(value) {
  return Number((value || 0).toFixed(2));
}

function getPayFrequencyConfig(payFrequencyCode) {
  return PAY_FREQUENCIES[payFrequencyCode] || PAY_FREQUENCIES[DEFAULT_PAY_FREQUENCY];
}

function getRateEntry(amount, rateTable) {
  let current = rateTable[0];

  for (const entry of rateTable) {
    if (amount >= entry.threshold) {
      current = entry;
    } else {
      break;
    }
  }

  return current;
}

function getFederalBasicPersonalAmount(annualTaxableIncome) {
  const { max, min, reductionStart, reductionEnd } = FEDERAL.basicPersonalAmount;

  if (annualTaxableIncome <= reductionStart) {
    return max;
  }

  if (annualTaxableIncome >= reductionEnd) {
    return min;
  }

  const reductionRange = reductionEnd - reductionStart;
  const reductionAmount = annualTaxableIncome - reductionStart;
  const phasedAmount = max - (reductionAmount * ((max - min) / reductionRange));

  return roundToCents(phasedAmount);
}

function calculateCpp({
  grossPay,
  payFrequencyConfig,
  ytdCpp = 0,
}) {
  const contributoryEarnings = Math.max(
    0,
    grossPay - payFrequencyConfig.cppBasicExemptionPerPeriod,
  );
  const rawContribution = CPP.contributionRate * contributoryEarnings;
  const remainingAnnualMaximum = Math.max(0, CPP.maxContribution - ytdCpp);
  const contribution = Math.min(remainingAnnualMaximum, rawContribution);

  return roundToCents(Math.max(0, contribution));
}

function calculateCpp2({
  grossPay,
  ytdPensionableEarnings = 0,
  ytdCpp2 = 0,
}) {
  const cappedPensionableToDate = Math.min(
    ytdPensionableEarnings + grossPay,
    CPP2.yamp,
  );
  const secondTierEarnings = Math.max(
    0,
    cappedPensionableToDate - Math.max(ytdPensionableEarnings, CPP.ympe),
  );
  const rawContribution = CPP2.contributionRate * secondTierEarnings;
  const remainingAnnualMaximum = Math.max(0, CPP2.maxContribution - ytdCpp2);
  const contribution = Math.min(remainingAnnualMaximum, rawContribution);

  return roundToCents(Math.max(0, contribution));
}

function calculateEi({
  grossPay,
  ytdInsurableEarnings = 0,
  ytdEi = 0,
}) {
  const remainingInsurableRoom = Math.max(
    0,
    EI.maxInsurableEarnings - ytdInsurableEarnings,
  );
  const currentInsurableEarnings = Math.max(
    0,
    Math.min(grossPay, remainingInsurableRoom),
  );
  const rawPremium = EI.contributionRate * currentInsurableEarnings;
  const remainingAnnualMaximum = Math.max(0, EI.maxPremium - ytdEi);
  const premium = Math.min(remainingAnnualMaximum, rawPremium);

  return {
    deduction: roundToCents(Math.max(0, premium)),
    currentInsurableEarnings: roundToCents(currentInsurableEarnings),
  };
}

function calculateTaxes({
  grossPayTotal,
  payFrequencyConfig,
  cppContribution,
  cpp2Contribution,
  eiDeduction,
  federalClaimAmount,
  provincialClaimAmount,
}) {
  const annualizedGrossIncome =
    grossPayTotal * payFrequencyConfig.payPeriodsPerYear;
  const cppEnhancementDeduction =
    cppContribution * (CPP.firstAdditionalRate / CPP.contributionRate) +
    cpp2Contribution;
  const annualTaxableIncome = Math.max(
    0,
    (grossPayTotal - cppEnhancementDeduction) *
      payFrequencyConfig.payPeriodsPerYear,
  );

  const federalBracket = getRateEntry(annualTaxableIncome, FEDERAL.rates);
  const annualFederalClaimAmount =
    federalClaimAmount === undefined || federalClaimAmount === null
      ? getFederalBasicPersonalAmount(annualTaxableIncome)
      : roundToCents(federalClaimAmount);
  const annualizedBaseCppCredit = Math.min(
    CPP.maxBaseCreditContribution,
    payFrequencyConfig.payPeriodsPerYear *
      cppContribution *
      (CPP.baseCreditRate / CPP.contributionRate),
  );
  const annualizedEiCredit = Math.min(
    EI.maxPremium,
    payFrequencyConfig.payPeriodsPerYear * eiDeduction,
  );
  const federalK1 = FEDERAL.lowestRate * annualFederalClaimAmount;
  const federalK2 =
    FEDERAL.lowestRate * annualizedBaseCppCredit +
    FEDERAL.lowestRate * annualizedEiCredit;
  const federalK4 =
    FEDERAL.lowestRate *
    Math.min(annualizedGrossIncome, FEDERAL.employmentAmount);
  const annualFederalTax = Math.max(
    0,
    federalBracket.rate * annualTaxableIncome -
      federalBracket.constant -
      federalK1 -
      federalK2 -
      federalK4,
  );

  const albertaBracket = getRateEntry(annualTaxableIncome, ALBERTA.rates);
  const annualProvincialClaimAmount =
    provincialClaimAmount === undefined || provincialClaimAmount === null
      ? ALBERTA.basicPersonalAmount
      : roundToCents(provincialClaimAmount);
  const albertaK1 = ALBERTA.lowestRate * annualProvincialClaimAmount;
  const albertaK2 =
    ALBERTA.lowestRate * annualizedBaseCppCredit +
    ALBERTA.lowestRate * annualizedEiCredit;
  const albertaK5 = Math.max(
    0,
    (albertaK1 + albertaK2 - ALBERTA.supplementalCreditThreshold) *
      ALBERTA.supplementalCreditReductionRate,
  );
  const annualProvincialTax = Math.max(
    0,
    albertaBracket.rate * annualTaxableIncome -
      albertaBracket.constant -
      albertaK1 -
      albertaK2 -
      albertaK5,
  );

  return {
    annualTaxableIncome: roundToCents(annualTaxableIncome),
    annualizedGrossIncome: roundToCents(annualizedGrossIncome),
    annualFederalTax: roundToCents(annualFederalTax),
    annualProvincialTax: roundToCents(annualProvincialTax),
    federalTax: roundToCents(
      annualFederalTax / payFrequencyConfig.payPeriodsPerYear,
    ),
    provincialTax: roundToCents(
      annualProvincialTax / payFrequencyConfig.payPeriodsPerYear,
    ),
    credits: {
      federalClaimAmount: annualFederalClaimAmount,
      provincialClaimAmount: annualProvincialClaimAmount,
      annualizedBaseCppCredit: roundToCents(annualizedBaseCppCredit),
      annualizedEiCredit: roundToCents(annualizedEiCredit),
      federalEmploymentAmount: FEDERAL.employmentAmount,
    },
  };
}

function calculateAlbertaPayrollDeductions2026({
  grossPayTotal,
  payFrequency = DEFAULT_PAY_FREQUENCY,
  ytd = {},
  federalClaimAmount,
  provincialClaimAmount,
}) {
  const payFrequencyConfig = getPayFrequencyConfig(payFrequency);
  const normalizedGrossPay = roundToCents(grossPayTotal);
  const normalizedYtd = {
    cpp: roundToCents(ytd.cpp || 0),
    cpp2: roundToCents(ytd.cpp2 || 0),
    ei: roundToCents(ytd.ei || 0),
    pensionableEarnings: roundToCents(ytd.pensionableEarnings || 0),
    insurableEarnings: roundToCents(ytd.insurableEarnings || 0),
  };

  const cppContribution = calculateCpp({
    grossPay: normalizedGrossPay,
    payFrequencyConfig,
    ytdCpp: normalizedYtd.cpp,
  });
  const cpp2Contribution = calculateCpp2({
    grossPay: normalizedGrossPay,
    ytdPensionableEarnings: normalizedYtd.pensionableEarnings,
    ytdCpp2: normalizedYtd.cpp2,
  });
  const eiResult = calculateEi({
    grossPay: normalizedGrossPay,
    ytdInsurableEarnings: normalizedYtd.insurableEarnings,
    ytdEi: normalizedYtd.ei,
  });
  const taxes = calculateTaxes({
    grossPayTotal: normalizedGrossPay,
    payFrequencyConfig,
    cppContribution,
    cpp2Contribution,
    eiDeduction: eiResult.deduction,
    federalClaimAmount,
    provincialClaimAmount,
  });
  const totalDeductions = roundToCents(
    cppContribution +
      cpp2Contribution +
      eiResult.deduction +
      taxes.federalTax +
      taxes.provincialTax,
  );
  const netPay = roundToCents(normalizedGrossPay - totalDeductions);

  return {
    country: COUNTRY,
    province: PROVINCE,
    tax_year: TAX_YEAR,
    pay_frequency: payFrequencyConfig.code,
    pay_periods_per_year: payFrequencyConfig.payPeriodsPerYear,
    pensionable_earnings: normalizedGrossPay,
    insurable_earnings: eiResult.currentInsurableEarnings,
    cpp_deduction: cppContribution,
    cpp2_deduction: cpp2Contribution,
    ei_deduction: eiResult.deduction,
    federal_tax: taxes.federalTax,
    provincial_tax: taxes.provincialTax,
    total_deductions: totalDeductions,
    net_pay: netPay,
    ytd_cpp: roundToCents(normalizedYtd.cpp + cppContribution),
    ytd_cpp2: roundToCents(normalizedYtd.cpp2 + cpp2Contribution),
    ytd_ei: roundToCents(normalizedYtd.ei + eiResult.deduction),
    federal_claim_amount: roundToCents(taxes.credits.federalClaimAmount),
    provincial_claim_amount: roundToCents(taxes.credits.provincialClaimAmount),
    ytd_federal_tax: roundToCents(
      (ytd.federalTax || 0) + taxes.federalTax,
    ),
    ytd_provincial_tax: roundToCents(
      (ytd.provincialTax || 0) + taxes.provincialTax,
    ),
    audit: {
      annualTaxableIncome: taxes.annualTaxableIncome,
      annualizedGrossIncome: taxes.annualizedGrossIncome,
      ytdBefore: normalizedYtd,
      ytdAfter: {
        cpp: roundToCents(normalizedYtd.cpp + cppContribution),
        cpp2: roundToCents(normalizedYtd.cpp2 + cpp2Contribution),
        ei: roundToCents(normalizedYtd.ei + eiResult.deduction),
        federalTax: roundToCents((ytd.federalTax || 0) + taxes.federalTax),
        provincialTax: roundToCents(
          (ytd.provincialTax || 0) + taxes.provincialTax,
        ),
        pensionableEarnings: roundToCents(
          normalizedYtd.pensionableEarnings + normalizedGrossPay,
        ),
        insurableEarnings: roundToCents(
          normalizedYtd.insurableEarnings + eiResult.currentInsurableEarnings,
        ),
      },
      credits: taxes.credits,
      assumption:
        "TD1 basic claim amounts only, Alberta 2026, no RRSP/benefits/non-periodic adjustments, and YTD based on approved prior payroll periods only.",
    },
  };
}

module.exports = {
  COUNTRY,
  PROVINCE,
  TAX_YEAR,
  DEFAULT_FEDERAL_CLAIM_AMOUNT,
  DEFAULT_PROVINCIAL_CLAIM_AMOUNT,
  PAY_FREQUENCIES,
  DEFAULT_PAY_FREQUENCY,
  FEDERAL,
  ALBERTA,
  CPP,
  CPP2,
  EI,
  getPayFrequencyConfig,
  calculateAlbertaPayrollDeductions2026,
};
