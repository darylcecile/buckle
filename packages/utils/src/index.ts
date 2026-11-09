/**
 * Converts finite, nonnegative durations to milliseconds without rounding fractions.
 * Results must also be finite. Days are fixed 24-hour durations, not calendar dates.
 * These helpers do not schedule work or impose timer limits.
 */
export namespace Intervals {
	/** Returns milliseconds unchanged, including fractional milliseconds. */
	export function milliseconds(value: number): number { return toMilliseconds(value, 1); }

	/** Converts seconds to milliseconds. */
	export function seconds(value: number): number { return toMilliseconds(value, 1_000); }

	/** Converts minutes to milliseconds. */
	export function minutes(value: number): number { return toMilliseconds(value, 60_000); }

	/** Converts hours to milliseconds. */
	export function hours(value: number): number { return toMilliseconds(value, 3_600_000); }

	/** Converts fixed 24-hour days to milliseconds. */
	export function days(value: number): number { return toMilliseconds(value, 86_400_000); }
}

function toMilliseconds(value: number, scale: number): number {
	const milliseconds = value * scale;
	if (!Number.isFinite(value) || value < 0 || !Number.isFinite(milliseconds)) {
		throw new RangeError("Interval must be finite and nonnegative in both source units and milliseconds");
	}
	return milliseconds;
}