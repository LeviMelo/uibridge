export function scoreBiomedical(targets, predictions) {
  const labels = ['yes', 'no', 'maybe']
  const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries([...labels, 'missing'].map((p) => [p, 0]))]))
  let correct = 0, grounded = 0
  const mismatches = []
  for (const row of targets) {
    const actual = predictions[row.key]
    const predicted = labels.includes(actual?.label) ? actual.label : 'missing'
    confusion[row.label][predicted]++
    if (predicted === row.label) correct++
    const validQuote = typeof actual?.quote === 'string' && actual.quote.length >= 12 && row.contexts.some((c) => c.includes(actual.quote))
    if (validQuote) grounded++
    if (predicted !== row.label || !validQuote) mismatches.push({ id: row.id, key: row.key, expected: row.label, predicted, exact_quote: validQuote })
  }
  const perClass = Object.fromEntries(labels.map((label) => {
    const tp = confusion[label][label]
    const support = Object.values(confusion[label]).reduce((a, b) => a + b, 0)
    const predicted = labels.reduce((n, actual) => n + confusion[actual][label], 0)
    return [label, { support, precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0,
      f1: support + predicted ? 2 * tp / (support + predicted) : 0 }]
  }))
  return { total: targets.length, correct, accuracy: correct / targets.length, grounded,
    macro_f1: labels.reduce((n, label) => n + perClass[label].f1, 0) / labels.length,
    confusion, per_class: perClass, mismatches, predictions }
}
