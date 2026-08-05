interface ParsedDecimal {
  coefficient: bigint
  scale: number
}

function parseDecimal(value: string): ParsedDecimal {
  const normalized = value.trim()
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (!match) throw new Error(`Invalid decimal value: ${value}`)
  const fraction = match[3] ?? ''
  const sign = match[1] === '-' ? -1n : 1n
  return {
    coefficient: sign * BigInt(`${match[2]}${fraction}`),
    scale: fraction.length,
  }
}

function powerOfTen(power: number): bigint {
  return 10n ** BigInt(power)
}

export function sumDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) return '0'
  const parsed = values.map(parseDecimal)
  const scale = Math.max(...parsed.map((item) => item.scale))
  const total = parsed.reduce(
    (sum, item) => sum + item.coefficient * powerOfTen(scale - item.scale),
    0n,
  )
  const negative = total < 0n
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0')
  if (scale === 0) return `${negative ? '-' : ''}${digits}`
  const whole = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function normalizeDecimalString(value: string): string {
  return sumDecimalStrings([value])
}

export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const parsed = [parseDecimal(left), parseDecimal(right)]
  const scale = Math.max(parsed[0].scale, parsed[1].scale)
  const [a, b] = parsed.map((item) => item.coefficient * powerOfTen(scale - item.scale))
  return a < b ? -1 : a > b ? 1 : 0
}

export function isPositiveDecimal(value: string): boolean {
  return compareDecimalStrings(value, '0') > 0
}

export function absoluteDecimalString(value: string): string {
  const normalized = normalizeDecimalString(value)
  return normalized.startsWith('-') ? normalized.slice(1) : normalized
}

export function subtractDecimalStrings(left: string, right: string): string {
  const normalizedRight = normalizeDecimalString(right)
  const negatedRight = normalizedRight.startsWith('-') ? normalizedRight.slice(1) : `-${normalizedRight}`
  return sumDecimalStrings([left, negatedRight])
}

/** Exact ratio for progress bars. The returned value is intentionally clamped to 0..100. */
export function decimalPercentage(numerator: string, denominator: string): number {
  const [rawNumerator, rawDenominator] = [parseDecimal(numerator), parseDecimal(denominator)]
  if (rawDenominator.coefficient <= 0n || rawNumerator.coefficient <= 0n) return 0
  const scale = Math.max(rawNumerator.scale, rawDenominator.scale)
  const a = rawNumerator.coefficient * powerOfTen(scale - rawNumerator.scale)
  const b = rawDenominator.coefficient * powerOfTen(scale - rawDenominator.scale)
  if (a >= b) return 100
  return Number((a * 10_000n) / b) / 100
}
