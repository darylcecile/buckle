import assert from "node:assert/strict";
import test from "node:test";
import { Intervals } from "../dist/index.js";

test("intervals convert each unit to milliseconds without rounding fractions", () => {
	assert.equal(Intervals.milliseconds(0.5), 0.5);
	assert.equal(Intervals.seconds(1.5), 1_500);
	assert.equal(Intervals.minutes(5), 300_000);
	assert.equal(Intervals.minutes(0.5), 30_000);
	assert.equal(Intervals.hours(1.5), 5_400_000);
	assert.equal(Intervals.days(0.5), 43_200_000);
	for (const convert of Object.values(Intervals)) assert.equal(convert(0), 0);
});

test("intervals reject negative and nonfinite durations or overflowing conversions", () => {
	for (const convert of Object.values(Intervals)) {
		for (const value of [-1, NaN, Infinity, -Infinity]) assert.throws(() => convert(value), RangeError);
	}
	assert.throws(() => Intervals.days(Number.MAX_VALUE), RangeError);
});