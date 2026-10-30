// The local browser harness and workerd share the host's wall clock.
export function alignSample(sample, reference, rate) {
  const expected = reference.position + (sample.at - reference.at) / 1000 * rate;
  return { ...sample, reference, expected, drift: sample.position - expected };
}
