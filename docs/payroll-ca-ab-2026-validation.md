# Payroll Canada AB 2026 Validation Notes

## Scope

This project now calculates a first auditable version of Canadian payroll deductions for:

- country: `CA`
- province: `AB`
- tax_year: `2026`

The current implementation is intentionally narrow:

- Alberta only
- 2026 only
- employee-side deductions only
- gross to net only
- no CRA web calls at runtime
- no PDOC scraping

## Payroll assumptions

- Jurisdiction fixed in this phase: `CA / AB / 2026`
- Pay frequency configurable per payroll period:
  - `weekly`
  - `biweekly`
  - `semi-monthly`
  - `monthly`
- Default pay frequency: `biweekly`
- Default claim amounts only
- No extra TD1 amounts
- No RRSP deductions at source
- No union dues
- No taxable benefits beyond the gross already stored in the payroll item
- YTD carry-forward comes only from approved prior payroll periods
- Hourly rate priority:
  - manual rate informed on payroll generation
  - otherwise employee `default_hourly_rate`
  - otherwise fallback `17`

## Employee PIN migration

- Existing plaintext employee PINs are migrated locally to `pin_hash` during database initialization.
- The migration hashes any employee row where:
  - `pin_hash IS NULL`
  - `pin IS NOT NULL`
- After migration, the system clears the legacy plaintext value to an empty string and uses only `pin_hash` for validation.
- API responses must never expose plaintext PIN values.
- Legacy `pin` remains in the schema only for compatibility with the historical SQLite table shape, but it is no longer a valid authentication source.

## YTD method

YTD is calculated per employee using only **approved prior payroll periods** in the same:

- `tax_year`
- `country`
- `province`

For the current payroll generation, the system sums prior approved payroll items before the current `start_date`:

- `cpp_deduction`
- `cpp2_deduction`
- `ei_deduction`
- `pensionable_earnings`
- `insurable_earnings`

These YTD values are used to:

- reduce CPP when the employee is close to the annual maximum
- start CPP2 only after pensionable earnings cross YMPE
- stop EI once insurable earnings or the annual premium maximum is reached

Draft payrolls are intentionally excluded from YTD so that regenerating or editing a draft does not double count prior deductions.

## CRA sources used

- CRA T4127 Payroll Deductions Formulas, 122nd edition, effective January 1, 2026
- CRA T4008 Alberta supplementary payroll tables for 2026
- CRA PDOC for manual spot-checking only
- CRA CPP2 contribution rates and maximums page

## What is calculated

For each payroll item:

- `cpp_deduction`
- `cpp2_deduction`
- `ei_deduction`
- `federal_tax`
- `provincial_tax`
- `federal_claim_amount`
- `provincial_claim_amount`
- `total_deductions`
- `net_pay`
- `ytd_cpp`
- `ytd_cpp2`
- `ytd_ei`
- `ytd_federal_tax`
- `ytd_provincial_tax`

## Manual PDOC comparison

Use PDOC manually, not by scraping:

1. Open the CRA Payroll Deductions Online Calculator.
2. Choose year `2026`.
3. Choose province `Alberta`.
4. Use pay frequency `biweekly`.
5. Enter the payroll item's gross pay as salary/wages for the pay period.
6. Use default TD1 claim amounts only.
   Or enter the same custom federal/provincial claim amounts configured for the employee in admin.
7. Do not enter extra deductions, RRSP, benefits, or special credits unless the system supports them.
8. Compare:
   - CPP
   - CPP2
   - EI
   - federal tax
   - Alberta tax
   - net pay

## Suggested validation scenarios

### Scenario 1

- Gross pay: `600.00`
- Province: `AB`
- Frequency: `biweekly`
- Expected use: sanity check for low gross pay

### Scenario 2

- Gross pay: `1300.00`
- Province: `AB`
- Frequency: `biweekly`
- Expected use: common restaurant payroll case

### Scenario 3

- Gross pay: `2200.00`
- Province: `AB`
- Frequency: `biweekly`
- Expected use: verify tax progression and CPP/EI growth

### Scenario 4

- Gross pay: above `YMPE / 26`
- Province: `AB`
- Frequency: `biweekly`
- Expected use: verify CPP2 starts appearing

### Scenario 5

- Create a prior approved payroll for the same employee with YTD CPP close to the annual maximum
- Generate the next payroll in the same tax year
- Expected use: verify CPP is reduced to the remaining annual room

### Scenario 6

- Create enough prior approved payrolls so the employee reaches CPP, CPP2, or EI maximums
- Generate one more payroll in the same tax year
- Expected use: verify the respective deduction becomes `0.00`

### Scenario 7

- Leave employee claim amounts empty
- Generate payroll and compare with PDOC using default TD1 claim amounts
- Expected use: validate default claim behaviour

### Scenario 8

- Set a custom `federal_claim_amount` and `provincial_claim_amount` for the employee in admin
- Generate payroll and compare with PDOC using the same TD1 basic claim values
- Expected use: validate lower or higher withholding caused by custom claims

### Scenario 9

- Approve one payroll with custom claims
- Generate a second payroll for the same employee in the same tax year
- Expected use: validate `ytd_federal_tax` and `ytd_provincial_tax` tracking in sequence

### Scenario 10

- Create a new active employee in admin
- Confirm the employee appears in the kiosk list
- Inactivate the employee
- Confirm the employee disappears from the kiosk list

### Scenario 11

- Set `default_hourly_rate` on the employee
- Generate payroll without informing `hourly_rate`
- Expected use: validate automatic rate inheritance from employee settings

### Scenario 12

- Keep `default_hourly_rate` on the employee
- Generate payroll with a manual `hourly_rate`
- Expected use: validate manual override has priority over employee default

## Known reasons for divergence from a full Canadian payroll

- YTD only considers approved prior payrolls, not draft periods
- No extra TD1 claim amounts
- No non-periodic payment treatment
- No RRSP deductions at source
- No taxable benefits modelling
- No vacation/stat holiday statutory formulas beyond explicit gross and holiday pay already stored
- No advanced TD1 options beyond the basic claim amounts
- No federal or provincial special credits outside the default basic amounts
