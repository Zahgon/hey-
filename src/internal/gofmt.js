// Port of the `fmt` verbs that hey actually uses: %f (with width+precision),
// %d and %v. JavaScript's Number#toFixed is NOT a substitute:
//
//   G-FMT-1  Rounding mode. Go's strconv.FormatFloat rounds exact decimal ties
//            to even; toFixed rounds ties away from zero.
//              (0.0625).toFixed(3) === "0.063"   Go %4.3f => "0.062"
//   G-FMT-2  Large magnitudes. toFixed falls back to exponent notation at 1e21;
//            Go always emits positional digits.
//              (1e21).toFixed(4)   === "1e+21"   Go %4.4f => "1000000000000000000000.0000"
//   G-FMT-3  Non-finite values. Go renders "NaN", "+Inf", "-Inf" and still
//            applies the *width*, so `%4.4f` of NaN is " NaN" (leading space),
//            never "NaN". Precision is ignored for these.
//
// Everything below is derived from probes executed against go1.26.7.

/**
 * Exact decimal rendering of an IEEE-754 double, rounded to `prec` fractional
 * digits using round-half-to-even — i.e. strconv.FormatFloat(f, 'f', prec, 64).
 *
 * The double is decomposed into an exact `mantissa * 2**exponent` pair and the
 * scaling is done in BigInt, so there is no intermediate precision loss and no
 * 1e21 cliff.
 */
function formatFloatExact(value, prec) {
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);

  // Exact decomposition: abs === mantissa * 2**exponent, mantissa a BigInt.
  const { mantissa, exponent } = decompose(abs);

  const scale = 10n ** BigInt(prec);
  let scaled; // round(abs * 10**prec) as a BigInt, half-to-even

  if (exponent >= 0) {
    // Exactly representable as an integer; no rounding decision to make.
    scaled = mantissa * (1n << BigInt(exponent)) * scale;
  } else {
    const denominator = 1n << BigInt(-exponent);
    const numerator = mantissa * scale;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const twice = remainder * 2n;
    if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) {
      scaled = quotient + 1n;
    } else {
      scaled = quotient;
    }
  }

  let digits = scaled.toString();
  if (prec > 0) {
    if (digits.length <= prec) digits = digits.padStart(prec + 1, '0');
    digits = `${digits.slice(0, digits.length - prec)}.${digits.slice(digits.length - prec)}`;
  }
  return negative ? `-${digits}` : digits;
}

/** Exact `mantissa * 2**exponent` decomposition of a finite non-negative double. */
function decompose(abs) {
  if (abs === 0) return { mantissa: 0n, exponent: 0 };

  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, abs);
  const hi = buffer.getUint32(0);
  const lo = buffer.getUint32(4);
  const biasedExponent = (hi >>> 20) & 0x7ff;
  const rawMantissa = ((BigInt(hi & 0xfffff) << 32n) | BigInt(lo));

  if (biasedExponent === 0) {
    // Subnormal: no implicit leading 1, exponent is fixed at the minimum.
    return { mantissa: rawMantissa, exponent: -1074 };
  }
  return {
    mantissa: rawMantissa | (1n << 52n),
    exponent: biasedExponent - 1075,
  };
}

/**
 * fmt.Sprintf("%<width>.<prec>f", value).
 *
 * `width` is a *minimum* — Go left-pads with spaces and never truncates.
 * Non-finite values bypass precision entirely (G-FMT-3).
 */
export function formatF(value, width, prec) {
  let text;
  if (Number.isNaN(value)) {
    text = 'NaN';
  } else if (value === Infinity) {
    text = '+Inf';
  } else if (value === -Infinity) {
    text = '-Inf';
  } else {
    text = formatFloatExact(value, prec);
  }
  return text.length >= width ? text : text.padStart(width, ' ');
}

/** fmt.Sprintf("%4.4f", v) — the `formatNumber` template helper. */
export function formatNumber(value) {
  return formatF(toFloat(value), 4, 4);
}

/** fmt.Sprintf("%4.3f", v) — used by the histogram bar renderer. */
export function formatNumber3(value) {
  return formatF(toFloat(value), 4, 3);
}

/** fmt.Sprintf("%d", v) — the `formatNumberInt` template helper. */
export function formatNumberInt(value) {
  if (typeof value === 'bigint') return value.toString();
  const n = Number(value);
  // Go's %d on an int is always integral; a non-integral input here would mean
  // the caller handed us the wrong type, which is a porting bug, not a value.
  if (!Number.isInteger(n)) {
    throw new TypeError(`formatNumberInt: expected an integer, got ${value}`);
  }
  return String(n);
}

/** Coerce a template argument to a float64 the way Go's type system would. */
function toFloat(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new TypeError(`expected a number, got ${typeof value}`);
}
